// The model side of the salon assistant: the gateway with its in-memory stores, and the `propose`
// function the grounded-assistant handler calls once per turn. The gateway is the only code that
// talks to the API; this file passes it a key, a fetch (a fake one in the tests) and the numbers
// below, and maps its errors to the three the handler knows.

import {
  ApiError,
  CapError,
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
import { ModelUnavailable, type ProposeReply } from '../../../grounded-assistant/src/index.ts';

export const TASK = 'salon-assistant-turn';
export const MODEL = 'claude-sonnet-5-5';
/** A short reply from a given context: low effort. */
export const EFFORT = 'low';
/** Thinking comes out of this budget too. The source used 1,200 for two to four lines. */
export const MAX_TOKENS = 1200;
/** One attempt; the source measured turns of 3.5 to 8.8 seconds without a cap. */
export const CALL_TIMEOUT_MS = 12_000;
export const PROMPT_VERSION = 'salon-rules@1';
export const CAP_TIME_ZONE = 'America/Argentina/Buenos_Aires';
/** A demo cap. A deploy sets its own. */
export const MONTHLY_CAP_USD = 5;

/** US$ per million tokens, the figures gateway/examples/live-call.ts uses. Check the pricing page before relying on a cost. */
export const PRICES = [
  { model: MODEL, validFrom: '2026-10-23T00:00:00Z', input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
] as const;

export interface ModelOptions {
  readonly apiKey: string;
  readonly fetch?: ClaudeClientOptions['fetch'];
  readonly clock?: Clock;
  readonly monthlyCapUsd?: number;
  readonly log?: (line: string) => void;
}

export interface SalonModel {
  readonly gateway: Gateway;
  readonly stores: MemoryStores;
  readonly propose: ProposeReply;
}

export function createSalonModel(options: ModelOptions): SalonModel {
  const cap = options.monthlyCapUsd ?? MONTHLY_CAP_USD;
  const clock = options.clock ?? systemClock;
  const stores = createMemoryStores({
    clock,
    tasks: [{ task: TASK, model: MODEL, effort: EFFORT, hardCaseEffort: null }],
    // No accounts: calls go with userId null and only the monthly cap applies.
    globalCaps: { perJobUsd: cap, dailyPerUserUsd: cap, monthlyUsd: cap },
    prices: [...PRICES],
  });
  const client = createClaudeClient({ apiKey: options.apiKey, timeoutMs: CALL_TIMEOUT_MS, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const gateway = createGateway({
    client,
    clock,
    ...stores,
    notices: jsonLinesLog('salon-assistant', options.log),
    failures: jsonLinesLog('salon-assistant', options.log ?? ((line) => console.error(line))),
    timeZone: CAP_TIME_ZONE,
    timeoutMs: CALL_TIMEOUT_MS,
  });

  const propose: ProposeReply = async ({ schema, system, messages }) => {
    try {
      const { data } = await gateway.structured(schema, {
        task: TASK,
        userId: null,
        promptVersion: PROMPT_VERSION,
        maxTokens: MAX_TOKENS,
        system,
        messages,
      });
      return data;
    } catch (e) {
      if (e instanceof CapError) throw new ModelUnavailable('cap');
      if (e instanceof ApiError && e.retryable) throw new ModelUnavailable('busy');
      // Refusals, a max_tokens stop and output that failed the schema land here too: billed, in
      // the ledger, and nothing the visitor should see.
      throw new ModelUnavailable('failed');
    }
  };
  return { gateway, stores, propose };
}
