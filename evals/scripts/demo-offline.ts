/**
 * Offline: the whole pipeline (run, blind, judge, aggregate) with scripted
 * fake models. No key, no network, no cost.
 *
 *   node evals/scripts/demo-offline.ts
 *
 * The table it prints measures the plumbing, not a model: the fake writer
 * invents exactly when the procedure rule is missing, so V0 and V1 come out at
 * 100% and V2 to V4 at 0% by construction.
 */
import { createWriterTarget } from '../example/business.ts';
import { PROBES } from '../example/cases.ts';
import { fakeJudge, fakeWriter } from '../example/fake-models.ts';
import { VARIANTS } from '../example/variants.ts';
import { aggregate, toMarkdown } from '../src/aggregate.ts';
import { blind } from '../src/blind.ts';
import { judgePiece } from '../src/judge.ts';
import { planJobs, runEval } from '../src/runner.ts';

const target = createWriterTarget();
const now = new Date('2026-03-04T12:00:00Z');
const jobs = planJobs(PROBES, VARIANTS.map((v) => v.id), ['en', 'es'], 2);
const { rows } = await runEval({ client: fakeWriter(), target, variants: VARIANTS, jobs, now });
const { pieces, key } = blind(rows, 7);
const judge = fakeJudge();
const verdicts = [];
for (const p of pieces) {
  const c = PROBES.find((x) => x.id === p.case)!;
  verdicts.push(await judgePiece(judge, p, target.factSheet(c, p.lang as 'en' | 'es', new Date(p.now))));
}
console.log('FAKE MODELS: this table checks the pipeline, not any model.\n');
console.log(toMarkdown(aggregate(pieces, key, verdicts), Object.fromEntries(VARIANTS.map((v) => [v.id, v.what]))));
