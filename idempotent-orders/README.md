# Idempotent orders

Postgres functions and a TypeScript client for placing an order that survives a weak connection and a double tap. Each user action carries a key made in the browser. The database stores one order per key, and the client's result says whether the order went in, was already in, was refused, or is unknown.

`place_order` answers a resend with the order it already has. A resend that changed the cart is refused, so the user is never told "sent" about lines that were not saved. `confirm_order` claims a pending order and takes its stock once, however many confirms race. The client retries only the answers that may hide a commit, and reads the order back by key before it gives up.

I extracted it from a production ordering app where customers on a weak mobile signal tapped Send again after a lost response, and orders were confirmed from two devices.

## Run it

From the repository root:

```sh
npm ci
npx vitest run idempotent-orders   # offline: the real SQL in PGlite, no database server
npm run check                      # tsc --noEmit (strict)
```

The tests apply `sql/schema.sql` to [PGlite](https://pglite.dev), a WASM build of Postgres that runs in process, so they exercise the plpgsql functions, the constraints and the privileges as written.

One opt-in check, not part of the suite, runs the races with real overlapping sessions:

```sh
# Needs psql and an EMPTY scratch database; it refuses any other.
DATABASE_URL=postgres://... bash idempotent-orders/sql/race.sh
```

It passed its 12 checks on PostgreSQL 16.15.

## How it is used

The browser keeps one key per action and sends it with every attempt:

```ts
import { ActionKey } from './idempotent-orders/src/index.ts';

const checkout = new ActionKey({ slot: 'checkout-key', storage: localStorage });
const response = await fetch('/api/order', {
  method: 'POST',
  body: JSON.stringify({ key: checkout.current(), lines }),
});
// Clear the key on success, or when the user chooses "Send as a new order".
```

The server authenticates the customer and calls the database through the client:

```ts
import { createOrdersClient } from './idempotent-orders/src/index.ts';

const orders = createOrdersClient({ url: `${supabaseUrl}/rest/v1`, headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}` } });
const result = await orders.placeOrder({ key: body.key, customerId: session.customerId, lines: body.lines });
```

| `result.kind` | Meaning | What the page says |
|---|---|---|
| `placed` | This call created the order. | Sent, with the order number. Send the new-order notice. |
| `already_placed` | The key's order was already stored: a double tap, a reload, or a lost response. `afterLostResponse` says whether an earlier attempt of this call may have created it. | Sent, with the same number. |
| `rejected` | Nothing was written by this call. `reason` says why: `key_reused`, `key_expired` (with `why`: `age` or `not_pending`), `key_taken`, `unavailable`, `refused`, `not_deployed` or `invalid_request`. | The reason. For `key_reused` and `key_expired`, show the stored order and offer "Send as a new order", which calls `checkout.clear()` and sends again with a fresh key. |
| `unknown` | The call could not find out. The key stays valid. | "We do not know if your order arrived. Tap Send again within the hour: if it did, it will not be duplicated." |

A response the browser cannot read (a network error, a proxy's 504 with an HTML body) is the same case as `unknown`: the page keeps the key and says so.

## The failure modes

### Double tap

Two sends of one action arrive together, from a double click, a second tab or a reload while the first request is still running.

- In one process, the client joins calls with the same key and payload into one request. Both callers get the same object back. Only calls made without an `AbortSignal` are joined: a joined call would otherwise end when the other caller aborts. A call with a signal sends its own requests, and the key still keeps one order in the database.
- Across processes, `place_order` looks the key up first and returns the stored order as `already_placed`.
- When two transactions both miss in that lookup, the second one's insert waits on the unique index until the first commits, then fails with `unique_violation`. The function catches it, reads the order the other transaction committed, and answers with it. It catches only a violation of `orders_idempotency_key_unique`; any other unique violation is raised, because answering "already placed" with no order behind it would be false. `sql/race.sh` produces this race with two real sessions and checks that the second one waited and got `already_placed`. With the handler removed, the same run ends in a raw `23505`.

The same pattern covers the confirm. A confirm that checks the status and then writes it in two steps lets two requests from a double click both pass the check, and the stock is taken twice. `confirm_order` locks the order row first. A second confirm waits on that lock, reads the row as confirmed once the first commits, and leaves without touching stock.

### Lost response

The transaction commits and the response never arrives: the connection drops, a proxy times out, the body is cut. The client cannot tell this from a request that never ran, so it does not guess.

- The answers that may hide a commit are retried with the same key. Those are a network error, a timeout, 408, 429 and any 5xx. A 2xx whose body is not valid JSON, or does not match the expected shape, counts too. A resend of a committed order comes back as `already_placed` with `afterLostResponse: true`.
- An error status from PostgREST is not retried. PostgREST runs each RPC in one transaction and rolls it back when the function raises, so a 4xx means nothing was written. The exception is a 4xx after an ambiguous attempt. It says nothing about that earlier attempt, so the client goes to the re-read.
- When the attempts run out, the client calls `find_order` once. It applies the rules of a resend, with the window judged by the server (`within_window`). A stored order inside the window with the same fingerprint is reported as `already_placed` (`via: 'reread'`); one outside it is `key_expired`. If nothing is stored, the result is `unknown`, not "not placed": an attempt can still be waiting on a lock and commit after the re-read.
- If an order under the key was confirmed before the resend arrived, `place_order` answers `key_expired` with `why: 'not_pending'`. The client reports it as `already_placed` only when the order is inside the window, the fingerprints match and this call had an ambiguous attempt, because then a lost attempt of this action may have placed it. `why: 'age'` stays `key_expired` whatever happened to the earlier attempts, so an old key sent again hours later never swallows a new order. Tests check both paths with a 61-minute-old order behind a 503.

`confirmOrder` follows the same protocol with the confirm key. Its re-read is `get_order`. A confirmed order whose `confirm_key` is this call's key went in. One confirmed with another key was confirmed elsewhere, and a pending one is `unknown`.

### Retry storm

An outage turns every client into a loop of resends, and the retries can keep the database down.

- At most `maxAttempts` writes (default 3) and one re-read per call. The test with every request failing counts exactly that.
- Exponential backoff with full jitter, capped at `maxDelayMs`, so clients that failed together do not retry together.
- `Retry-After` is honored. When the server asks for a longer pause than `maxDelayMs`, the client stops retrying and goes to the re-read instead of waiting or ignoring it.
- Definite refusals are never retried, and a request that fails the client's own validation (the same rules as `validate_lines`) is never sent.
- After `unknown` the next attempt is the user's tap, with the same key. However many times they tap within the window, the database holds one order.
- With the defaults a call can take up to about 33 s, made of three 8 s attempts, up to 900 ms of backoff and an 8 s re-read. Set `timeoutMs` and `maxAttempts` so that fits inside the server's request limit. If the platform kills the handler first, the browser gets the `unknown` case.

## Why the key is generated on the client

The key names one user action. Only the browser knows that two requests are the same action, for example a tap after a timeout or a resend after a reload. A key minted by the server arrives in the response, and the lost response is the case the key exists for. The browser would then have nothing to resend with, and its next tap would be a new order. So the browser makes the key with `crypto.randomUUID()` (16 random bytes in hex where that is missing) before the first send. `ActionKey` keeps it in memory and mirrors it to `localStorage` for 24 hours, the lifetime the source app used. Memory wins, so a retry from the same page keeps its key when storage is blocked. Storage is what survives a reload. The key is cleared on success, and when the user chooses "Send as a new order". A failure or an `unknown` keeps it.

The browser keeps the key longer (24 hours) than the database accepts it as a resend (60 minutes). A tap hours later still carries the old key, so the server can show the earlier order instead of silently making a second one. The page then offers a new order.

The server still decides who the customer is from the session, never from the body. A key found under another customer is answered `key_taken`, without that order's contents.

## Design decisions

**The fingerprint is product x quantity, from the request that placed the order.** `place_order` stores `order_fingerprint(lines)`, for example `3x2,10x1` sorted by product id, and compares a resend with it. Comparing with the current lines instead would turn a resend into `key_reused` after the owner edited the order in between. `src/lines.ts` computes the same string, and a property test checks the two agree on 200 random line lists, so the client's re-read can tell the same order from a changed one without another call.

**A changed order under the same key is refused, not merged or replaced.** The user changed the cart after a send whose response was lost. Answering "sent" would hide that the change was not saved; replacing the order would edit something the owner may already be preparing. `key_reused` returns the stored order so the page can say what went in.

**A resend window of 60 minutes.** A resend after a lost response comes within minutes. A key older than that, or one whose order is no longer pending, is answered `key_expired` with the old order and a `why` (`age` or `not_pending`), because the same cart sent later is more likely a new order. This rule and its window come from the source app.

**The key lookup comes before the product checks.** Prices and availability are read after the lookup. Otherwise a resend of an order that did go in would be told "product not available" when a product was hidden in between.

**Prices come from the database.** A line carries a product id and a quantity, never a price, so a tampered request cannot set what it pays. `place_order` reads the price under a share lock, so a price or an `active` flag cannot change under the transaction.

**Locks in id order.** `confirm_order` locks the order row, then the stock rows of its lines ordered by product id. Two confirms over overlapping products take their locks in the same order and cannot wait on each other in a circle. The product share locks in `place_order` and `edit_order` follow the same order.

**Stock is checked before it is written.** `confirm_order` reads every line's stock under the lock and refuses with `insufficient_stock` and the shortages before any write. A `check (on_hand >= 0)` on `stock` is a backstop, so a bug that writes below zero fails. Letting stock go negative, so that an oversold product shows how far it was oversold, is a valid alternative; this version refuses instead.

**Optimistic versions on edits.** `edit_order` and `confirm_order` take the version the person was shown and refuse a stale one with `version_conflict` and the current version. Without it, a confirm from a screen opened before an edit would take stock for lines nobody looked at. `race.sh` runs an edit and a confirm together and checks that the confirm waits for the edit and then refuses version 1.

**Shape errors raise 22023 before anything is written.** Keys, customers and line lists are validated first, without coercion. A quantity of `"2"` or `2.5` is an error. Every failure inside a function rolls back its transaction, so an order is never left without lines.

**Only the server can call the functions.** Supabase grants `anon` and `authenticated` every privilege on new tables and `EXECUTE` on new functions. RLS without policies stops the table access, and the schema also revokes both grants, role by role, as a backstop, so a database with only one of the roles is still covered. The test database is set up with the same default grants, so the tests check the revokes against the grants they undo.

**A malformed 2xx is never success.** Every response is validated with zod before the client reports it. A body of the wrong shape is treated like a lost response.

**A missing function is reported, not worked around.** PostgREST answers a function that is not in its schema cache with 404 `PGRST202`. The client reports `not_deployed`. Falling back to an older, unkeyed insert would keep orders coming in while a migration has not run, but that fallback can duplicate orders, so this library leaves it to the caller.

## What the tests cover

92 tests, all offline.

| File | Covers |
|---|---|
| `test/place-order.test.ts` | Prices from the database; a resend; ten same-key calls sent together; a changed cart; another customer's key; the 60-minute window and `find_order`'s `within_window`; a confirmed order's key; a resend after an edit; unavailable products before and after the lookup; 22023 for every shape error; the lookup-to-insert race through the `unique_violation` handler; a violation of another constraint raised; no order without lines |
| `test/confirm-order.test.ts` | The claim and the stock; two interleaved confirms; a resend of the winning confirm; version conflicts; shortages with nothing written; a property test over random mixes of orders, each confirmed twice at once, checking stock never goes negative and equals the starting stock minus the confirmed lines; the check constraint; `edit_order` versions, races and refusals |
| `test/privileges.test.ts` | Every function, table privilege and sequence taken back from `anon` and `authenticated` against Supabase-like default grants; `service_role` can place and confirm; RLS on every table; the schema applies again over itself |
| `test/client.test.ts` | The client against a fake PostgREST that runs the real SQL and can drop a request before it runs, drop the response after the commit, answer 504 after the commit, cut the body, return the wrong shape, hang, or answer any status with `Retry-After`. Covers the lost response, the re-read, the 60-minute rule after a lost attempt and in the re-read, `unknown`, refusals, a refusal after a lost response, `not_deployed`, double taps in one and two processes, a joined tap not ended by another caller's abort, the retry bounds and backoff sequence, timeouts, aborts, and the same cases for confirms |
| `test/lines.test.ts` | The TypeScript fingerprint equals `order_fingerprint`, and the client's line validation accepts exactly what `validate_lines` accepts (property tests against PGlite) |
| `test/key.test.ts` | Keys across a reload, `clear()`, the lifetime, blocked storage, stored values the class did not write (jsdom) |

PGlite has one backend, so two calls never overlap there: "concurrent" calls are interleaved whole. The race between the lookup and the insert is reproduced by `injectTwinAfterLookup` in `test/helpers/db.ts`. It turns `products` into a view whose filter inserts a twin order the first time `place_order` reads it, which falls between the lookup and the insert. A mutation check confirmed that removing the handler fails those tests. Real lock waits are what `sql/race.sh` is for. Its timing changed after its last run against a real Postgres, so a rerun of `race.sh` is pending.

## Layout

```
sql/
  schema.sql       tables, constraints, the functions, privileges
  race.sh          the races on a real Postgres, opt-in
