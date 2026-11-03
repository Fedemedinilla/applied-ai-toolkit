/**
 * Gateway dependencies for tests: the in-memory stores (src/memory-store.ts) wrapped with failure
 * injection and call recording, a clock that moves only when read, and logs that collect events.
 * Every id, task and number here is a fixture.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { createGateway, type FailureEvent, type GatewayDeps, type NoticeEvent } from '../../src/gateway.ts';
import { createMemoryStores, type MemoryStores, type StoredUsageRow } from '../../src/memory-store.ts';
import type { Clock, LogData, UsageRow, UsageWindows } from '../../src/ports.ts';
import { fakeApi, type Responder } from './fake-claude.ts';

/** 2026-10-23 at noon in Buenos Aires. */
export const NOW = new Date('2026-10-23T15:00:00.000Z');
/** How far the fake clock moves each time it is read. */
export const CLOCK_STEP_MS = 250;
export const TIME_ZONE = 'America/Argentina/Buenos_Aires';

export const USER = '00000000-0000-4000-8000-000000000001';
export const OTHER_USER = '00000000-0000-4000-8000-000000000002';
export const JOB = '00000000-0000-4000-8000-0000000000a1';

export const TASKS = [
  { task: 'triage', model: 'claude-sonnet-5-5', effort: 'medium', hardCaseEffort: null },
  { task: 'extract', model: 'claude-fable-5-1', effort: 'medium', hardCaseEffort: 'high' },
  { task: 'draft', model: 'claude-fable-5-1', effort: 'medium', hardCaseEffort: null },
  { task: 'classify', model: 'claude-sonnet-5-5', effort: 'low', hardCaseEffort: null },
] as const;

export const GLOBAL_CAPS = { perJobUsd: 5, dailyPerUserUsd: 10, monthlyUsd: 60 };
export const NO_OWN_CAPS = { perJobUsd: null, dailyPerUserUsd: null };

/** Fixture prices in US$ per million tokens, so the arithmetic in the tests can be checked by hand. */
const FROM = '2026-10-01T00:00:00+00:00';
export const PRICES = [
  { model: 'claude-fable-5-1', validFrom: FROM, input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  { model: 'claude-sonnet-5-5', validFrom: FROM, input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  { model: 'claude-opus-5-5', validFrom: FROM, input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
];

/** A store failure, shaped like a driver error with a code. */
export class StoreError extends Error {
  readonly code: string;
  constructor(code: string, message = `store failed (${code})`) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

/** ok: stored. fail: throws without storing. store_then_fail: stores and throws, like an insert whose response was lost. */
export type RecordBehavior = 'ok' | 'fail' | 'store_then_fail';

export interface Harness {
  readonly stores: MemoryStores;
  /** Every row, reservations included, as in the SQL table. */
  readonly ledger: StoredUsageRow[];
  readonly calls: StoredUsageRow[];
  readonly openReservations: StoredUsageRow[];
  recordBehavior: RecordBehavior[];
  /** Runs with each row before it is recorded; may throw (for example, to abort mid-insert). */
  beforeRecord: ((row: UsageRow) => void) | null;
  readonly recordAttempts: UsageRow[];
  readonly windowsRequested: UsageWindows[];
  readonly readSignals: Array<AbortSignal | undefined>;
  /** globalCaps never answers until the call's signal fires, then fails like a driver would. */
  hangingReads: boolean;
  pricesError: Error | null;
  readonly notices: Array<{ readonly event: NoticeEvent; readonly data: LogData }>;
  readonly failures: Array<{ readonly event: FailureEvent; readonly data: LogData }>;
}

export function fakeDeps(client: Anthropic, options: { timeoutMs?: number; now?: Date } = {}): { deps: GatewayDeps; harness: Harness } {
  let now = (options.now ?? NOW).getTime();
  let mono = 0;
  // Wall clock and monotonic clock move separately: reading one does not change a duration.
  const clock: Clock = {
    now: () => {
      const date = new Date(now);
      now += CLOCK_STEP_MS;
      return date;
    },
    monotonicMs: () => {
      const value = mono;
      mono += CLOCK_STEP_MS;
      return value;
    },
  };
  const stores = createMemoryStores({
    tasks: TASKS,
    globalCaps: { ...GLOBAL_CAPS },
    accounts: { [USER]: { ...NO_OWN_CAPS }, [OTHER_USER]: { ...NO_OWN_CAPS } },
    prices: PRICES,
    clock,
  });
  const harness: Harness = {
    stores,
    get ledger() {
      return stores.usage.rows;
    },
    get calls() {
      return stores.usage.calls;
    },
    get openReservations() {
      return stores.usage.openReservations;
    },
    recordBehavior: [],
    beforeRecord: null,
    recordAttempts: [],
    windowsRequested: [],
    readSignals: [],
    hangingReads: false,
    pricesError: null,
    notices: [],
    failures: [],
  };
  const deps: GatewayDeps = {
    client,
    clock,
    timeZone: TIME_ZONE,
    timeoutMs: options.timeoutMs ?? 60_000,
    config: {
      taskConfig: (task, signal) => {
        harness.readSignals.push(signal);
        return stores.config.taskConfig(task, signal);
      },
      globalCaps: (signal) => {
        harness.readSignals.push(signal);
        if (!harness.hangingReads) return stores.config.globalCaps(signal);
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new StoreError('query_cancelled')));
        });
      },
      accountCaps: (userId, signal) => {
        harness.readSignals.push(signal);
        return stores.config.accountCaps(userId, signal);
      },
    },
    usage: {
      totalsForCaps: (windows, signal) => {
        harness.readSignals.push(signal);
        harness.windowsRequested.push(windows);
        return stores.usage.totalsForCaps(windows, signal);
      },
      record: async (row) => {
        harness.recordAttempts.push(row);
        harness.beforeRecord?.(row);
        const behavior = harness.recordBehavior.shift() ?? 'ok';
        if (behavior === 'fail') throw new StoreError('connection_failure');
        await stores.usage.record(row);
        if (behavior === 'store_then_fail') throw new StoreError('connection_failure');
      },
    },
    prices: {
      pricesFor: async (models, at) => {
        if (harness.pricesError) throw harness.pricesError;
        return stores.prices.pricesFor(models, at);
      },
    },
    notices: { log: (event, data) => void harness.notices.push({ event, data }) },
    failures: { log: (event, data) => void harness.failures.push({ event, data }) },
  };
  return { deps, harness };
}

/** A real gateway over the fake API and the instrumented stores. */
export function setup(responders: readonly Responder[], options: { timeoutMs?: number } = {}) {
  const api = fakeApi(responders);
  const { deps, harness } = fakeDeps(api.client, options);
  return { ...api, deps, harness, gateway: createGateway(deps) };
}

/** A row already in the ledger, to simulate earlier spend. */
export function earlierRow(partial: Partial<StoredUsageRow>): StoredUsageRow {
  return {
    id: crypto.randomUUID(),
    reservation: false,
    replaces: null,
    userId: USER,
    task: 'triage',
    jobId: null,
    effort: 'medium',
    promptVersion: 'earlier@1',
    modelRequested: 'claude-sonnet-5-5',
    modelResponded: 'claude-sonnet-5-5',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    thinkingTokens: null,
    costUsd: 0,
    stopReason: 'end_turn',
    refusalCategory: null,
    attempts: null,
    requestId: null,
    durationMs: 100,
    maxTokens: 1000,
    incomplete: false,
    estimatedInputTokens: null,
    errorCode: null,
    createdAt: NOW,
    ...partial,
  };
}
