/**
 * Live: replays attack conversations against the fictional chat handler with
 * the real model.
 *
 *   node evals/scripts/redteam.ts <attacks.json> <out.jsonl> [--concurrency 2]
 *
 * The signing secret is drawn fresh for each run: it only has to outlive the
 * conversations of this run, and nothing outside the process ever needs it.
 * Attacks with automatic checks come out pass or fail; the rest come out
 * "review" with their transcript and the expected behaviour, for a human or a
 * blind judge to read.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createChatHandler } from '../example/chat.ts';
import { appendJsonl } from '../src/files.ts';
import { anthropicModelClient } from '../src/model.ts';
import { parseAttacks, runAttacks, summarize } from '../src/redteam.ts';
import { freshOutputOrExit, intFlag, liveClient, positional } from './cli.ts';

const [attacksPath, out] = positional(2, 'usage: node evals/scripts/redteam.ts <attacks.json> <out.jsonl> [--concurrency 2]') as [string, string];
const attacks = parseAttacks(JSON.parse(readFileSync(attacksPath, 'utf8')));
const client = anthropicModelClient(liveClient({ timeout: 30_000, maxRetries: 2 }));
const handler = createChatHandler({ client, secret: randomBytes(32).toString('hex') });

freshOutputOrExit(out);
const records = await runAttacks(handler, attacks, {
  concurrency: intFlag('concurrency', 2),
  onRecord: (r) => {
    appendJsonl(out, r);
    console.log(`${r.outcome.padEnd(6)} ${r.id}${r.reasons.length ? ': ' + r.reasons.join('; ') : ''}`);
  },
});
for (const [lens, c] of Object.entries(summarize(records))) console.log(`${lens.padEnd(18)} pass ${c.pass}  fail ${c.fail}  review ${c.review}`);
process.exitCode = records.some((r) => r.outcome === 'fail') ? 1 : 0;
