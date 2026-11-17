// The gateway the rewriter calls through: in-memory stores seeded with prose-rewriter's four tasks
// (models and effort fixed there, TASK_CONFIGS), its caps (REWRITE_CAPS) and the gateway's
// built-in prices, as prose-rewriter's CLI builds it. The gateway is the only code that talks to the
// API: this file passes it a key, a fetch (a fake one in the tests) and the numbers below.

import {
  BUILT_IN_MODELS,
  createClaudeClient,
  createGateway,
  createMemoryStores,
  jsonLinesLog,
  systemClock,
  type ClaudeClientOptions,
  type Clock,
  type Gateway,
  type GlobalCaps,
  type MemoryStores,
} from '../../../gateway/src/index.ts';
import { REWRITE_CAPS, TASK_CONFIGS } from '../../../prose-rewriter/src/index.ts';

/** Whole call, store reads included: the CLI's number. A rewrite makes two to four calls in a row. */
export const CALL_TIMEOUT_MS = 120_000;
/** The caps' days and months follow the user's calendar. */
export const CAP_TIME_ZONE = 'America/Argentina/Buenos_Aires';

export interface ModelOptions {
  readonly apiKey: string;
  readonly fetch?: ClaudeClientOptions['fetch'];
  readonly clock?: Clock;
  /** REWRITE_CAPS unless a test passes others. */
  readonly caps?: GlobalCaps;
  /** Where the gateway's JSON lines go. Defaults to console.warn and console.error. */
  readonly log?: (line: string) => void;
}

export interface RewriterModel {
  readonly gateway: Gateway;
  /** Exposed for the tests, which read the ledger. */
  readonly stores: MemoryStores;
}

export function createRewriterModel(options: ModelOptions): RewriterModel {
  const clock = options.clock ?? systemClock;
  const stores = createMemoryStores({
    clock,
    tasks: Object.values(TASK_CONFIGS),
    globalCaps: { ...(options.caps ?? REWRITE_CAPS) },
    prices: BUILT_IN_MODELS.map(({ id, price }) => ({ model: id, ...price })),
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
    // Ids, counts, codes and costs only: the gateway never logs text (prose-rewriter README, "What the gateway records").
    notices: jsonLinesLog('rewriter-model', options.log),
    failures: jsonLinesLog('rewriter-model', options.log ?? ((line) => console.error(line))),
    timeZone: CAP_TIME_ZONE,
    timeoutMs: CALL_TIMEOUT_MS,
  });
  return { gateway, stores };
}
