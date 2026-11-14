# Claude API gateway

A TypeScript gateway that is the only code in an application allowed to call the Claude API. Its job is to keep spending caps true in the cases that usually break them. Those are a ledger insert that fails, a stream cut halfway, a fallback model with no price, concurrent calls near a cap and a network outage retried in a loop. Each call reserves its worst-case cost before it goes out and closes that reservation with the cost measured per attempt. Structured output is sent as a JSON schema built from zod and validated with the same schema on return. Every failure maps to a stable error code that says whether the request was billed and whether a retry makes sense. I extracted it from a production app I am building; the stores became interfaces, with an in-memory implementation and a reference Postgres schema.

## Install

```sh
npm install @fedemedinilla/claude-gateway zod
```

```ts
import { createClaudeClient, createGateway, createMemoryStores } from '@fedemedinilla/claude-gateway';
```

The package entry is built from `src/index.ts`. Inside this repository nothing changes. Node runs the `.ts` files directly, and apps import `gateway/src/index.ts` as before.

- **The package ships JavaScript.** Node does not strip types for files inside `node_modules`, so `npm pack` compiles `src/` to `dist/` with [`tsconfig.build.json`](tsconfig.build.json), with declarations and source maps. The `.ts` sources are not shipped, so each source map carries their text (`inlineSources`), and there are no declaration maps, which could only point at those missing files. Its `rewriteRelativeImportExtensions` turns each `./x.ts` import into `./x.js`. The `.d.ts` files keep the `.ts` specifiers, which TypeScript resolves to the `.d.ts` next to them; `npm run pack:check` typechecks a strict consumer against them with TypeScript 5.9.
- **zod is a peer dependency** (`^4.6.7`). The caller builds the schemas it passes to `structured()`, and the gateway turns them into a JSON schema with `z.toJSONSchema` and validates the reply with them. Two copies of zod in one application would mean schemas from one copy handled by the other. As a peer, the application's own zod is the one the gateway uses. 4.6.7 is the version the tests run.
- **`@anthropic-ai/sdk` is a dependency, pinned to 1.1.0.** The application never builds the client itself. `createClaudeClient` does, and `errors.ts` classifies its errors with `instanceof`. The gateway's own copy of the SDK is the one it was tested against, and the exact pin keeps it that way.
- **`import` and `require()` both load it.** Each `exports` entry pairs `types` with `default`, not `import`. TypeScript reads `types` in every resolution mode, so a CommonJS file typechecks against the package, and Node 24 loads an ES module through `require()`. With an `import` condition alone, that file compiled cleanly and then failed at runtime with `ERR_PACKAGE_PATH_NOT_EXPORTED`. `npm run pack:check` loads each entry both ways.
- **Node 24 or newer** (`engines`). That is the only version the tests and CI run, from `.node-version`. The compiled output may run on older versions, but none is tested, so none is claimed.
- **The build is checked as installed.** [`test/packaging/pack-check.ts`](../test/packaging/pack-check.ts) packs the package, installs the tarball outside the repository with its two dependencies, and compares its runtime and declared exports with `src/index.ts`.

## Run it

From the repository root:

```sh
npm ci
npm test -- gateway   # offline, no API key
npm run check         # tsc --noEmit (strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess)
```

Two opt-in checks, neither part of the test suite:

```sh
# Applies sql/schema.sql inside a transaction, runs the assertions, rolls back.
# Checked on PostgreSQL 16.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f gateway/sql/test.sql

# One real structured call. Without the variable it prints usage and exits.
ANTHROPIC_API_KEY=sk-ant-... node gateway/examples/live-call.ts
```

Node 24 runs the TypeScript sources directly (type stripping). There is no build step.

## What a call does

1. Validates the request: no assistant prefill, at most 4 cache breakpoints, ids are UUIDs, attachments carry a token bound.
2. Reads the task's model and effort, the caps and the usage totals, and validates each with zod.
3. Checks the caps. A reached cap throws `CapError` and nothing else happens.
4. Writes a reservation row to the ledger at the call's worst case. If that insert fails twice, the API is not called.
5. Checks the caps again, with everything else in flight and without its own reservation. A reached cap closes the reservation with a zero-usage row and throws `CapError`.
6. Calls `client.beta.messages` with server-side fallbacks. Only the gateway builds the request body.
7. Writes a second row that closes the reservation: the measured response, an incomplete row for a cut call, or a zero-usage row for a request that was not billed.
8. Checks `stop_reason`, then validates the text with the zod schema.

`structured`, `structuredStream` and `text` share that path. `src/gateway.ts` is the place to start reading.

## Design decisions

### Spending control