src/
  client.ts        the retry protocol: placeOrder, confirmOrder
  wire.ts          one RPC call, classified as body, refused, ambiguous or aborted
  responses.ts     zod schemas of what the functions return
  key.ts           newKey and ActionKey, browser-safe
  lines.ts         line validation and the fingerprint
  index.ts         public exports
test/
  helpers/db.ts             PGlite with Supabase-like roles, the race injection
  helpers/fake-postgrest.ts fetch over PGlite, with faults
```

## Limits

- The client treats every network error as ambiguous. A connection that was never opened cannot have written, but telling it apart needs the error shapes of each runtime, as the gateway folder does; here it costs at most a retry.
- `already_placed` with `afterLostResponse: true` means an earlier attempt of this call may have created the order, not that it did. Suppose another process placed it with the same key and cart, and this call's attempt failed without writing. A new-order notice sent on that flag then goes out twice. Telling the two apart needs a per-attempt mark stored by the function. This version accepts a rare double notice over a missed one.
- Only the lines are compared on a resend. Delivery details or notes sent with the order are not, so a change to them under the same key is not reported.
- There is no cancel, and so nothing that returns stock.
- The 60-minute window (`in_resend_window`) and the 5-second `lock_timeout` are constants in the SQL.
- Deadlock freedom comes from the lock order by construction. No test forces two transactions to take the locks in opposite orders.
- A failed insert uses up an identity value, so order ids have gaps. `race.sh` hit this.
- PostgREST's HTTP mapping is reproduced in the fake only for the SQLSTATEs these functions raise.
