// The gateway model mode calls through, set up with its in-memory stores and a small monthly cap.
// The gateway is the only code that talks to the API: this file passes it a key, a fetch (a fake
// one in the tests) and the numbers below, and never builds a request itself.

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

export const TASK = 'caja-extract';
/** Reading one sentence is a small job: the mid-priced model at low effort. */
export const MODEL = 'claude-sonnet-5-5';
export const EFFORT = 'low';
/** Thinking comes out of this budget too, so it is not squeezed to the size of the JSON. */
export const MAX_TOKENS = 2000;
/** US$ per calendar month for the whole deploy. A reached cap answers cap_reached without a call. */
export const MONTHLY_CAP_USD = 2;
/** The cap's month starts at midnight here, not in the host's zone (UTC on most hosts). */
export const CAP_TIME_ZONE = 'America/Argentina/Buenos_Aires';
/** Whole call, store reads included. The browser waits 20 s (src/model-mode.ts). */
export const CALL_TIMEOUT_MS = 15_000;

/**
 * US$ per million tokens for claude-sonnet-5-5, as in gateway/examples/live-call.ts. Check the
 * current pricing page before relying on a computed cost. A server-side fallback to an unpriced
 * model is counted at the gateway's upper bound.
 */
export const PRICES = [
  { model: MODEL, validFrom: '2026-10-23T00:00:00Z', input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
] as const;

export interface ModelOptions {
  readonly apiKey: string;
  /** For tests: a fake Anthropic HTTP API. */
  readonly fetch?: ClaudeClientOptions['fetch'];
  readonly clock?: Clock;
  readonly monthlyCapUsd?: number;
  /** Where the gateway's JSON lines go. Defaults to console.warn and console.error. */
  readonly log?: (line: string) => void;
}

export interface CajaModel {
  readonly gateway: Gateway;
  /** Exposed for the tests, which read the ledger. */
  readonly stores: MemoryStores;
}

export function createCajaModel(options: ModelOptions): CajaModel {
  const cap = options.monthlyCapUsd ?? MONTHLY_CAP_USD;
  const clock = options.clock ?? systemClock;
  const stores = createMemoryStores({
    clock,
    tasks: [{ task: TASK, model: MODEL, effort: EFFORT, hardCaseEffort: null }],
    // There are no user accounts, so calls go with userId null and only the monthly cap applies.
    // The other two fields are required by the schema and set to the same figure.
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
    notices: jsonLinesLog('caja-model', options.log),
    failures: jsonLinesLog('caja-model', options.log ?? ((line) => console.error(line))),
    timeZone: CAP_TIME_ZONE,
    timeoutMs: CALL_TIMEOUT_MS,
  });
  return { gateway, stores };
}
