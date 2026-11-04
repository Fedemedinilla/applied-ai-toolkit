/**
 * The gateway generate calls through, with its in-memory stores and a cap per run. This is the
 * only file in the folder that imports the gateway, and it uses only the gateway's public entry.
 * It never builds a request body: generate.ts hands the gateway a schema and the prompt blocks.
 */
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
} from '../../gateway/src/index.ts';

export const TASK = 'content-forge';
export const MODEL = 'claude-sonnet-5-5';
/** Writing a consistent batch is more than a lookup; medium effort leaves room to think. */
export const EFFORT = 'medium';
/** The most a non-streaming call may ask for. Thinking comes out of it too. */
export const MAX_TOKENS = 16_000;
/** US$ a single run may reserve. The ledger lives in memory, so the cap holds per process. */
export const RUN_CAP_USD = 1;
/** Whole call. A batch of eight cards with thinking takes longer than a sentence. */
export const CALL_TIMEOUT_MS = 240_000;
export const CAP_TIME_ZONE = 'UTC';

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
  readonly capUsd?: number;
  /** Where the gateway's JSON lines go. Defaults to console.warn and console.error. */
  readonly log?: (line: string) => void;
}

export interface ForgeModel {
  readonly gateway: Gateway;
  /** Exposed for the tests, which read the ledger. */
  readonly stores: MemoryStores;
}

export function createForgeModel(options: ModelOptions): ForgeModel {
  const cap = options.capUsd ?? RUN_CAP_USD;
  const clock = options.clock ?? systemClock;
  const stores = createMemoryStores({
    clock,
    tasks: [{ task: TASK, model: MODEL, effort: EFFORT, hardCaseEffort: null }],
    // A CLI run has no user: calls go with userId null and only the monthly figure applies. The
    // other two are required by the schema and set to the same figure.
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
    notices: jsonLinesLog('content-forge', options.log),
    failures: jsonLinesLog('content-forge', options.log ?? ((line) => console.error(line))),
    timeZone: CAP_TIME_ZONE,
    timeoutMs: CALL_TIMEOUT_MS,
  });
  return { gateway, stores };
}

export { GatewayError, ResponseError, type Gateway } from '../../gateway/src/index.ts';