**Reserve before calling.** In the source app, an earlier version checked the caps, called, and wrote the ledger row with the response. When that insert failed (twice, with the retry), the call had been billed and the caps never saw it. With a failure that repeats, such as a deploy that writes a column the database does not have yet, every call passed the caps with the same totals and went out. The only remaining limit was the spend limit on the provider account. Now a reservation is written first, valued at the worst case. If it cannot be written, there is no call. If the closing row fails, the reservation stays open and keeps counting at its worst case. With the fixtures' US$10 daily cap, a test fails every closing row and checks that the loop stops after `ceil(10 / reservation cost)` calls.

**In-flight calls count.** Because the reservation exists while the call runs, parallel calls see each other's worst case. The price is headroom. In the tests a reservation is worth just over US$0.80 while the call costs US$0.0064. A cap therefore limits how many calls can be in flight at once, not only how much was spent. Lowering `max_tokens` for the task is the lever.

**Check, reserve, check again.** A single check before the reservation leaves a gap. Two calls that start together both read the totals before either reservation exists, both pass, and the cap is overrun by as many calls as arrive together. Closing that with one transaction would need a lock in the store and the caps inside it. The gateway instead checks again after its reservation is written, asking the store for the totals without its own row (`excludeId`, `p_exclude_id` in SQL). Every call that passes has seen the reservation of every call that reserved before its second read. In Postgres that needs each reservation committed on its own before the second read, which is what an autocommit insert does. Of the calls that pass, the last one to read has seen all the others, so concurrent calls overrun a cap by at most one worst-case reservation, the same bound as sequential calls. The cost is one more totals query per call. If that read fails, the call is refused with `invalid_usage_totals` and its reservation closed. Two calls that reserve at the same moment near a cap can both be refused; the error goes toward refusing, and the refused call's reservation is closed with a zero-usage row. The first check stays, so a loop that is already over a cap fails without writing rows. A test injects a reservation between the two checks, and another fires six calls at once with headroom for three.

**Worst case means the most expensive single attempt.** A reservation is valued at the estimated input plus `max_tokens` of output, at the highest price in force for each token type, because a server-side fallback can change which model answers. The input estimate is the UTF-8 byte length of the JSON of the system prompt, the messages and the output schema. A text token is at least one byte, so this never undercounts text. Images and PDFs are excluded, because their tokens come from pages and pixels, and counting base64 bytes would overstate them by orders of magnitude. A request with attachments must bring its own `attachmentTokenBound`, and must stream. A refusal mid-stream followed by a fallback can bill a second attempt; see Limits.

**Unpriced usage is bounded, never zero.** A row can end without a cost: a fallback model whose price is not loaded, a price table that did not answer, a call cut before the API reported usage. Those rows enter the caps at an upper bound, computed in the store from their tokens and, if incomplete, the estimate and `max_tokens`. An incomplete row whose `message_start` named a priced model uses that model's price. Otherwise the highest price in force applies. Cache reads are floored at 0.1x the highest input price. One priced model reads cache at 0.025x its input, but its fallbacks read at 0.1x, so the maximum alone would undercount. Without the bound, one unpriced model let a user spend with no cap at all.

**Nulls fail closed.** The usage totals return null for windows that were not requested, and the bound is null when there are unpriced rows and no price in force at all. The gateway throws `invalid_usage_totals` on a null where it asked for a sum instead of reading it as zero. A user with no account caps row gets `unknown_account`. An account can lower a global cap and never raise it.

**Windows in a configured time zone.** The day and month start at local midnight in an IANA zone passed to the gateway, never the process zone, which is UTC on most hosts. Local midnight is computed in two passes so a daylight saving change on that day does not shift it.

### The ledger

**Append-only, closed by insert.** Nobody updates or deletes ledger rows. The closing row names the reservation in `replaces`, and a unique index allows one closing row per reservation. The cap totals skip reservations that have a closing row, so each call counts once.

**Idempotent retries.** The gateway generates row ids. A failed insert is retried once with the same id, and the store treats an existing id as success, so an insert whose response was lost cannot double the cost. In Postgres that is `insert ... on conflict (id) do nothing`; a plain insert would turn the retry into a unique violation and report a written row as missing. `sql/test.sql` checks it.

**No row, no result.** A billed response whose closing row cannot be written, even after the retry, throws `RecordError` with the reservation's id and the `costUsd` that did not reach the ledger. The reservation stays open and keeps counting at its worst case. The response is withheld on purpose. Returning it would let a caller that ignores the error keep running up spend that the ledger does not show at its real value. The failure that blocks the closing row (a schema mismatch after a deploy) also tends to repeat on every call. Withholding makes the failure visible at once, and the open reservations keep the caps conservative until it is fixed.

