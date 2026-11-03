/**
 * In-memory stores with the same semantics as the reference SQL schema (sql/schema.sql). Used by
 * the tests and the example; a single process is the only scope where they are correct.
 *
 * MemoryUsageStore.totalsForCaps mirrors the SQL function usage_for_caps:
 * - a reservation closed by another row is not counted, so each call counts once;
 * - an open reservation counts in the bound but not in the unpriced call counts;
 * - every row without a cost gets an upper bound: its measured tokens and, if incomplete, the
 *   estimated input at the input price and max_tokens at the output price. An incomplete row whose
 *   responding model has a price in force uses that price; anything else uses the highest price in
 *   force for each token type, with cache reads floored at 0.1x the highest input price.
 * - with `excludeId`, that row is left out (the gateway's second cap check leaves out its own
 *   reservation; p_exclude_id in SQL).
 * MemoryUsageStore.record enforces every check constraint of llm_usage, the foreign key and the
 * unique index, under the SQL names, so a gateway bug that writes an inconsistent row fails in
 * tests the way it would fail against Postgres. Column types (integer, numeric(12, 6), the effort
 * enum) are left to UsageRow's TypeScript types.
 */
import { z } from 'zod';
import { PriceRow, pricesInForce, type Price } from './cost.ts';
import { systemClock, type Clock, type ConfigStore, type PriceStore, type UsageRow, type UsageStore, type UsageWindows } from './ports.ts';
import type { UsageTotals } from './config.ts';

/** A ledger row with the time the store wrote it (now() in SQL). The caps' windows use this time. */
export type StoredUsageRow = UsageRow & { readonly createdAt: Date };

/** A row the SQL schema would reject. */
export class ConstraintViolation extends Error {
  readonly code = 'constraint_violation';
  constructor(constraint: string, rowId: string) {
    super(`Row ${rowId} violates ${constraint}`);
    this.name = 'ConstraintViolation';
  }
}

export class MemoryConfigStore implements ConfigStore {
  readonly tasks = new Map<string, unknown>();
  global: unknown = null;
  readonly accounts = new Map<string, unknown>();

  async taskConfig(task: string, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    return this.tasks.get(task) ?? null;
  }

  async globalCaps(signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    return this.global;
  }

  async accountCaps(userId: string, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    return this.accounts.get(userId) ?? null;
  }
}

export class MemoryPriceStore implements PriceStore {
  /** Unvalidated on purpose: tests put malformed rows here to exercise the gateway's validation. */
  rows: unknown[] = [];

  async pricesFor(models: readonly string[], at: Date): Promise<unknown> {
    const wanted = new Set(models);
    return this.rows.filter((row) => {
      const parsed = PriceRow.safeParse(row);
      // Malformed rows go back as they are, for the gateway to reject.
      if (!parsed.success) return true;
      return wanted.has(parsed.data.model) && Date.parse(parsed.data.validFrom) <= at.getTime();
    });
  }

