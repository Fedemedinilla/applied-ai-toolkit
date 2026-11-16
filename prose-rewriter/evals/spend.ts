/**
 * What the eval runs spend, and the budget that stops them (design 4.10 "Costo" and D14).
 *
 * Federico fixed the budget of every real-model eval run at US$20 a month (D14, 16/11/2026), paid
 * from his prepaid credits. The gateway's caps cannot hold it: the CLI builds the gateway over
 * in-memory stores that start from zero on every run (prose-rewriter/cli.ts). So the budget lives
 * here, in a ledger file outside the repository that every run reads and writes:
 *
 * - openLedger(): a JSON file (by default ~/.applied-ai-toolkit/eval-spend.json) keyed by calendar
 *   month in Buenos Aires. Amounts are whole micro-dollars, the precision of the gateway's
 *   costUsd, so sums do not drift. Every operation reads the file again and writes it whole
 *   through a temp file and a rename, so a crash leaves the old file or the new one, never half.
 *   A reservation and a settlement each hold a lock file next to the ledger (created with O_EXCL)
 *   from the read to the rename, so two runs at once (two terminals, a run next to a CI job)
 *   neither pass the cap together nor overwrite each other's spend. A lock older than
 *   LOCK_STALE_MS was left by a run that died holding it and is taken over; a lock that stays
 *   fresh past LOCK_WAIT_MS refuses the call. A file it cannot parse is an error, never
 *   overwritten: the budget fails closed.
 * - budgetedGateway(): before every call it reserves the call's worst case (estimateInputTokens of
 *   the request at the highest input rate of the model, plus maxTokens at its output rate) and
 *   refuses the call if the month's spend plus that reservation would pass the cap, or the run's
 *   would pass --max-usd. A model with no price is refused. After the call the reservation settles
 *   to the measured costUsd. A reservation that never settles (the process died) keeps counting at
 *   its worst case.
 * - costRows() and costReport(): the cost table of design 4.10 step 4, next to gateMarkdown.
 *
 * Refusals (a cap, a missing price, a ledger it cannot read or write) are SpendRefusal, a CapError, so runPipelines() and judgePieces() stop the run on the
 * first one instead of failing every later piece the same way.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { z } from 'zod';
import {
  ApiError,
  CapError,
  ConfigError,
  costUsd,
  estimateInputTokens,
  RequestError,
  ReservationError,
  ResponseError,
  structuredFormat,
  type Gateway,
  type GatewayRequest,
  type Price,
  type TaskConfig,
} from '../../gateway/src/index.ts';
import { TASK_CONFIGS } from '../src/tasks.ts';
import type { PieceRecord } from './pipeline.ts';

/** D14: the monthly budget of all real-model eval runs, in US$. Raising it is Federico's call, made here. */
export const MONTHLY_BUDGET_USD = 20;

/** The months follow Federico's calendar, as the gateway's caps do (prose-rewriter/cli.ts). */
export const SPEND_TIME_ZONE = 'America/Argentina/Buenos_Aires';

export const LEDGER_FORMAT = 'prose-rewriter-eval-spend@1';

/** Outside the repository, so no commit carries it and no checkout resets it. */
export function defaultLedgerPath(home: string = homedir()): string {
  return join(home, '.applied-ai-toolkit', 'eval-spend.json');
}

export interface Clock {
  now(): Date;
}