**Constraints shared by both stores.** `sql/schema.sql` encodes the row rules as check constraints: a reservation has measured nothing, an incomplete row has no cost, every finished row names its model unless it is an unbilled error with zero tokens. `MemoryUsageStore.record` enforces every check constraint of `llm_usage`, the foreign key and the unique index, under the SQL names. Column types (integer, `numeric(12, 6)`, the effort enum) are left to the TypeScript types of `UsageRow`. A gateway bug that writes an inconsistent row therefore fails in the offline tests as it would against Postgres. `sql/test.sql` asserts the cap totals cases of `test/memory-store.test.ts` and the constraints a gateway row could break.

### Cost

**Per iteration, per model.** After a server-side fallback the top-level `usage` describes only the final attempt. The gateway prices each entry of `usage.iterations` at its own model, so the refused attempt is not billed silently. It also keeps the per-attempt breakdown in the row, so the cost can be recomputed once a missing price is loaded.

**Integers, and null instead of a guess.** Prices have four decimals, so the sum runs in integer units of 1e-10 US$ and rounds once to the ledger's six decimals. A model without a price makes the cost null with a notice naming it. Usage that reports a tariff the price table does not hold (a pinned region, priority, fast, batch) also makes it null, because the standard price would be wrong.

### Talking to the API

**One client, configured explicitly.** `createClaudeClient` takes the API key and base URL as arguments, so the SDK never reads `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL` from the host. It also pins `logLevel` (at debug the SDK logs request bodies) and the OpenTelemetry content mode (an environment variable can otherwise put prompts in traces). A test sets `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_LOG` and checks that none of them takes effect.

**The gateway owns timeouts and retries.** The SDK's `timeout` only covers the wait for response headers. The gateway runs its own deadline over the whole call (store reads, headers, body, stream) through an `AbortSignal` combined with the caller's. `maxRetries` is 0, because retries belong to the caller, which can honor `retry-after` and lower concurrency, and SDK retries could make one call outlive the deadline. The closing row is written outside the deadline, so a cut call is still recorded.

**Knowing whether a failed call was billed.** Each failure is classified by what it implies about spend:

- HTTP error from the API: not billed, closed with a zero-usage row.
- Connection never opened (DNS, refused, TLS handshake failure, connect timeout): not billed, zero-usage row.
- Timeout, caller abort or dropped connection after sending: possibly billed, incomplete row at its worst case.
- Anything from outside the API, SDK and network: rethrown unchanged; the reservation stays open.

The second case needed a fetch wrapper. The SDK treats any fetch error whose text mentions "timeout" as a request timeout and drops the cause, and undici's connect timeout says exactly that, so the evidence that nothing was sent was lost. Every network outage was charged at the worst case, and with retries an outage filled the caps with spend that never happened. `client.ts` wraps fetch and rethrows a connect failure as `ConnectionNotOpenedError`, whose message avoids the word. One test runs twenty connect timeouts in a row and checks the caps stay empty. Other tests open real local TCP servers that fail the TLS handshake in three different ways.

**A fixed request shape.** The request never sets `temperature`, `top_p` or `top_k`, because with SDK 1.1.0 and API version 2026-10-21 they are absent from the types and rejected by the API. It never sets `thinking` either. On the supported models thinking is always on or adaptive by default, some settings return a 400, and depth is set through `output_config.effort`. There is no assistant prefill: the `Conversation` type must end on a user turn, and a runtime check covers casts. Non-streaming calls are limited to 16,000 `max_tokens`; longer ones go through `structuredStream`.

**Server-side fallback.** Every call sends `fallbacks: "default"` with the beta header `server-side-fallback-2026-07-01`, as the source app does. `fallbacks` only exists on `client.beta.messages`, and the explicit-list mode uses a different header (`server-side-fallback-2026-06-01`); mixing them returns a 400. The response then names the model that answered, which is what the ledger records and prices.

### Structured output

**zod in, zod out.** The schema sent is `z.toJSONSchema(schema)` reduced to what structured outputs accept, and the response text is parsed with the same zod schema. The reducer is written here because the SDK 1.1.0 helper moves `enum` and `const` into the description, so the model could return a value outside the enum; a test shows the difference. Constraints the API does not accept (ranges, lengths, patterns) move into the description and zod enforces them on return. Recursive schemas, `z.record`, tuples and schemas over the API limits (24 optional properties, 16 unions) are rejected before calling, since the API would answer with a 400 only after the reservation.

**`stop_reason` before content.** `parse()` and formats that carry a parser validate as soon as the message ends and throw on a refusal or a `max_tokens` stop, losing the response and its usage. The gateway reads `stop_reason` first. Refusal, truncation and context overflow get their own codes, and only `end_turn` reaches validation.

