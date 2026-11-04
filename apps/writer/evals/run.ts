// Live and opt-in: runs the writer's draft step on the eval cases, per variant, through the
// gateway and the evals runner (evals/src/runner.ts). Costs money; never part of the tests.
//
//   ANTHROPIC_API_KEY=sk-ant-... node apps/writer/evals/run.ts rows.jsonl [--variants V0,NC]
//        [--cases all|complete|gaps] [--samples 3] [--concurrency 2] [--cap-usd 5]
//   node apps/writer/evals/run.ts prompts.json --variants NC --dump     # no key, no call
//
// Without the key it prints its usage and exits before any call. An existing output file is
// refused, so two runs never mix. Each failed call becomes an error row the report counts.
// The default (V0 and NC, all ten cases, 3 samples) is 60 calls.

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { appendJsonl, freshOutput } from '../../../evals/src/index.ts';
import { DUMP_NOW, dumpPrompts, planJobs, preflight, runEval } from '../../../evals/src/index.ts';
import { loadConfig } from '../server/config.ts';
import { apiKeyFromEnv } from '../server/env.ts';
import { createWriterModel, MONTHLY_CAP_USD } from '../server/model.ts';
import { CASE_SETS } from './cases.ts';
import { gatewayModelClient } from './model-client.ts';
import { createWriterTarget, LANGS } from './target.ts';
import { VARIANTS } from './variants.ts';

const USAGE = 'usage: node apps/writer/evals/run.ts <out> [--variants V0,NC] [--cases all|complete|gaps] [--samples 3] [--concurrency 2] [--cap-usd 5] [--dump]';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    variants: { type: 'string', default: VARIANTS.map((v) => v.id).join(',') },
    cases: { type: 'string', default: 'all' },
    samples: { type: 'string', default: '3' },
    concurrency: { type: 'string', default: '2' },
    'cap-usd': { type: 'string', default: String(MONTHLY_CAP_USD) },
    dump: { type: 'boolean', default: false },
  },
});
const out = positionals[0] ?? fail(USAGE);
const variantIds = values.variants.split(',');
for (const id of variantIds) if (!VARIANTS.some((v) => v.id === id)) fail(`unknown variant ${id}; one of ${VARIANTS.map((v) => v.id).join(', ')}`);
const cases = CASE_SETS[values.cases] ?? fail(`unknown --cases ${values.cases}; one of ${Object.keys(CASE_SETS).join(', ')}`);
const positive = (name: string, raw: string, integer: boolean): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && (!integer || Number.isInteger(n)) ? n : fail(`--${name} must be a positive ${integer ? 'integer' : 'number'}`);
};
const samples = positive('samples', values.samples, true);
const concurrency = positive('concurrency', values.concurrency, true);
const capUsd = positive('cap-usd', values['cap-usd'], false);

const config = loadConfig();
const target = createWriterTarget(config);
const jobs = planJobs(cases, variantIds, LANGS, samples);

if (values.dump) {
  const dump = dumpPrompts(target, VARIANTS, jobs);
  writeFileSync(freshOutputOrFail(out), JSON.stringify(dump, null, 1));
  console.log(`dumped ${Object.keys(dump).length} prompts at ${DUMP_NOW.toISOString()} -> ${out}`);
  process.exit(0);
}

function freshOutputOrFail(path: string): string {
  try {
    return freshOutput(path);
  } catch (e) {
    return fail(String((e as Error).message));
  }
}

const apiKey = apiKeyFromEnv() ?? fail(`ANTHROPIC_API_KEY is not set. Live runs call the real API and cost money; tests never need a key.\n${USAGE}`);
const now = new Date();
preflight(target, VARIANTS, jobs, now);
const { gateway } = createWriterModel({ apiKey, monthlyCapUsd: capUsd });
freshOutputOrFail(out);
console.log(`${jobs.length} drafts: ${variantIds.join(',')} x ${cases.length} cases x ${samples}, capped at US$${capUsd}`);
const { failures } = await runEval({
  client: gatewayModelClient(gateway),
  target,
  variants: VARIANTS,
  jobs,
  now,
  concurrency,
  onRow: (row) => appendJsonl(out, row),
  onFailure: (f) => {
    appendJsonl(out, f);
    console.log(`FAILED ${f.variant} ${f.case} #${f.sample}: ${f.error}`);
  },
});
console.log(`done -> ${out}${failures.length ? ` (${failures.length} failed, recorded as error rows)` : ''}; next: node apps/writer/evals/report.ts ${out}`);
process.exitCode = failures.length ? 1 : 0;