/** "YYYY-MM" of `at` in `timeZone`. */
export function spendMonth(at: Date, timeZone: string = SPEND_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(at);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}`;
}

/** Why a call was refused before it reached the gateway. */
export type RefusalReason = 'monthly' | 'run' | 'unpriced' | 'ledger';

/** A call refused by the budget. The API was not called. A CapError, so a run stops on it. */
export class SpendRefusal extends CapError {
  readonly reason: RefusalReason;
  constructor(reason: RefusalReason, spentUsd: number, capUsd: number, message: string, options?: ErrorOptions) {
    super('cap_monthly_global', spentUsd, capUsd);
    if (options?.cause !== undefined) this.cause = options.cause;
    this.reason = reason;
    this.message = message;
  }
}

const MICROS = 1_000_000;
const micros = (usd: number): number => Math.round(usd * MICROS);
const usd = (m: number): number => m / MICROS;

interface MonthEntry {
  settledMicros: number;
  calls: number;
  open: Record<string, { micros: number; at: string }>;
}

interface LedgerFile {
  format: typeof LEDGER_FORMAT;
  months: Record<string, MonthEntry>;
}

/** A lock this old was left by a process that died holding it: one ledger write takes milliseconds. */
export const LOCK_STALE_MS = 10_000;
/** How long a reservation or a settlement waits for another run's lock before it gives up. */
export const LOCK_WAIT_MS = 5_000;

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Runs `fn` while holding `${path}.lock`. Synchronous, like the ledger operations it wraps. */
function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let age: number;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (age > LOCK_STALE_MS) {
      rmSync(lock, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`spend ledger ${path} is locked by another run (${lock}); retry when it ends, or delete the lock file if no run is going`);
    sleep(2 + Math.floor(Math.random() * 8));
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

const isCount =(v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function parseLedger(raw: string, path: string): LedgerFile {
  const bad = (why: string): never => {
    throw new Error(`spend ledger ${path} is not readable (${why}); fix or move it by hand, the eval runs stay stopped until then`);
  };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return bad('not JSON');
  }
  if (typeof json !== 'object' || json === null || (json as { format?: unknown }).format !== LEDGER_FORMAT) return bad(`format is not ${LEDGER_FORMAT}`);
  const months = (json as { months?: unknown }).months;
  if (typeof months !== 'object' || months === null) return bad('no months');
  for (const [key, entry] of Object.entries(months)) {
    if (!/^\d{4}-\d{2}$/.test(key)) bad(`month ${key}`);
    const e = entry as Partial<MonthEntry> | null;
    if (e === null || !isCount(e.settledMicros) || !isCount(e.calls) || typeof e.open !== 'object' || e.open === null) bad(`month ${key}`);
    for (const r of Object.values(e!.open!)) if (!isCount(r?.micros)) bad(`an open reservation of ${key}`);
  }
  return json as LedgerFile;
}

export interface LedgerOptions {
  readonly path: string;
  /** At most MONTHLY_BUDGET_USD: a run may lower the cap, never raise it. */
  readonly monthlyCapUsd: number;
  readonly clock: Clock;
  readonly timeZone?: string;
}

export interface Reservation {
  readonly id: string;
  readonly month: string;
  readonly micros: number;
}

export interface MonthSpend {
  readonly month: string;
  /** Settled plus open reservations. */
  readonly spentUsd: number;
  readonly settledUsd: number;
  readonly openUsd: number;
  /** Settled calls. */
  readonly calls: number;
  readonly capUsd: number;
  readonly remainingUsd: number;
}

export interface SpendLedger {
  readonly path: string;
  readonly clock: Clock;
  readonly capUsd: number;
  month(at?: Date): MonthSpend;
  /** Throws SpendRefusal if the month's spend plus `worstUsd` would pass the cap. */
  reserve(worstUsd: number): Reservation;
  /** Replaces the reservation with what the call cost, in the month it was made in. */
  settle(r: Reservation, costUsd: number): void;
}

export function openLedger(options: LedgerOptions): SpendLedger {
  const { path, clock } = options;
  const cap = options.monthlyCapUsd;
  if (!(Number.isFinite(cap) && cap > 0)) throw new Error(`the monthly cap must be a positive number of US$, got ${cap}`);
  if (cap > MONTHLY_BUDGET_USD) throw new Error(`the monthly cap is at most US$${MONTHLY_BUDGET_USD} (D14); raising it is Federico's decision, made in MONTHLY_BUDGET_USD`);
  const capMicros = micros(cap);
  const zone = options.timeZone ?? SPEND_TIME_ZONE;

  const read = (): LedgerFile => {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { format: LEDGER_FORMAT, months: {} };
      throw error;
    }
    return parseLedger(raw, path);
  };
  const write = (file: LedgerFile): void => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  };
  const entry = (file: LedgerFile, month: string): MonthEntry => (file.months[month] ??= { settledMicros: 0, calls: 0, open: {} });
  const openMicros = (e: MonthEntry): number => Object.values(e.open).reduce((s, r) => s + r.micros, 0);
  const summary = (month: string, e: MonthEntry | undefined): MonthSpend => {
    const settled = e?.settledMicros ?? 0;
    const open = e === undefined ? 0 : openMicros(e);
    return { month, spentUsd: usd(settled + open), settledUsd: usd(settled), openUsd: usd(open), calls: e?.calls ?? 0, capUsd: cap, remainingUsd: usd(Math.max(0, capMicros - settled - open)) };
  };

  return {
    path,
    clock,
    capUsd: cap,
    month(at = clock.now()) {
      const month = spendMonth(at, zone);
      return summary(month, read().months[month]);
    },
    reserve(worstUsd) {
      if (!(Number.isFinite(worstUsd) && worstUsd >= 0)) throw new Error(`a reservation is a US$ amount from 0 up, got ${worstUsd}`);
      return withLock(path, () => {
        const file = read();
        const month = spendMonth(clock.now(), zone);
        const e = entry(file, month);
        const spent = e.settledMicros + openMicros(e);
        const m = micros(worstUsd);
        if (spent + m > capMicros) {
          throw new SpendRefusal('monthly', usd(spent), cap, `Refused: the call's worst case of US$${usd(m)} would take ${month} past the monthly budget of US$${cap} (US$${usd(spent)} spent or reserved)`);
        }
        const id = randomUUID();
        e.open[id] = { micros: m, at: clock.now().toISOString() };
        write(file);
        return { id, month, micros: m };
      });
    },
    settle(r, cost) {
      if (!(Number.isFinite(cost) && cost >= 0)) throw new Error(`a settled cost is a US$ amount from 0 up, got ${cost}`);
      withLock(path, () => {
        const file = read();
        const e = entry(file, r.month);
        delete e.open[r.id];
        e.settledMicros += micros(cost);
        e.calls += 1;
        write(file);
      });
    },
  };
}