### Errors and logs

**Stable codes.** Every failure is a `GatewayError` with a `code` from `ERROR_CODES` (`src/errors.ts`), each with one meaning. `ApiError` adds `retryable`, `retryAfterSec`, `status`, `requestId` and `usageId`. A test checks that every code used in the sources is in the catalog.

**Nothing from the conversation in errors or logs.** Error messages and log events carry ids, codes, counts and costs. They never include prompt text, model output or the API's error message, which can echo the request. Validation problems report the zod path and issue code, not the value. Notices (an unpriced model, a retried insert) and failures (a reservation or closing row that could not be written) go to separate channels so the second can be routed at error level.

**Stores return `unknown`.** A database row is an external boundary, and generated types cannot say which models the gateway supports or that a sum can be null. Every read is validated with zod before use.

## What the tests cover

| File | Covers |
|---|---|
| `test/gateway.test.ts` | The full call path over the real SDK client and a fake HTTP API: request body, reservation and closing rows, caps and the second check under concurrency, fallback pricing, every stop reason, HTTP errors 400 to 529, connect failures, timeouts, aborts, stream cuts at each event, ledger insert failures, fake timers for deadlines |
| `test/errors.test.ts` | Error classification by SDK class and stream event, connect-failure detection across undici, Node and OpenSSL error shapes, `retry-after` parsing, the code catalog |
| `test/cost.test.ts` | Prices in force, per-iteration usage split, integer cost arithmetic, tariff modifiers, input estimation, attachment counting |
| `test/memory-store.test.ts` | Cap totals semantics, `excludeId`, and every ledger constraint under its SQL name |
| `test/schema.test.ts` | The JSON schema reducer, the SDK helper comparison, recursion and complexity limits, output validation |
| `test/caps.test.ts` | Window boundaries in a time zone and across DST, cap precedence, null handling, float-safe sums |
| `test/client.test.ts` | Environment isolation, `maxRetries` 0, API version header, connect failures against real local TCP servers |

`test/helpers/fake-claude.ts` is the fake API. It answers the real client with JSON or server-sent events in the API's format. It can cut a stream after any event, send an error event, hang until aborted or fail the connection. No test touches the network or needs a key.

## Layout

```
src/
  gateway.ts       the call path
  client.ts        the Anthropic client and the fetch wrapper
  errors.ts        error classes, the code catalog, API error classification
  cost.ts          price lookup, usage split, cost, input estimation
  caps.ts          cap windows and the cap check
  schema.ts        zod to structured-outputs JSON schema, output validation
  config.ts        zod schemas for what the stores return
  ports.ts         store, clock and log interfaces
  memory-store.ts  in-memory stores with the SQL semantics
  models.ts        supported models, effort values, the fallback beta header
  setup.ts         startup checks for keys, timeouts and time zones
  index.ts         public exports
sql/
  schema.sql       tables, constraints, indexes, usage_for_caps()
  test.sql         assertions, run in a rolled-back transaction
examples/
  live-call.ts     one real call, opt-in
test/              Vitest suites and the fake API
```

## Limits

- There is no Postgres adapter in this folder, since it would need a database driver. `sql/schema.sql` is the reference and maps one to one onto `UsageRow` and `UsageTotals`; its header states the insert the adapter must use (`on conflict (id) do nothing`). The in-memory stores are only correct within one process.
- Concurrent calls can overrun a cap by one worst-case reservation, and near a cap a burst of calls can all be refused, as described above.
- The bound for unpriced rows uses standard prices. A complete row left without a cost because its usage reported another tariff (priority tier, fast speed, a pinned region) is billed at a premium the bound does not include.
- The gateway does not retry. It returns `retryable` and `retryAfterSec` for a job queue or the caller to act on.
- No tool use, no extended thinking controls, no Message Batches (`fallbacks` is not accepted there).
- The model list, the fallback header and the request rules are pinned to SDK 1.1.0 and API version 2026-10-21. Two points are still open in the source app. One is whether `fallbacks: "default"` together with `output_config.format` is valid for every fallback target. The other is the prices of fallback models, which are not loaded, so those calls are counted at the upper bound.
- The worst case covers one attempt. If a model refuses midway through a stream and the fallback continues, a cut after that can exceed the bound by the second attempt.
- An abort that fires while the connection is still opening is counted as a cut at the worst case, even though nothing was sent. The error goes toward overcounting.
- Two features of the source app were left out: a daily count cap for one task, and extra ids on ledger rows.
- Prices in the tests are fixtures for checkable arithmetic. The example's prices are as listed when it was written; check the current pricing page before relying on a computed cost.
