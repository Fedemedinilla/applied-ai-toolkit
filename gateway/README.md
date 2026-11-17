# Claude API gateway

A TypeScript gateway that is the only code in an application allowed to call the Claude API. Its job is to keep spending caps true in the cases that usually break them. Those are a ledger insert that fails, a stream cut halfway, a fallback model with no price, concurrent calls near a cap and a network outage retried in a loop. Each call reserves its worst-case cost before it goes out and closes that reservation with the cost measured per attempt. Structured output is sent as a JSON schema built from zod and validated with the same schema on return. Every failure maps to a stable error code that says whether the request was billed and whether a retry makes sense. I extracted it from a production app I am building; the stores became interfaces, with an in-memory implementation and a Postgres adapter over the SQL schema in `sql/`. A project adapts it through configuration: a model registry, a store adapter and an optional tracing hook, described under [Adapting it to a project](#adapting-it-to-a-project).

## Install

```sh
npm install @fedemedinilla/claude-gateway zod
```

```ts
import { createClaudeClient, createGateway, createMemoryStores } from '@fedemedinilla/claude-gateway';
```

The package entry is built from `src/index.ts`. Inside this repository nothing changes. Node runs the `.ts` files directly, and apps import `gateway/src/index.ts` as before.

The package has one entry, and everything is imported from it. Besides the gateway, the client and the error classes, it exports `createModelRegistry` with the `ModelSpec` schema, `createPostgresStores`, and `otelObserver` with the `CallObserver` and `CallSpan` types. The SQL schema is not in the tarball; copy [`sql/schema.sql`](sql/schema.sql) from the repository into your migrations.

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

Three opt-in checks, none part of the test suite:

```sh
# Applies sql/schema.sql inside a transaction, runs the assertions, rolls back.
# Checked on PostgreSQL 16.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f gateway/sql/test.sql

# Fires 20 reserve_usage calls at once from separate connections, three rounds, in a scratch
# database it creates and drops. Needs a role that can create databases. Checked on PostgreSQL 16.
PGHOST=localhost PGUSER=postgres bash gateway/sql/race.sh

# One real structured call. Without the variable it prints usage and exits.
ANTHROPIC_API_KEY=sk-ant-... node gateway/examples/live-call.ts
```

Node 24 runs the TypeScript sources directly (type stripping). There is no build step.

## What a call does

1. Validates the request: no assistant prefill, at most 4 cache breakpoints, ids are UUIDs, attachments carry a token bound.
2. Reads the task's model and effort, the caps and the usage totals, and validates each with zod. The model has to be in the registry, with an effort level and a `max_tokens` its entry allows.
3. Checks the caps. A reached cap throws `CapError` and nothing else happens.
4. Writes a reservation row to the ledger at the call's worst case. If that insert fails twice, the API is not called and `ReservationError` names the id. When the first attempt reached the store and only its response was lost, that row stays in the ledger, open at its worst case.
5. Checks the caps again, with everything else in flight and without its own reservation. A reached cap closes the reservation with a zero-usage row and throws `CapError`. A store with an atomic `reserve` does steps 4 and 5 in one statement.
6. Calls `client.beta.messages`, with server-side fallbacks when the model's entry has them. Only the gateway builds the request body.
7. Writes a second row that closes the reservation: the measured response, an incomplete row for a cut call, or a zero-usage row for a request that was not billed.
8. Checks `stop_reason`, then validates the text with the zod schema.

`structured`, `structuredStream` and `text` share that path. `src/gateway.ts` is the place to start reading.

## Adapting it to a project

A project chooses which models it calls, where the ledger lives and where traces go. Each choice is passed to `createGateway`, and none needs an edit to the gateway's source.

### Register a model

The registry starts with four built-in entries, `claude-fable-5-2`, `claude-fable-5-1`, `claude-sonnet-5-5` and `claude-opus-5-5`, checked against SDK 1.1.0 and API version 2026-10-21. `createModelRegistry` adds others. Each entry is validated with the `ModelSpec` zod schema when the process starts, and a missing field throws `SetupError` there.

```ts
import { createGateway, createModelRegistry } from '@fedemedinilla/claude-gateway';

const models = createModelRegistry([
  {
    id: 'claude-haiku-5-5',
    maxOutputTokens: 128_000,
    // US$ per million tokens. This model has two rate cards; these are the higher one. See below.
    price: {
      validFrom: '2026-11-03T00:00:00Z',
      input: 0.5,
      output: 2.5,
      cacheRead: 0.05,
      cacheWrite5m: 0.625,
      cacheWrite1h: 1,
      source: 'Anthropic API reference, checked 2026-11-03, long-prompt rate card',
    },
    surface: {
      thinking: 'adaptive_by_default',
      samplingParams: 'rejected',
      forcedToolChoice: 'accepted',
      assistantPrefill: 'rejected',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      serverFallback: 'none',
      structuredOutputs: true,
    },
  },
]);

const gateway = createGateway({ ...deps, models });
await stores.loadPrices(models.priceRows()); // Postgres; with the memory stores, pass them as `prices`
```

The `surface` fields say what the gateway relies on:

| Field | What it states | What the gateway does with it |
|---|---|---|
| `thinking` | What the model does when the request has no `thinking` field (`always_on`, `adaptive_by_default` or `off_by_default`) | Nothing. It never sends `thinking`. With thinking on, `maxTokens` has to leave room for it |
| `samplingParams` | Whether `temperature`, `top_p` and `top_k` are `rejected` or `accepted` | Nothing. It sends none |
| `forcedToolChoice` | Whether a forced `tool_choice` is `rejected` or `accepted` | Nothing. It sends no tools |
| `assistantPrefill` | Whether a conversation ending on an assistant turn is `rejected` or `accepted` | Nothing. It refuses prefill for every model |
| `efforts` | The `output_config.effort` levels the model takes | Rejects a task or call config with another level before any call |
| `serverFallback` | `default` or `none` | With `none` it sends neither `fallbacks` nor the beta header |
| `structuredOutputs` | Whether `output_config.format` works | With `false`, `structured` and `structuredStream` refuse the model and `text` still works |

`maxOutputTokens` is the model's output limit; a request that asks for more is refused before any call. A model in a task config or a call config that is not in the registry is still rejected with `invalid_config` or `invalid_request`, and the API is not called. The gateway's types follow the registry. With the entry above, a call config naming `claude-haiku-5-5` compiles and an id outside the registry does not.

**Claude Haiku 5.5 is not a built-in entry.** Its request surface fits what the gateway sends. Anthropic's migration guide says it runs adaptive thinking by default, rejects sampling parameters and prefill, takes all five effort levels, and has no server-side fallback, which is why the entry above says `serverFallback: 'none'`. Its price does not fit. The guide lists two rate cards per million tokens. A prompt of 100,000 tokens or fewer costs US$0.10 input and US$0.50 output, and a longer one costs US$0.50 and US$2.50. Cache reads are 0.1x the input rate, and cache writes 1.25x and 2x. The gateway's price table holds one rate per token type. Registered at the higher card, as above, the caps never undercount, and the ledger overstates the cost of a short-prompt call by up to five times. Registered at the lower card, a prompt longer than 100,000 tokens would be undercounted. That choice belongs to the project, so the entry is left to the caller. Check the current pricing page before you copy these numbers.

### Store the ledger in Postgres

`createPostgresStores` takes any client with `query(text, params)` that resolves to `{ rows }`. It adds no dependency. Apply [`sql/schema.sql`](sql/schema.sql) first.

```ts
import { Pool } from 'pg';
import { createGateway, createModelRegistry, createPostgresStores } from '@fedemedinilla/claude-gateway';

const pool = new Pool({ connectionString: process.env.DATABASE_URL }); // also a Supabase database
const stores = createPostgresStores(pool);
await stores.loadPrices(createModelRegistry().priceRows()); // once; existing rows are left alone

const gateway = createGateway({ ...deps, config: stores.config, usage: stores.usage, prices: stores.prices });
```

| Client | How it fits |
|---|---|
| `pg` (`Pool` or `Client`), also against Supabase's connection string | As it is |
| PGlite | As it is. The tests use it |
| postgres.js | `{ query: async (text, params) => ({ rows: await sql.unsafe(text, params) }) }` |

The adapter was run against PGlite only. `pg` and postgres.js fit by their documented signatures and were not run here.

### Trace calls

Pass an `observer` and the gateway hands it one `CallSpan` per call, after the call ends, whatever the outcome. `otelObserver` maps the span to OpenTelemetry on a tracer you pass in.

```ts
import { trace } from '@opentelemetry/api';
import { createGateway, otelObserver } from '@fedemedinilla/claude-gateway';

const gateway = createGateway({ ...deps, observer: otelObserver(trace.getTracer('claude-gateway')) });

// Or your own exporter:
const logging = createGateway({ ...deps, observer: { onCall: (span) => console.log(JSON.stringify(span)) } });
```

Each call becomes one span of kind `CLIENT` named `chat <model>`. The attributes that have a name in the OpenTelemetry GenAI semantic conventions use it:

| Attribute | Value |
|---|---|
| `gen_ai.operation.name` | `chat` |
| `gen_ai.provider.name` | `anthropic` |
| `gen_ai.request.model` | The model asked for |
| `gen_ai.response.model` | The model that answered, another one after a fallback |
| `gen_ai.request.max_tokens` | `maxTokens` |
| `gen_ai.usage.input_tokens` | All input tokens: uncached, read from cache and written to it, as the convention defines it |
| `gen_ai.usage.output_tokens` | Output tokens, thinking included |
| `gen_ai.usage.cache_read.input_tokens` | Tokens read from cache |
| `gen_ai.usage.cache_creation.input_tokens` | Tokens written to cache |
| `gen_ai.response.finish_reasons` | The `stop_reason`, as a one-element list |
| `error.type` | The gateway's error code, on a failed call |

The rest go under the `claude_gateway.` prefix, namely `operation`, `task`, `prompt_version`, `effort`, `streaming`, `outcome`, `fell_back`, `cost.reserved_usd`, `cost.settled_usd`, `request_id`, `reservation_id` and `usage_id`. A failed call also gets status `ERROR` with the code as its message. An attribute whose value is unknown is left out. A cut call has no `cost.settled_usd`, because its cost is unknown and a zero would read as free. For the same reason it has no `gen_ai.usage.output_tokens`, and when it was cut before `message_start` it has no token attributes at all. The span marks it with `incomplete: true`.

## Design decisions

### Spending control

**Reserve before calling.** In the source app, an earlier version checked the caps, called, and wrote the ledger row with the response. When that insert failed (twice, with the retry), the call had been billed and the caps never saw it. With a failure that repeats, such as a deploy that writes a column the database does not have yet, every call passed the caps with the same totals and went out. The only remaining limit was the spend limit on the provider account. Now a reservation is written first, valued at the worst case. If it cannot be written, there is no call. If the closing row fails, the reservation stays open and keeps counting at its worst case. With the fixtures' US$10 daily cap, a test fails every closing row and checks that the loop stops after `ceil(10 / reservation cost)` calls.

**In-flight calls count.** Because the reservation exists while the call runs, parallel calls see each other's worst case. The price is headroom. In the tests a reservation is worth just over US$0.80 while the call costs US$0.0064. A cap therefore limits how many calls can be in flight at once, not only how much was spent. Lowering `max_tokens` for the task is the lever.

**Check, reserve, check again.** A single check before the reservation leaves a gap. Two calls that start together both read the totals before either reservation exists, both pass, and the cap is overrun by as many calls as arrive together. A store without an atomic `reserve` cannot close that in one step, so the gateway checks again after its reservation is written, asking the store for the totals without its own row (`excludeId`, `p_exclude_id` in SQL). Every call that passes has seen the reservation of every call that reserved before its second read. In Postgres that needs each reservation committed on its own before the second read, which is what an autocommit insert does. Of the calls that pass, the last one to read has seen all the others, so concurrent calls overrun a cap by at most one worst-case reservation, the same bound as sequential calls. The cost is one more totals query per call. If that read fails, the call is refused with `invalid_usage_totals` and its reservation closed. Two calls that reserve at the same moment near a cap can both be refused; the error goes toward refusing, and the refused call's reservation is closed with a zero-usage row. The first check stays, so a loop that is already over a cap fails without writing rows. A test injects a reservation between the two checks, and another fires six calls at once with headroom for three.

**Atomic reservation where the store can do it.** `UsageStore.reserve` is optional. A store that has it writes the reservation and returns the totals without it as one step, ordered against every other reservation. The reason is the burst case above. With two separate steps, calls that reserve together all see each other and can all be refused. In order, the first ones pass and the rest are refused. The Postgres adapter does it with the SQL function `reserve_usage`, which takes a transaction-level advisory lock, inserts the row and reads `usage_for_caps` without it. A single `insert ... select` could not do this. Two such statements that start together each read before the other's row is committed, and both pass. I chose an advisory lock over `select ... for update` on the caps row because a row lock needs the `UPDATE` privilege on `llm_global_caps`, and the application role should not be able to edit the caps. The function needs READ COMMITTED, the Postgres default. At that level each statement inside it takes a new snapshot, so the totals query sees what the previous lock holder committed. Under REPEATABLE READ or SERIALIZABLE the snapshot predates the lock and the totals would miss those rows, so the function raises an error instead of running. Call it as its own statement. The lock lasts for one insert and one totals query, and every reservation in the database queues behind it; calls to the API do not. The cap comparison stays in the gateway, so a refused call's reservation still counts for the few milliseconds until its zero-usage row closes it. A test fires twelve calls at once with headroom for three and checks that three go out and nine are refused.

**Worst case means the most expensive single attempt.** A reservation is valued at the estimated input plus `max_tokens` of output, at the highest price in force for each token type, because a server-side fallback can change which model answers. The input estimate is the UTF-8 byte length of the JSON of the system prompt, the messages and the output schema. A text token is at least one byte, so this never undercounts text. Images and PDFs are excluded, because their tokens come from pages and pixels, and counting base64 bytes would overstate them by orders of magnitude. A request with attachments must bring its own `attachmentTokenBound`, and must stream. A refusal mid-stream followed by a fallback can bill a second attempt; see Limits.

**Unpriced usage is bounded, never zero.** A row can end without a cost: a fallback model whose price is not loaded, a price table that did not answer, a call cut before the API reported usage. Those rows enter the caps at an upper bound, computed in the store from their tokens and, if incomplete, the estimate and `max_tokens`. An incomplete row whose `message_start` named a priced model uses that model's price. Otherwise the highest price in force applies. Cache reads are floored at 0.1x the highest input price. One priced model reads cache at 0.025x its input, but its fallbacks read at 0.1x, so the maximum alone would undercount. Without the bound, one unpriced model let a user spend with no cap at all.

**Nulls fail closed.** The usage totals return null for windows that were not requested, and the bound is null when there are unpriced rows and no price in force at all. The gateway throws `invalid_usage_totals` on a null where it asked for a sum instead of reading it as zero. A user with no account caps row gets `unknown_account`. An account can lower a global cap and never raise it.

**Windows in a configured time zone.** The day and month start at local midnight in an IANA zone passed to the gateway, never the process zone, which is UTC on most hosts. Local midnight is computed in two passes so a daylight saving change on that day does not shift it. Where the clocks skip midnight, as in Santiago and Havana, the day starts at the first local instant of that date, 01:00, and a test sweeps every day of 2026 in eight zones.

### The ledger

**Append-only, closed by insert.** Nobody updates or deletes ledger rows. The closing row names the reservation in `replaces`, and a unique index allows one closing row per reservation. The cap totals skip reservations that have a closing row, so each call counts once.

**Idempotent retries.** The gateway generates row ids. A failed insert is retried once with the same id, and the store treats an existing id as success, so an insert whose response was lost cannot double the cost. In Postgres that is `insert ... on conflict (id) do nothing`; a plain insert would turn the retry into a unique violation and report a written row as missing. `sql/test.sql` checks it.

**No row, no result.** A billed response whose closing row cannot be written, even after the retry, throws `RecordError` with the reservation's id and the `costUsd` that did not reach the ledger. The reservation stays open and keeps counting at its worst case. The response is withheld on purpose. Returning it would let a caller that ignores the error keep running up spend that the ledger does not show at its real value. The failure that blocks the closing row (a schema mismatch after a deploy) also tends to repeat on every call. Withholding makes the failure visible at once, and the open reservations keep the caps conservative until it is fixed.

**A Postgres adapter with no driver.** The adapter needs one method, `query(text, params)`, so it fits `pg`, PGlite and a Supabase database, and the package stays without a database dependency. Every parameter is sent as text and cast in the SQL (`$1::text::uuid`). Drivers serialize numbers, dates, arrays and JSON in different ways, and they all pass a string through unchanged. Money columns come back cast to `float8` and counts as `integer`, because `numeric` arrives as a string in `pg`. Each method is a single statement, so it works on a pool that gives every query a different connection, and nothing opens a transaction. `created_at` is the database's `now()`, while the cap windows come from the gateway's clock, so the two hosts have to agree on the time.

**One contract, two stores.** `test/helpers/store-contract.ts` is one suite, and `test/store-contract.test.ts` runs it over the in-memory stores and over the Postgres adapter on PGlite with `sql/schema.sql` applied. The same rows go in, and the same totals and the same constraint names have to come out. Before this the SQL was only checked by `sql/test.sql`, which needs a database and is not part of CI.

**Constraints shared by both stores.** `sql/schema.sql` encodes the row rules as check constraints: a reservation has measured nothing, an incomplete row has no cost, every finished row names its model unless it is an unbilled error with zero tokens. `MemoryUsageStore.record` enforces every check constraint of `llm_usage`, the foreign key and the unique index, under the SQL names. Column types (integer, `numeric(12, 6)`, the effort enum) are left to the TypeScript types of `UsageRow`. A gateway bug that writes an inconsistent row therefore fails in the offline tests as it would against Postgres. `sql/test.sql` asserts the cap totals cases of `test/memory-store.test.ts` and the constraints a gateway row could break.

### Cost

**Per iteration, per model.** After a server-side fallback the top-level `usage` describes only the final attempt. The gateway prices each entry of `usage.iterations` at its own model, so the refused attempt is not billed silently. It also keeps the per-attempt breakdown in the row, so the cost can be recomputed once a missing price is loaded.

**Integers, and null instead of a guess.** Prices have four decimals, so the sum runs in integer units of 1e-10 US$ and rounds once to the ledger's six decimals. A model without a price makes the cost null with a notice naming it. Usage that reports a tariff the price table does not hold (a pinned region, priority, fast, batch) also makes it null, because the standard price would be wrong.

**The registry carries a list price, and the price table still decides.** A registry entry must state its price, since a model with no price would enter the caps only at a bound. Those prices are data for loading a price store (`priceRows()`), and the cost of a call is still computed from the store's rows in force at the time of the call. A price change stays a new row with a later `validFrom`, and no code changes. The built-in prices are the input, output and cache read prices in Anthropic's API reference on 2026-11-03. Cache writes are listed there for `claude-fable-5-2`; for the other three they are the published 1.25x and 2x of the input price. Registry prices must be above zero and have at most four decimals. A zero would price calls at nothing, and a fifth decimal would break the integer sum. The price table holds the same rule. `model_prices` has `> 0` checks, and a zero row read from any store fails `PriceRow`, so the call is recorded without cost and counted at its bound. The grants suggested in `sql/schema.sql` give the application role only `SELECT` on `model_prices`; run `loadPrices` with the migration or admin role, so a bug or a compromised app server cannot insert a cheaper price. A `validFrom` must be an ISO 8601 date-time with `Z` or a numeric offset. Without one, the memory store reads it in the process zone and Postgres in the session zone, so the two would disagree on when the price starts.

### Talking to the API

**Models come from a registry, and an entry states its surface.** The gateway used to hold a fixed list of four models, so another project had to edit the source to call a fifth. The list is now the registry's built-in entries, and a caller adds entries through validated config. An entry has to say how the model treats `thinking`, sampling parameters, forced `tool_choice` and prefill, even though the gateway sends none of them. The fixed request shape below is only safe on a model where someone has checked those four points, and a required field is how the registry asks for that check. Three more fields change behavior: `efforts`, `serverFallback` and `structuredOutputs`. Built-in entries cannot be replaced, so a typo in a project's config cannot loosen a verified entry. The schema is strict, so an unknown key fails at startup.

**One client, configured explicitly.** `createClaudeClient` takes the API key and base URL as arguments, so the SDK never reads `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL` from the host. It also pins `logLevel` (at debug the SDK logs request bodies) and the OpenTelemetry content mode (an environment variable can otherwise put prompts in traces). A test sets `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_LOG` and checks that none of them takes effect.

**The gateway owns timeouts and retries.** The SDK's `timeout` only covers the wait for response headers. The gateway runs its own deadline over the whole call (store reads, headers, body, stream) through an `AbortSignal` combined with the caller's. `maxRetries` is 0, because retries belong to the caller, which can honor `retry-after` and lower concurrency, and SDK retries could make one call outlive the deadline. The reservation write is raced against the deadline and the caller's signal, so a store that does not answer cannot hold a call past either. Such a cut throws `ApiError` with the reservation's id, because the row may still land; if it does, a zero-usage row closes it. The closing row is written outside the deadline, so a cut call is still recorded. A timeout must be at most 2,147,483,647 ms, the `setTimeout` limit. Node fires a longer delay after 1 ms, so a larger value fails at startup or as a malformed request.

**Knowing whether a failed call was billed.** Each failure is classified by what it implies about spend:

- HTTP error from the API: not billed, closed with a zero-usage row.
- Connection never opened (DNS, refused, TLS handshake failure, connect timeout): not billed, zero-usage row.
- Timeout, caller abort or dropped connection after sending: possibly billed, incomplete row at its worst case.
- Anything from outside the API, SDK and network: rethrown unchanged; the reservation stays open.

The second case needed a fetch wrapper. The SDK treats any fetch error whose text mentions "timeout" as a request timeout and drops the cause, and undici's connect timeout says exactly that, so the evidence that nothing was sent was lost. Every network outage was charged at the worst case, and with retries an outage filled the caps with spend that never happened. `client.ts` wraps fetch and rethrows a connect failure as `ConnectionNotOpenedError`, whose message avoids the word. One test runs twenty connect timeouts in a row and checks the caps stay empty. Other tests open real local TCP servers that fail the TLS handshake in three different ways.

**A fixed request shape.** The request never sets `temperature`, `top_p` or `top_k`, because with SDK 1.1.0 and API version 2026-10-21 they are absent from the types and rejected by the API. It never sets `thinking` either. On the supported models thinking is always on or adaptive by default, some settings return a 400, and depth is set through `output_config.effort`. There is no assistant prefill: the `Conversation` type must end on a user turn, and a runtime check covers casts. Non-streaming calls are limited to 16,000 `max_tokens`; longer ones go through `structuredStream`.

**Server-side fallback.** Every call to a model whose entry says `serverFallback: 'default'`, which includes the four built-in ones, sends `fallbacks: "default"` with the beta header `server-side-fallback-2026-07-01`, as the source app does. `fallbacks` only exists on `client.beta.messages`, and the explicit-list mode uses a different header (`server-side-fallback-2026-06-01`); mixing them returns a 400. The response then names the model that answered, which is what the ledger records and prices.

### Structured output

**zod in, zod out.** The schema sent is `z.toJSONSchema(schema)` reduced to what structured outputs accept, and the response text is parsed with the same zod schema. The reducer is written here because the SDK 1.1.0 helper moves `enum` and `const` into the description, so the model could return a value outside the enum; a test shows the difference. Constraints the API does not accept (ranges, lengths, patterns) move into the description and zod enforces them on return. An accepted format keeps zod's pattern in the description too, unless the two say the same thing (`date`). zod's pattern is often narrower. `z.iso.datetime()` accepts only `Z` while the `date-time` format allows any offset, so without the hint a valid answer could fail zod after it was billed. Recursive schemas, `z.record`, tuples and schemas over the API limits (24 optional properties, 16 unions) are rejected before calling, since the API would answer with a 400 only after the reservation.

**`stop_reason` before content.** `parse()` and formats that carry a parser validate as soon as the message ends and throw on a refusal or a `max_tokens` stop, losing the response and its usage. The gateway reads `stop_reason` first. Refusal, truncation and context overflow get their own codes, and only `end_turn` reaches validation.

### Errors and logs

**Stable codes.** Every failure is a `GatewayError` with a `code` from `ERROR_CODES` (`src/errors.ts`), each with one meaning. `ApiError` adds `retryable`, `retryAfterSec`, `status`, `requestId` and `usageId`. A test checks that every code used in the sources is in the catalog.

**Nothing from the conversation in errors or logs.** Error messages and log events carry ids, codes, counts and costs. They never include prompt text, model output or the API's error message, which can echo the request. Validation problems report the zod path and issue code, not the value. Notices (an unpriced model, a retried insert) and failures (a reservation or closing row that could not be written) go to separate channels so the second can be routed at error level.

**Tracing through an interface, with no dependency.** The gateway emits one plain object per call to an observer. `otelObserver` is a function over a tracer typed by its shape, so the package does not depend on `@opentelemetry/api`, and a project without OpenTelemetry pays nothing. A `Tracer` from `@opentelemetry/api` 1.10.0 was checked to fit that shape with `tsc`. The span is built when the call ends, with the call's own start and end times, because the reserved and settled costs are only known then. The reserved cost is the estimated input and `maxTokens` of output at the highest price in force among the registry's models. The stores value an open reservation at the highest price of every model in their price table. A priced model outside the registry with higher rates therefore makes the span's figure lower than what the caps hold. It costs one more price read per call, made once the call has ended and only when an observer is set. The call returns after that read, and the span's duration ends before it. A span has no field for prompt, system or response text, and none for the user or job id. A test puts marker strings in all three texts and checks that none reaches a span or its attributes. An observer that throws does not change the call's result; the gateway logs `observer_failed`.

**Stores return `unknown`.** A database row is an external boundary, and generated types cannot say which models the gateway supports or that a sum can be null. Every read is validated with zod before use.

## What the tests cover

| File | Covers |
|---|---|
| `test/gateway.test.ts` | The full call path over the real SDK client and a fake HTTP API: request body, reservation and closing rows, caps and the second check under concurrency, fallback pricing, every stop reason, HTTP errors 400 to 529, connect failures, timeouts, aborts, stream cuts at each event, ledger insert failures, fake timers for deadlines |
| `test/errors.test.ts` | Error classification by SDK class and stream event, connect-failure detection across undici, Node and OpenSSL error shapes, `retry-after` parsing, the code catalog |
| `test/cost.test.ts` | Prices in force, per-iteration usage split, integer cost arithmetic, tariff modifiers, input estimation, attachment counting |
| `test/memory-store.test.ts` | Cap totals semantics, `excludeId`, and every ledger constraint under its SQL name |
| `test/store-contract.test.ts` | The store contract over the memory stores and over Postgres in PGlite, covering config and price reads, cap totals, idempotent inserts, constraint names, `reserve` and its ordering under a race |
| `test/postgres-store.test.ts` | The gateway over the Postgres adapter, with reservation and closing rows, twelve racing calls with room for three, a reservation insert that fails or loses its response, a closing row that fails, stream cuts before and after `message_start`, the isolation level check |
| `test/models.test.ts` | Built-in entries, every field a custom entry must state, prices that are missing, zero or too precise, and what the gateway sends and refuses for a registered model |
| `test/observe.test.ts` | One span per call for each outcome, reserved and settled cost, no prompt or response text, a throwing observer, and the OpenTelemetry attributes through a fake tracer |
| `test/schema.test.ts` | The JSON schema reducer, the SDK helper comparison, recursion and complexity limits, output validation |
| `test/caps.test.ts` | Window boundaries in a time zone and across DST, cap precedence, null handling, float-safe sums |
| `test/client.test.ts` | Environment isolation, `maxRetries` 0, API version header, connect failures against real local TCP servers |

The two Postgres suites run on PGlite, which has one connection. They exercise the SQL as written and the interleaving of the gateway's steps between statements. They do not make two connections wait on the advisory lock. `sql/race.sh` does, on a real server. With the lock every call returns a different total, and with the lock line removed the totals repeat in every run.

`test/helpers/fake-claude.ts` is the fake API. It answers the real client with JSON or server-sent events in the API's format. It can cut a stream after any event, send an error event, hang until aborted or fail the connection. No test touches the network or needs a key.

## Mutation testing

```sh
npm run mutation:gateway   # StrykerJS over src/caps.ts and src/cost.ts with this folder's tests; about 5 minutes on 4 cores
```

Stryker changes the code one small edit at a time (a `>=` into a `>`, a condition into `true`) and runs the tests against each mutant. A mutant that survives is a line a bug could change with no test failing. The report goes to `reports/mutation/gateway/`.

Measured on 2026-11-17 with StrykerJS 10.1.1, on 4 cores of a shared cloud container. A mutant that makes the tests run past Stryker's timeout counts as killed. All 16 of those are in `caps.ts`, 5 in the DST correction and 11 in `checkCaps` and its helpers.

| File | Mutants | Killed | Of them, by timeout | Survived | Score |
| --- | --- | --- | --- | --- | --- |
| `src/caps.ts` | 98 | 98 | 16 | 0 | 100.00% |
| `src/cost.ts` | 184 | 184 | 0 | 0 | 100.00% |
| Both | 282 | 282 | 16 | 0 | 100.00% |

The first run scored 90.15%, with 23 survivors and 4 mutants no test reached. The gaps it showed, each now a test:

- A job without a user, or a user without an account row, has no own cap. With the fallback to the global cap removed, the comparison ran against `NaN` and no cap ever stopped the call.
- The first pass of the DST correction was only tested west of UTC, where stepping forward or back by the offset gives the same midnight. Berlin on the day its clocks change tells them apart.
- The error for a null total was checked for two of its seven field names.
- A price whose `validFrom` is exactly the call time, and price rows that arrive out of order.
- `advisor_message` and `compaction` iterations were never split.
- `countAttachments` over `null`, a null `source` and a `source` that is a string, which threw with the type checks removed.
- The filter that blanks base64 data also blanked the `data` of a plain-text document when its type check was removed.

The DST correction for midnight gaps, added on 2026-11-15, brought the score down to 96.33%, under the threshold, with 11 survivors. Six were real gaps, now tests:

- The bisection to the second only matters when a gap starts before midnight and skips it. Santiago and Havana start theirs at midnight, so the loop could be removed with no test failing. Toronto and Nassau on 1919-03-31 went from 23:30 straight to 00:30. A scan of the IANA data in Node 24 from 1900 to 2037 found no other such gap, and the test pins the day start there.
- Two price rows of one model with the same `validFrom`. Postgres cannot hold both, but `MemoryPriceStore` or a custom store can return them, and the first one stays, as `loadPrices` keeps the row that is already there.

The other five were equivalent. No test could kill them, so the code changed instead. `partsAt` read each part with `?.`, and `formatToParts` returns every part the formatter asks for. The date check compared year, month and day, but the instants it checks are always on the target date or the one before. Two consecutive dates never share a day of the month, so it now compares the day alone.

`thresholds.break` in `stryker.config.json` is 97: a run below it exits non-zero. The weekly workflow `.github/workflows/quality.yml` runs it.

## Benchmarks

```sh
npm run bench            # every bench of the repository, about 15 seconds; writes reports/bench/result.json
npm run bench:compare    # compares the run with test/bench/baseline.json; exit 1 on a regression beyond 50%
```

| Bench | One iteration | Median |
| --- | --- | --- |
| `gateway/concurrent-50-under-cap` | 50 concurrent `structured` calls, all sent and settled | 17.13 ms (0.34 ms per call) |
| `gateway/concurrent-50-at-cap` | 50 concurrent calls at the daily cap, all refused before any request | 9.86 ms (0.20 ms per call) |

Measured on 2026-11-14 with Node 24.22.1 on 4 cores of a shared cloud container (Intel Xeon at 2.30 GHz). The milliseconds are that machine's on that day; [`test/bench/README.md`](../test/bench/README.md) explains how a run is compared with the baseline on another machine, and the limits of that comparison.

`test/concurrency.bench.ts` runs the real SDK client over the fake wire of `test/helpers/fake-claude.ts`, which answers at once, and the in-memory stores. So the time is the gateway's own work around a request: the config reads, both cap checks, the reservation, the request and its parsing, and the closing row. With a real database each of those reads and writes adds a round trip that this bench does not have. After every burst, outside the timed part, the bench checks the ledger: under the cap all 50 calls settled, the recorded spend is 50 times the call cost and no reservation is open; at the cap all 50 were refused with `cap_daily_user`, no request left and the spend did not move. A burst that breaks one of these fails the bench.

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
  postgres-store.ts  the stores over Postgres, for any client with query(text, params)
  models.ts        the model registry, effort values, the fallback beta header
  observe.ts       the call span, the observer interface, the OpenTelemetry adapter
  setup.ts         startup checks for keys, timeouts and time zones
  index.ts         public exports
sql/
  schema.sql       tables, constraints, indexes, usage_for_caps(), reserve_usage()
  test.sql         assertions, run in a rolled-back transaction
  race.sh          parallel reserve_usage calls over separate connections, opt-in
examples/
  live-call.ts     one real call, opt-in
test/              Vitest suites and the fake API
```

## What it does not do

- It does not retry. It returns `retryable` and `retryAfterSec` for a job queue or the caller to act on.
- It does not send tools, thinking settings, sampling parameters or Message Batches (`fallbacks` is not accepted there). A model that needs one of them to be useful does not fit, whatever its registry entry says.
- It does not check a registry entry against the API. The entry is the caller's statement, and a wrong one shows up as a 400 on the first call, after the reservation, closed with a zero-usage row.
- It does not price by prompt length. The price table has one rate per token type, so a model with several rate cards is registered at one of them, as the Haiku example shows.
- It does not load prices or apply the schema by itself. `loadPrices` and `sql/schema.sql` are steps the project runs.
- It does not call models from other providers. A registry id has to look like a Claude model id, and the request is the Claude Messages API.
- It does not create trace context. `otelObserver` writes one finished span per call on the tracer it is given, with no child spans for the store reads, and it never records prompt or response text.
- It is not a billing system. The caps guard against bugs and runaway loops; the provider's invoice is the record of what was spent.

## Limits

- The in-memory stores are only correct within one process.
- The Postgres adapter was tested on PGlite, with one connection. The advisory lock is exercised across connections only by `sql/race.sh`, an opt-in script that CI does not run, and `sql/test.sql` does not cover `reserve_usage`.
- Concurrent calls can overrun a cap by one worst-case reservation. With a store that has no atomic `reserve`, a burst of calls near a cap can all be refused, as described above.
- The bound for unpriced rows uses standard prices. A complete row left without a cost because its usage reported another tariff (priority tier, fast speed, a pinned region) is billed at a premium the bound does not include.
- The built-in entries, the fallback header and the request rules are pinned to SDK 1.1.0 and API version 2026-10-21. Two points are still open in the source app. One is whether `fallbacks: "default"` together with `output_config.format` is valid for every fallback target. The other is the prices of fallback models, which are not loaded, so those calls are counted at the upper bound.
- The worst case covers one attempt. If a model refuses midway through a stream and the fallback continues, a cut after that can exceed the bound by the second attempt.
- An abort that fires while the connection is still opening is counted as a cut at the worst case, even though nothing was sent. The error goes toward overcounting.
- Two features of the source app were left out: a daily count cap for one task, and extra ids on ledger rows.
- Prices in the tests are fixtures for checkable arithmetic. The built-in registry prices are as listed on 2026-11-03; check the current pricing page before relying on a computed cost.
