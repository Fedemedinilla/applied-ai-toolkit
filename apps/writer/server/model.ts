// The gateway the writer calls through, with its in-memory stores and a monthly cap. The gateway
// is the only code that talks to the API: this file passes it a key, a fetch (a fake one in the
// tests) and the numbers below, and never builds a request itself.

import {
  createClaudeClient,
  createGateway,
  createMemoryStores,
  jsonLinesLog,
  systemClock,
  type ClaudeClientOptions,
  type Clock,
  type Gateway,
  type MemoryStores,
} from '../../../gateway/src/index.ts';

export const TASK = 'writer-draft';
export const MODEL = 'claude-sonnet-5-5';
/** Prose that follows a style guide: more than a classification, far from a hard problem. */
export const EFFORT = 'medium';
/** Thinking comes out of this budget too. The longest category allows 1,300 characters per language. */
export const MAX_TOKENS = 4000;
/** US$ per calendar month for the whole deploy. A reached cap answers cap_reached without a call. */
export const MONTHLY_CAP_USD = 5;
export const CAP_TIME_ZONE = 'America/Argentina/Buenos_Aires';
/** Whole call, store reads included. The page waits a little longer (src/app.ts). */
export const CALL_TIMEOUT_MS = 60_000;

/**
 * US$ per million tokens for claude-sonnet-5-5, as in gateway/examples/live-call.ts. Check the
 * current pricing page before relying on a computed cost.
 */
export const PRICES = [
  { model: MODEL, validFrom: '2026-10-23T00:00:00Z', input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
] as const;

export interface ModelOptions {
  readonly apiKey: string;
  readonly fetch?: ClaudeClientOptions['fetch'];
  readonly clock?: Clock;
  readonly monthlyCapUsd?: number;
  /** Where the gateway's JSON lines go. Defaults to console.warn and console.error. */
  readonly log?: (line: string) => void;
}

export interface WriterModel {
  readonly gateway: Gateway;
  /** Exposed for the tests, which read the ledger. */
  readonly stores: MemoryStores;
}

export function createWriterModel(options: ModelOptions): WriterModel {
  const cap = options.monthlyCapUsd ?? MONTHLY_CAP_USD;
  const clock = options.clock ?? systemClock;
  const stores = createMemoryStores({
    clock,
    tasks: [{ task: TASK, model: MODEL, effort: EFFORT, hardCaseEffort: null }],
    // No user accounts in this folder: calls go with userId null and only the monthly cap applies.
    globalCaps: { perJobUsd: cap, dailyPerUserUsd: cap, monthlyUsd: cap },
    prices: [...PRICES],
  });
  const client = createClaudeClient({
    apiKey: options.apiKey,
    timeoutMs: CALL_TIMEOUT_MS,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const gateway = createGateway({
    client,
    clock,
    ...stores,
    notices: jsonLinesLog('writer-model', options.log),
    failures: jsonLinesLog('writer-model', options.log ?? ((line) => console.error(line))),
    timeZone: CAP_TIME_ZONE,
    timeoutMs: CALL_TIMEOUT_MS,
  });
  return { gateway, stores };
}