/** The model a request runs on: its own config, or its task's. Null for a task with no config. */
export function modelFor(request: Pick<GatewayRequest<string>, 'task' | 'config'>): string | null {
  return request.config?.model ?? (TASK_CONFIGS as Readonly<Record<string, TaskConfig | undefined>>)[request.task]?.model ?? null;
}

/** An upper bound on the request's input tokens, as the gateway reserves it (gateway.ts, reserve). */
export function requestInputTokens(request: GatewayRequest<string>, schema: z.ZodType | null): number {
  const format = schema === null ? null : structuredFormat(schema).format;
  return (
    estimateInputTokens({
      ...(request.system.length > 0 ? { system: request.system.map((text) => ({ type: 'text' as const, text, cache_control: { type: 'ephemeral' as const } })) } : {}),
      messages: [...request.messages],
      ...(format === null ? {} : { output_config: { format } }),
    }) + (request.attachmentTokenBound ?? 0)
  );
}

/**
 * The most a call can cost on `model`: every input token at the dearest input rate (plain, cache
 * write 5 m or 1 h) and the whole output budget. Priced by the gateway's costUsd. Null with no price.
 */
export function worstCaseUsd(model: string, inputTokens: number, maxTokens: number, prices: ReadonlyMap<string, Price>): number | null {
  const at = (bucket: 'input' | 'cacheWrite5m' | 'cacheWrite1h') =>
    costUsd([{ kind: 'single', model, input: 0, output: maxTokens, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, [bucket]: inputTokens }], prices).usd;
  const all = [at('input'), at('cacheWrite5m'), at('cacheWrite1h')];
  return all.some((c) => c === null) ? null : Math.max(...(all as number[]));
}

/** What a failed call cost: nothing when it is known not to have reached the API, else its worst case. */
function billedOnError(error: unknown, worst: number): number {
  if (error instanceof ResponseError) return error.costUsd ?? worst;
  if (error instanceof ApiError) return error.usageId === null ? 0 : worst;
  if (error instanceof CapError || error instanceof ConfigError || error instanceof RequestError || error instanceof ReservationError) return 0;
  return worst;
}

export interface BudgetOptions {
  readonly ledger: SpendLedger;
  /** The prices in force at a date (pricesInForce over the gateway's price rows). */
  readonly prices: (at: Date) => ReadonlyMap<string, Price>;
  /** The per-run cap (--max-usd), or null for none. */
  readonly maxRunUsd: number | null;
}

export interface RunSpend {
  readonly spentUsd: number;
  readonly openUsd: number;
  readonly calls: number;
}

export interface BudgetedGateway {
  readonly gateway: Gateway<string>;
  run(): RunSpend;
}

