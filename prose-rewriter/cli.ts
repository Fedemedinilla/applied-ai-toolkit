#!/usr/bin/env node
// Usage: node prose-rewriter/cli.ts --genre cover-letter|email|follow-up|whatsapp --lang es|en [--variety rioplatense|neutral]
//        --cv <file> [--to recipient.json] [--previous file] [--mode minimo|pulido|reescritura] [--keep "phrase"]... [--strict] [--strategy staged|single] [--json] <draft file>
// --strategy defaults to single, the guarded one-call strategy (decided 16/11/2026, README "Measured").
// Needs ANTHROPIC_API_KEY in the environment (never in a file or an argument), unless the draft has nothing to change.
// Exit codes: 0 ok, 1 needs-review, 2 blocked, 3 bad usage or an unreadable file, 4 no API key or a failed model call.
//
// This is the only place that builds the live gateway: in-memory stores seeded with the rewriter's
// four tasks, its caps measured in F6 (src/tasks.ts) and the gateway's built-in prices. Everything else
// is src/cli.ts, which the tests run over a scripted gateway.
//
// The stores last one run: the per-job cap binds within it, but the daily and monthly caps start
// from zero each time, and with no userId the daily cap is skipped. They limit repeated runs only
// over persistent stores (README, "Run it").
import { readFileSync } from 'node:fs';
import {
  BUILT_IN_MODELS,
  createClaudeClient,
  createGateway,
  createMemoryStores,
  jsonLinesLog,
  systemClock,
  type Gateway,
} from '../gateway/src/index.ts';
import { loadRefs, runCli } from './src/cli.ts';
import { REWRITE_CAPS, TASK_CONFIGS } from './src/tasks.ts';

/** Whole call, store reads included. A plan or edit over a long letter can take a while. */
const CALL_TIMEOUT_MS = 120_000;
/** The caps' days and months follow the user's calendar. */
const CAP_TIME_ZONE = 'America/Argentina/Buenos_Aires';

function liveGateway(apiKey: string): Gateway {
  const stores = createMemoryStores({
    clock: systemClock,
    tasks: Object.values(TASK_CONFIGS),
    globalCaps: { ...REWRITE_CAPS },
    prices: BUILT_IN_MODELS.map(({ id, price }) => ({ model: id, ...price })),
  });
  return createGateway({
    client: createClaudeClient({ apiKey, timeoutMs: CALL_TIMEOUT_MS }),
    clock: systemClock,
    ...stores,
    // Ids, counts, codes and costs only: the gateway never logs text (README, "What the gateway records").
    notices: jsonLinesLog('prose-rewriter'),
    failures: jsonLinesLog('prose-rewriter', (line) => console.error(line)),
    timeZone: CAP_TIME_ZONE,
    timeoutMs: CALL_TIMEOUT_MS,
  });
}

process.exitCode = await runCli(process.argv.slice(2), {
  apiKey: process.env['ANTHROPIC_API_KEY'],
  readFile: (path) => readFileSync(path, 'utf8'),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  gateway: liveGateway,
  refs: () => loadRefs(new URL('../', import.meta.url)),
});
