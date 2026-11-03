/**
 * Live: judges blind pieces with the model and the written rubric.
 *
 *   node evals/scripts/judge.ts <pieces.jsonl> <verdicts.jsonl> [--judges 1] [--concurrency 3]
 *
 * --judges N asks N independent verdicts per piece; aggregation takes the
 * majority and reports split calls. The judge reads only pieces.jsonl and the
 * fact sheet, which ends with the TODAY line the writer was given (the run's
 * date travels with each piece). A verdict that fails (bad shape, missing
 * lines, a refusal) is logged and left out, and aggregate.ts then refuses to
 * run until that piece has the same number of judges as the rest: a dropped
 * verdict would hold one piece to a different majority than the others.
 */
import { createWriterTarget, type Lang } from '../example/business.ts';
import { ALL_CASES } from '../example/cases.ts';
import type { BlindPiece } from '../src/blind.ts';
import { appendJsonl, readJsonl } from '../src/files.ts';
import { judgePiece } from '../src/judge.ts';
import { anthropicModelClient } from '../src/model.ts';
import { freshOutputOrExit, intFlag, liveClient, positional } from './cli.ts';

const [piecesPath, out] = positional(2, 'usage: node evals/scripts/judge.ts <pieces.jsonl> <verdicts.jsonl> [--judges 1] [--concurrency 3]') as [string, string];
const pieces = readJsonl<BlindPiece>(piecesPath);
const judges = intFlag('judges', 1);
const target = createWriterTarget();
const sheetFor = (p: BlindPiece) => {
  const c = ALL_CASES.find((x) => x.id === p.case);
  if (!c) throw new Error(`piece ${p.id}: unknown case ${p.case}`);
  return target.factSheet(c, p.lang as Lang, new Date(p.now));
};

const client = anthropicModelClient(liveClient({ timeout: 120_000, maxRetries: 4 }));
freshOutputOrExit(out);
const jobs = pieces.flatMap((p) => Array.from({ length: judges }, (_, j) => ({ p, judge: j + 1 })));
let next = 0;
let failed = 0;
await Promise.all(
  Array.from({ length: intFlag('concurrency', 3) }, async () => {
    while (next < jobs.length) {
      const { p, judge } = jobs[next++]!;
      try {
        appendJsonl(out, await judgePiece(client, p, sheetFor(p), judge));
      } catch (e) {
        failed++;
        console.log(`FAILED ${p.id} judge ${judge}: ${String((e as Error).message).slice(0, 160)}`);
      }
    }
  }),
);
console.log(`${jobs.length - failed}/${jobs.length} verdicts -> ${out}`);
process.exitCode = failed ? 1 : 0;