export function budgetedGateway(inner: Gateway<string>, options: BudgetOptions): BudgetedGateway {
  const { ledger } = options;
  const run = { settled: 0, open: 0, calls: 0 };

  const reserve = (request: GatewayRequest<string>, schema: z.ZodType | null): { r: Reservation; worst: number } => {
    const model = modelFor(request);
    if (model === null) throw new SpendRefusal('unpriced', 0, 0, `Refused: no model for task ${request.task}, so no price`);
    const worst = worstCaseUsd(model, requestInputTokens(request, schema), request.maxTokens, options.prices(ledger.clock.now()));
    if (worst === null) throw new SpendRefusal('unpriced', 0, 0, `Refused: no price for ${model}; a call that cannot be priced is never made`);
    const max = options.maxRunUsd;
    if (max !== null && run.settled + run.open + micros(worst) > micros(max)) {
      throw new SpendRefusal('run', usd(run.settled + run.open), max, `Refused: the call's worst case of US$${worst} would take this run past its per-run cap of US$${max}`);
    }
    let r: Reservation;
    try {
      r = ledger.reserve(worst);
    } catch (error) {
      if (error instanceof SpendRefusal) throw error;
      // A ledger that cannot be read or written cannot hold the budget: no call, and the run stops.
      throw new SpendRefusal('ledger', 0, ledger.capUsd, `Refused: ${(error as Error).message}`, { cause: error });
    }
    run.open += r.micros;
    return { r, worst };
  };
  const settle = (held: { r: Reservation }, cost: number): void => {
    run.open -= held.r.micros;
    run.settled += micros(cost);
    run.calls += 1;
    ledger.settle(held.r, cost);
  };
  const guard = async <R extends { readonly meta: { readonly costUsd: number | null } }>(request: GatewayRequest<string>, schema: z.ZodType | null, call: () => Promise<R>): Promise<R> => {
    const held = reserve(request, schema);
    let result: R;
    try {
      result = await call();
    } catch (error) {
      settle(held, billedOnError(error, held.worst));
      throw error;
    }
    // A call the gateway could not price keeps its worst case: never an invented lower number.
    settle(held, result.meta.costUsd ?? held.worst);
    return result;
  };

  return {
    gateway: {
      structured: (schema, request) => guard(request, schema, () => inner.structured(schema, request)),
      structuredStream: (schema, request) => {
        let held: { r: Reservation; worst: number };
        try {
          held = reserve(request, schema);
        } catch (error) {
          const final = Promise.reject(error);
          final.catch(() => undefined);
          return { started: Promise.resolve(), final };
        }
        const call = inner.structuredStream(schema, request);
        const final = call.final.then(
          (result) => {
            settle(held, result.meta.costUsd ?? held.worst);
            return result;
          },
          (error: unknown) => {
            settle(held, billedOnError(error, held.worst));
            throw error;
          },
        );
        return { started: call.started, final };
      },
      text: (request) => guard(request, null, () => inner.text(request)),
    },
    run: () => ({ spentUsd: usd(run.settled), openUsd: usd(run.open), calls: run.calls }),
  };
}

/** One row of the cost table: the pieces of one variant, genre and mode. */
export interface CostRow {
  readonly variant: string;
  readonly genre: string;
  readonly mode: string;
  readonly pieces: number;
  /** Pieces whose every call had a price; the percentiles read only these. */
  readonly priced: number;
  readonly medianUsd: number | null;
  readonly p90Usd: number | null;
  /** Cache reads over all input tokens; null with no input measured. */
  readonly cacheHitRate: number | null;
  readonly callsPerRewrite: number;
  readonly extraRoundShare: number;
}

const round6 = (x: number): number => Math.round(x * MICROS) / MICROS;

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : round6((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Nearest rank. */
const p90 = (sorted: readonly number[]): number => sorted[Math.ceil(0.9 * sorted.length) - 1]!;

/** Design 4.10 step 4, per variant, genre and mode, in the order the pieces first show them. */
export function costRows(pieces: readonly PieceRecord[]): CostRow[] {
  const groups = new Map<string, PieceRecord[]>();
  for (const p of pieces) {
    const k = `${p.variant}\0${p.genre}\0${p.mode}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const costs = group.flatMap((p) => (p.usage.costUsd === null ? [] : [p.usage.costUsd])).sort((a, b) => a - b);
    let read = 0;
    let input = 0;
    for (const { tokens: t } of group.map((p) => p.usage)) {
      read += t.cacheRead;
      input += t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
    }
    const n = group.length;
    return {
      variant: first.variant,
      genre: first.genre,
      mode: first.mode,
      pieces: n,
      priced: costs.length,
      medianUsd: costs.length === 0 ? null : median(costs),
      p90Usd: costs.length === 0 ? null : p90(costs),
      cacheHitRate: input === 0 ? null : read / input,
      callsPerRewrite: group.reduce((s, p) => s + p.usage.calls, 0) / n,
      extraRoundShare: group.filter((p) => p.usage.extraRound).length / n,
    };
  });
}

const money = (x: number | null): string => (x === null ? 'n/a' : x.toFixed(4));
const share = (x: number | null): string => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);

/** The cost table as Markdown, to print next to gateMarkdown. */
export function costReport(rows: readonly CostRow[]): string {
  return [
    '### Cost per rewrite',
    '',
    'Measured on the gateway per piece (pipeline or single call; the judges are not in it). Percentiles read the priced pieces only.',
    '',
    '| variant | genre | mode | pieces | priced | median US$ | p90 US$ | cache hit | calls per rewrite | extra round |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map(
      (r) =>
        `| ${r.variant} | ${r.genre} | ${r.mode} | ${r.pieces} | ${r.priced} | ${money(r.medianUsd)} | ${money(r.p90Usd)} | ${share(r.cacheHitRate)} | ${r.callsPerRewrite.toFixed(2)} | ${share(r.extraRoundShare)} |`,
    ),
  ].join('\n');
}
