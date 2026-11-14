/**
 * The stores over Postgres, on the schema in sql/schema.sql. The adapter needs no driver of its
 * own: it takes anything with `query(text, params)` that resolves to `{ rows }`, which is what
 * pg's Pool and Client, PGlite and a Supabase database reached through pg already are. postgres.js
 * needs a two-line wrapper (see the README).
 *
 * Every parameter is sent as text (or null) and cast in the SQL, `$1::text::uuid`. Drivers differ
 * in how they serialize numbers, dates, arrays and JSON, and they all agree on strings. Money
 * comes back as float8 and counts as integer, so every driver returns numbers; the gateway
 * validates each row with zod as it does for any store.
 *
 * Each method is one statement, so it works on a pool that hands out a different connection per
 * query. Nothing here opens a transaction. The reservation is atomic inside the database
 * (reserve_usage in sql/schema.sql explains the lock and the isolation level it needs).
 *
 * created_at is the database's now(), not the gateway's clock. The cap windows come from the
 * gateway's clock, so the two hosts have to agree on the time to within the usual NTP error.
 */
import type { RegistryPriceRow } from './models.ts';
import type { ConfigStore, PriceStore, UsageRow, UsageStore, UsageWindows } from './ports.ts';

/** The one method the adapter needs from a database client. */
export interface PgQueryable {
  query(text: string, params: unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
}

export interface PostgresStores {
  readonly config: ConfigStore;
  /** With reserve: the gateway writes each reservation through reserve_usage. */
  readonly usage: UsageStore & Required<Pick<UsageStore, 'reserve'>>;
  readonly prices: PriceStore;
  /**
   * Inserts price rows (a registry's priceRows(), or your own). A row whose model and validFrom
   * are already there is left as it is: prices are never edited, a new price is a new validFrom.
   */
  loadPrices(rows: readonly RegistryPriceRow[]): Promise<void>;
}

type Param = string | null;

const text = (value: string | number | boolean | null): Param => (value === null ? null : String(value));

const TOTALS_COLUMNS = `
  user_day_usd::float8 as "userDayUsd", user_day_unpriced as "userDayUnpriced", user_day_bound_usd::float8 as "userDayBoundUsd",
  month_usd::float8 as "monthUsd", month_unpriced as "monthUnpriced", month_bound_usd::float8 as "monthBoundUsd",
  job_usd::float8 as "jobUsd", job_unpriced as "jobUnpriced", job_bound_usd::float8 as "jobBoundUsd"`;

const TOTALS = `select ${TOTALS_COLUMNS}
  from public.usage_for_caps($1::text::timestamptz, $2::text::timestamptz, $3::text::uuid, $4::text::uuid, $5::text::uuid)`;

const RESERVE = `select ${TOTALS_COLUMNS}
  from public.reserve_usage($1::text::uuid, $2::text::uuid, $3::text, $4::text::uuid, $5::text::public.llm_effort, $6::text, $7::text,
    $8::text::integer, $9::text::integer, $10::text::timestamptz, $11::text::timestamptz)`;

// on conflict (id) do nothing: the gateway retries a failed insert once with the same id, and an
// insert whose response was lost must not fail the retry. A second closing row for the same
// reservation has another id and still fails on llm_usage_replaces_key.
const RECORD = `insert into public.llm_usage (
    id, reservation, replaces, user_id, task, job_id, effort, prompt_version, model_requested, model_responded,
    input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, thinking_tokens,
    cost_usd, stop_reason, refusal_category, attempts, request_id, duration_ms, max_tokens, incomplete,
    estimated_input_tokens, error_code
  ) values (
    $1::text::uuid, $2::text::boolean, $3::text::uuid, $4::text::uuid, $5::text, $6::text::uuid, $7::text::public.llm_effort, $8::text, $9::text, $10::text,
    $11::text::integer, $12::text::integer, $13::text::integer, $14::text::integer, $15::text::integer, $16::text::integer,
    $17::text::numeric, $18::text, $19::text, $20::text::jsonb, $21::text, $22::text::integer, $23::text::integer, $24::text::boolean,
    $25::text::integer, $26::text
  ) on conflict (id) do nothing`;

const TASK_CONFIG = `select task, model, effort::text as effort, hard_case_effort::text as "hardCaseEffort"
  from public.llm_task_config where task = $1::text`;

const GLOBAL_CAPS = `select per_job_usd::float8 as "perJobUsd", daily_per_user_usd::float8 as "dailyPerUserUsd", monthly_usd::float8 as "monthlyUsd"
  from public.llm_global_caps`;

const ACCOUNT_CAPS = `select per_job_usd::float8 as "perJobUsd", daily_per_user_usd::float8 as "dailyPerUserUsd"
  from public.llm_account_caps where user_id = $1::text::uuid`;

// The model list travels as a JSON array in one text parameter: array parameters are where
// drivers differ most. to_json writes the timestamp as ISO 8601, which Date.parse reads.
const PRICES = `select model, to_json(valid_from) #>> '{}' as "validFrom", input::float8 as input, output::float8 as output,
    cache_read::float8 as "cacheRead", cache_write_5m::float8 as "cacheWrite5m", cache_write_1h::float8 as "cacheWrite1h"
  from public.model_prices
  where model in (select jsonb_array_elements_text($1::text::jsonb)) and valid_from <= $2::text::timestamptz`;

const LOAD_PRICE = `insert into public.model_prices (model, valid_from, input, output, cache_read, cache_write_5m, cache_write_1h, source)
  values ($1::text, $2::text::timestamptz, $3::text::numeric, $4::text::numeric, $5::text::numeric, $6::text::numeric, $7::text::numeric, $8::text)
  on conflict (model, valid_from) do nothing`;

function recordParams(row: UsageRow): Param[] {
  return [
    row.id,
    text(row.reservation),
    row.replaces,
    row.userId,
    row.task,
    row.jobId,
    row.effort,
    row.promptVersion,
    row.modelRequested,
    row.modelResponded,
    text(row.inputTokens),
    text(row.outputTokens),
    text(row.cacheReadTokens),
    text(row.cacheWrite5mTokens),
    text(row.cacheWrite1hTokens),
    text(row.thinkingTokens),
    text(row.costUsd),
    row.stopReason,
    row.refusalCategory,
    row.attempts === null ? null : JSON.stringify(row.attempts),
    row.requestId,
    text(row.durationMs),
    text(row.maxTokens),
    text(row.incomplete),
    text(row.estimatedInputTokens),
    row.errorCode,
  ];
}

export function createPostgresStores(db: PgQueryable): PostgresStores {
  /**
   * A read under the call's signal. The minimal client has no way to cancel a query, so a cut
   * rejects here and the query finishes on its own; these are reads, and nothing is lost.
   */
  async function read(sql: string, params: Param[], signal: AbortSignal | undefined): Promise<readonly unknown[]> {
    signal?.throwIfAborted();
    if (signal === undefined) return (await db.query(sql, params)).rows;
    const { promise: cut, reject } = Promise.withResolvers<never>();
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const query = db.query(sql, params);
      // If the cut wins, the query's own failure later has nowhere to go: mark it as handled.
      query.catch(() => undefined);
      return (await Promise.race([query, cut])).rows;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  const first = (rows: readonly unknown[]): unknown => rows[0] ?? null;

  return {
    config: {
      taskConfig: async (task, signal) => first(await read(TASK_CONFIG, [task], signal)),
      globalCaps: async (signal) => first(await read(GLOBAL_CAPS, [], signal)),
      accountCaps: async (userId, signal) => first(await read(ACCOUNT_CAPS, [userId], signal)),
    },
    usage: {
      totalsForCaps: async (windows: UsageWindows, signal) =>
        first(await read(TOTALS, [windows.dayStart.toISOString(), windows.monthStart.toISOString(), windows.userId, windows.jobId, windows.excludeId ?? null], signal)),
      record: async (row) => {
        await db.query(RECORD, recordParams(row));
      },
      reserve: async (row, windows) => {
        const params: Param[] = [
          row.id,
          row.userId,
          row.task,
          row.jobId,
          row.effort,
          row.promptVersion,
          row.modelRequested,
          text(row.maxTokens),
          text(row.estimatedInputTokens),
          windows.dayStart.toISOString(),
          windows.monthStart.toISOString(),
        ];
        return first((await db.query(RESERVE, params)).rows);
      },
    },
    prices: {
      pricesFor: async (models, at) => (await db.query(PRICES, [JSON.stringify(models), at.toISOString()])).rows,
    },
    loadPrices: async (rows) => {
      for (const row of rows) {
        const params: Param[] = [row.model, row.validFrom, text(row.input), text(row.output), text(row.cacheRead), text(row.cacheWrite5m), text(row.cacheWrite1h), row.source];
        await db.query(LOAD_PRICE, params);
      }
    },
  };
}
