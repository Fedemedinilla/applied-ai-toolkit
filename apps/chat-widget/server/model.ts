// The gateway the chat handler calls through. The gateway is the only code that talks to the API;
// this file passes it a key, a fetch (a fake one in the tests) and the numbers below.
//
// The gateway's userId is the tenant's accountId, so its daily per-user cap is a spending cap per
// tenant, and its monthly cap is the spending cap for the whole deploy. Both are checked against a
// reservation at the call's worst case before the request leaves.

import {
  createClaudeClient,
  createGateway,
  createMemoryStores,
  jsonLinesLog,
  systemClock,
  type ClaudeClientOptions,
  type Clock,
  type ConfigStore,
  type Gateway,
  type MemoryStores,
} from '../../../gateway/src/index.ts';

export const TASK = 'chat-widget-reply';
export const MODEL = 'claude-sonnet-5-5';
/** Short answers from a given text: low effort. Fixed per task so the prompt cache stays valid. */
export const EFFORT = 'low';
/** Thinking comes out of this budget too. A reply is two to four sentences. */
export const MAX_TOKENS = 1200;
export const CALL_TIMEOUT_MS = 20_000;

export interface SpendCaps {
  /** US$ per tenant per day. */
  readonly dailyPerTenantUsd: number;
  /** US$ per calendar month for the whole deploy. */
  readonly monthlyUsd: number;
}

/** Smaller than any production figure: a deploy sets its own. */
export const DEFAULT_SPEND_CAPS: SpendCaps = { dailyPerTenantUsd: 0.5, monthlyUsd: 10 };

/**
 * US$ per million tokens for claude-sonnet-5-5, the same figures as gateway/examples/live-call.ts.
 * Check the current pricing page before relying on a computed cost. A server-side fallback to an
 * unpriced model is counted at the gateway's upper bound.
 */
export const PRICES = [
  { model: MODEL, validFrom: '2026-10-23T00:00:00Z', input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
] as const;

export interface ModelOptions {
  readonly apiKey: string;
  readonly fetch?: ClaudeClientOptions['fetch'];
  readonly clock?: Clock;
  readonly caps?: SpendCaps;
  readonly timeZone: string;
  readonly log?: (line: string) => void;
}

export interface ChatModel {
  readonly gateway: Gateway;
  /** The gateway's ledger, for the tests. */
  readonly stores: MemoryStores;
}

/**
 * Every tenant gets the same daily cap. accountId comes from the tenant row the handler validated,
 * never from the request, so answering caps for any id does not let a caller pick one.
 */
function perTenantCaps(stores: MemoryStores, caps: SpendCaps): ConfigStore {
  return {
    taskConfig: (task, signal) => stores.config.taskConfig(task, signal),
    globalCaps: (signal) => stores.config.globalCaps(signal),
    accountCaps: async () => ({ perJobUsd: null, dailyPerUserUsd: caps.dailyPerTenantUsd }),
  };
}

export function createChatModel(options: ModelOptions): ChatModel {
  const caps = options.caps ?? DEFAULT_SPEND_CAPS;
  const clock = options.clock ?? systemClock;
  const stores = createMemoryStores({
    clock,
    tasks: [{ task: TASK, model: MODEL, effort: EFFORT, hardCaseEffort: null }],
    // perJobUsd is required by the schema; calls carry no job, so it never applies.
    globalCaps: { perJobUsd: caps.monthlyUsd, dailyPerUserUsd: caps.dailyPerTenantUsd, monthlyUsd: caps.monthlyUsd },
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
    config: perTenantCaps(stores, caps),
    usage: stores.usage,
    prices: stores.prices,
    notices: jsonLinesLog('chat-widget-model', options.log),
    failures: jsonLinesLog('chat-widget-model', options.log ?? ((line) => console.error(line))),
    timeZone: options.timeZone,
    timeoutMs: CALL_TIMEOUT_MS,
  });
  return { gateway, stores };
}
