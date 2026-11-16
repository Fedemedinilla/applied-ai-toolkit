#!/usr/bin/env node
// Usage: node prose-rewriter/evals/cli.ts (--dry-run | --live --out <dir>) [--variants id,...] [--cases genre|lang|id,...]
//        [--limit N] [--margin F] [--monthly-cap USD] [--max-usd USD]
// --live needs ANTHROPIC_API_KEY in the environment (never in a file or an argument); --dry-run needs no key.
// Exit codes (run.ts): 0 the gate passed (or a dry run), 1 stopped by a cap or the budget, 2 the gate
// failed or a hard rubric blocked it, 3 bad usage, 4 no key or an unreadable ledger, 5 the gate is
// inconclusive or could not run.
//
// This is the only place that reads the key and builds the live gateway of the eval runs:
// in-memory stores seeded with the rewriter's four tasks, its provisional caps with the run's
// monthly cap in place of the deploy's, and the gateway's built-in prices. Those stores last one
// run; the budget across runs is the spend ledger (evals/spend.ts). Everything else is
// evals/run.ts, which the tests run over a scripted gateway.
import { homedir } from 'node:os';
import { BUILT_IN_MODELS, createClaudeClient, createGateway, createMemoryStores, jsonLinesLog, systemClock, type Gateway } from '../../gateway/src/index.ts';
import { loadRefs } from '../src/cli.ts';
import { PROVISIONAL_CAPS, TASK_CONFIGS } from '../src/tasks.ts';
import { loadCases } from './cases.ts';
import { runEvalCli } from './run.ts';

/** Whole call, store reads included, as in prose-rewriter/cli.ts. */
const CALL_TIMEOUT_MS = 120_000;
const CAP_TIME_ZONE = 'America/Argentina/Buenos_Aires';
const ROOT = new URL('../../', import.meta.url);

function liveGateway(apiKey: string, monthlyCapUsd: number): Gateway<string> {
  const stores = createMemoryStores({
    clock: systemClock,
    tasks: Object.values(TASK_CONFIGS),
    globalCaps: { ...PROVISIONAL_CAPS, monthlyUsd: monthlyCapUsd },
    prices: BUILT_IN_MODELS.map(({ id, price }) => ({ model: id, ...price })),
  });
  return createGateway({
    client: createClaudeClient({ apiKey, timeoutMs: CALL_TIMEOUT_MS }),
    clock: systemClock,
    ...stores,
    // Ids, counts, codes and costs only: the gateway never logs text.
    notices: jsonLinesLog('prose-rewriter-evals'),
    failures: jsonLinesLog('prose-rewriter-evals', (line) => console.error(line)),
    timeZone: CAP_TIME_ZONE,
    timeoutMs: CALL_TIMEOUT_MS,
  });
}

process.exitCode = await runEvalCli(process.argv.slice(2), {
  apiKey: process.env['ANTHROPIC_API_KEY'],
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  clock: systemClock,
  home: homedir(),
  cases: () => loadCases(ROOT),
  refs: () => loadRefs(ROOT),
  gateway: liveGateway,
});
