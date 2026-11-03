/**
 * One real structured call through the gateway, with in-memory stores. Opt-in: without
 * ANTHROPIC_API_KEY it prints how to run it and exits without calling anything. It is not part of
 * the test suite.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node gateway/examples/live-call.ts
 *
 * The key is read here, by the entry point, and passed in. The gateway itself never reads the
 * environment.
 */
import { z } from 'zod';
import { createClaudeClient, createGateway, createMemoryStores, GatewayError, jsonLinesLog, systemClock } from '../src/index.ts';

const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
if (apiKey.trim() === '') {
  console.log('Set ANTHROPIC_API_KEY to run one real call: ANTHROPIC_API_KEY=sk-ant-... node gateway/examples/live-call.ts');
  process.exit(0);
}

const Triage = z.object({
  category: z.enum(['billing', 'bug', 'question']),
  priority: z.int().min(1).max(5).describe('1 is the most urgent'),
  summary: z.string().max(200),
});

const USER = '00000000-0000-4000-8000-000000000001';
const stores = createMemoryStores({
  clock: systemClock,
  tasks: [{ task: 'triage', model: 'claude-sonnet-5-5', effort: 'low', hardCaseEffort: null }],
  globalCaps: { perJobUsd: 1, dailyPerUserUsd: 1, monthlyUsd: 5 },
  accounts: { [USER]: { perJobUsd: null, dailyPerUserUsd: null } },
  // US$ per million tokens as listed when this was written. Check the current pricing page before
  // relying on the computed cost.
  prices: [{ model: 'claude-sonnet-5-5', validFrom: '2026-10-23T00:00:00Z', input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 }],
});

const gateway = createGateway({
  client: createClaudeClient({ apiKey, timeoutMs: 60_000 }),
  clock: systemClock,
  ...stores,
  notices: jsonLinesLog('gateway'),
  failures: jsonLinesLog('gateway', (line) => console.error(line)),
  timeZone: 'UTC',
  timeoutMs: 90_000,
});

try {
  const { data, meta } = await gateway.structured(Triage, {
    task: 'triage',
    userId: USER,
    promptVersion: 'triage@1',
    maxTokens: 2_000,
    system: ['Classify the support ticket. Answer only with the requested JSON.'],
    messages: [{ role: 'user', content: '<ticket>I was charged twice for the same order this morning.</ticket>' }],
  });
  console.log('data:', data);
  console.log('meta:', meta);
  console.log(
    'ledger:',
    stores.usage.rows.map((row) => ({ reservation: row.reservation, replaces: row.replaces, costUsd: row.costUsd, incomplete: row.incomplete })),
  );
} catch (error) {
  if (!(error instanceof GatewayError)) throw error;
  // Codes are stable; see ERROR_CODES in src/errors.ts.
  console.error(`gateway error: ${error.code}: ${error.message}`);
  process.exitCode = 1;
}