  /** Prices in force now, for the bound. Malformed rows are ignored, as a typed SQL table would never hold them. */
  inForce(at: Date): ReadonlyMap<string, Price> {
    const valid = this.rows.flatMap((row) => {
      const parsed = PriceRow.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
    return pricesInForce(valid, at);
  }
}

/** Highest price of each token type among those in force, or null if none is (as in SQL). */
function highestPrice(prices: ReadonlyMap<string, Price>): Price | null {
  const all = [...prices.values()];
  if (all.length === 0) return null;
  const max = (field: keyof Price) => Math.max(...all.map((p) => p[field]));
  return {
    input: max('input'),
    output: max('output'),
    // A fallback model without a price may read cache at 0.1x its input; this floor covers it.
    cacheRead: Math.max(max('cacheRead'), 0.1 * max('input')),
    cacheWrite5m: max('cacheWrite5m'),
    cacheWrite1h: max('cacheWrite1h'),
  };
}

const roundUsd = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000;
const tokenColumns = (row: UsageRow) => [row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWrite5mTokens, row.cacheWrite1hTokens];

export class MemoryUsageStore implements UsageStore {
  readonly rows: StoredUsageRow[] = [];
  readonly #prices: MemoryPriceStore;
  readonly #clock: Clock;

  constructor(prices: MemoryPriceStore, clock: Clock = systemClock) {
    this.#prices = prices;
    this.#clock = clock;
  }

  /** Rows that are not reservations: one per finished or cut call. */
  get calls(): StoredUsageRow[] {
    return this.rows.filter((row) => !row.reservation);
  }

  /** Reservations no row has closed: calls in flight, or calls whose closing row failed. */
  get openReservations(): StoredUsageRow[] {
    const closed = new Set(this.rows.map((row) => row.replaces).filter((id) => id !== null));
    return this.rows.filter((row) => row.reservation && !closed.has(row.id));
  }

  async record(row: UsageRow): Promise<void> {
    // Same id twice: the first insert went through and its response was lost. Not an error.
    if (this.rows.some((existing) => existing.id === row.id)) return;
    this.#check(row);
    this.rows.push({ ...row, createdAt: this.#clock.now() });
  }

  /** The check constraints and the unique index of sql/schema.sql. */
  #check(row: UsageRow): void {
    const fail = (constraint: string): never => {
      throw new ConstraintViolation(constraint, row.id);
    };
    const noTokens = tokenColumns(row).every((t) => t === 0);
    const blank = (text: string) => text.trim() === '';
    const negative = (n: number | null) => n !== null && (!Number.isInteger(n) || n < 0);
    if (blank(row.task)) fail('llm_usage_task_not_blank');
    if (blank(row.promptVersion)) fail('llm_usage_prompt_version_not_blank');
    if (blank(row.modelRequested)) fail('llm_usage_model_requested_not_blank');
    if (row.errorCode !== null && blank(row.errorCode)) fail('llm_usage_error_code_not_blank');
    if (tokenColumns(row).some(negative)) fail('llm_usage_tokens_nonnegative');
    if (negative(row.thinkingTokens)) fail('llm_usage_thinking_nonnegative');
    if (negative(row.durationMs)) fail('llm_usage_duration_nonnegative');
    if (negative(row.estimatedInputTokens)) fail('llm_usage_estimated_input_nonnegative');
    if (!Number.isInteger(row.maxTokens) || row.maxTokens <= 0) fail('llm_usage_max_tokens_positive');
    if (row.costUsd !== null && row.costUsd < 0) fail('llm_usage_cost_nonnegative');
    if (row.attempts !== null && !Array.isArray(row.attempts)) fail('llm_usage_attempts_is_array');
    if (row.reservation && !(row.incomplete && row.modelResponded === null && row.durationMs === null && row.replaces === null && row.errorCode === null && noTokens)) {
      fail('llm_usage_reservation_unmeasured');
    }
    if (row.incomplete && row.costUsd !== null) fail('llm_usage_incomplete_without_cost');
    if (row.estimatedInputTokens !== null && !row.incomplete) fail('llm_usage_estimate_only_if_incomplete');
    if (!(row.incomplete || row.modelResponded !== null || (row.errorCode !== null && row.costUsd === 0 && noTokens))) {
      fail('llm_usage_model_responded_if_consumed');
    }
    if (row.replaces !== null) {
      if (row.replaces === row.id) fail('llm_usage_replaces_other');
      if (!this.rows.some((existing) => existing.id === row.replaces)) fail('llm_usage_replaces_fkey');
      if (this.rows.some((existing) => existing.replaces === row.replaces)) fail('llm_usage_replaces_key');
    }
  }

  async totalsForCaps(windows: UsageWindows, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    return computeTotals(this.rows, windows, this.#prices.inForce(this.#clock.now()));
  }
}

/** usage_for_caps over an array of rows: a pure function, so the cap arithmetic can be read apart from the store. */
function computeTotals(all: readonly StoredUsageRow[], w: UsageWindows, inForce: ReadonlyMap<string, Price>): UsageTotals {
  const closed = new Set(all.map((row) => row.replaces).filter((id) => id !== null));
  const rows = all.filter((row) => !closed.has(row.id) && row.id !== w.excludeId);
  const highest = highestPrice(inForce);
  const cost = (subset: readonly StoredUsageRow[]) => roundUsd(subset.reduce((total, row) => total + (row.costUsd ?? 0), 0));
  // Calls that ended without a cost. An open reservation counts in the bound, not here.
  const unpriced = (subset: readonly StoredUsageRow[]) => subset.filter((row) => row.costUsd === null && !row.reservation).length;
  const bound = (subset: readonly StoredUsageRow[]): number | null => {
    const withoutCost = subset.filter((row) => row.costUsd === null);
    if (withoutCost.length === 0) return 0;
    if (highest === null) return null;
    const perMillion = withoutCost.reduce((total, row) => {
      const own = row.incomplete && row.modelResponded !== null ? inForce.get(row.modelResponded) : undefined;
      const p = own ?? highest;
      return (
        total +
        row.inputTokens * p.input +
        row.outputTokens * p.output +
        row.cacheReadTokens * p.cacheRead +
        row.cacheWrite5mTokens * p.cacheWrite5m +
        row.cacheWrite1hTokens * p.cacheWrite1h +
        (row.incomplete ? (row.estimatedInputTokens ?? 0) * p.input + row.maxTokens * p.output : 0)
      );
    }, 0);
    return roundUsd(perMillion / 1_000_000);
  };
  const userDay = w.userId === null ? null : rows.filter((row) => row.userId === w.userId && row.createdAt >= w.dayStart);
  const month = rows.filter((row) => row.createdAt >= w.monthStart);
  const job = w.jobId === null ? null : rows.filter((row) => row.jobId === w.jobId);
  return {
    userDayUsd: userDay && cost(userDay),
    userDayUnpriced: userDay && unpriced(userDay),
    userDayBoundUsd: userDay && bound(userDay),
    monthUsd: cost(month),
    monthUnpriced: unpriced(month),
    monthBoundUsd: bound(month),
    jobUsd: job && cost(job),
    jobUnpriced: job && unpriced(job),
    jobBoundUsd: job && bound(job),
  };
}

export interface MemoryStores {
  readonly config: MemoryConfigStore;
  readonly prices: MemoryPriceStore;
  readonly usage: MemoryUsageStore;
}

export interface MemorySeed {
  readonly tasks?: readonly unknown[];
  readonly globalCaps?: unknown;
  readonly accounts?: Readonly<Record<string, unknown>>;
  readonly prices?: readonly unknown[];
  readonly clock?: Clock;
}

const TaskKey = z.object({ task: z.string() });

export function createMemoryStores(seed: MemorySeed = {}): MemoryStores {
  const config = new MemoryConfigStore();
  for (const row of seed.tasks ?? []) {
    const key = TaskKey.safeParse(row);
    if (key.success) config.tasks.set(key.data.task, row);
  }
  config.global = seed.globalCaps ?? null;
  for (const [userId, caps] of Object.entries(seed.accounts ?? {})) config.accounts.set(userId, caps);
  const prices = new MemoryPriceStore();
  prices.rows = [...(seed.prices ?? [])];
  return { config, prices, usage: new MemoryUsageStore(prices, seed.clock) };
}
