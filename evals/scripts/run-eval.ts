/**
 * Live: runs the fictional writer against the real model, per variant.
 *
 *   node evals/scripts/run-eval.ts <out.jsonl> [--variants V0,V4] [--cases probes|examples|all]
 *        [--langs en,es] [--samples 3] [--concurrency 3]
 *   node evals/scripts/run-eval.ts <prompts.json> --variants V4 --dump
 *
 * --dump writes the system blocks each job would send and stops, with no key
 * and no call. Use it to check a shipped change: dump the winning variant
 * before editing the product, dump V0 after, and diff the two files. Both
 * dumps render the date block at the same fixed date, so they compare equal
 * across days.
 *
 * A call that fails after its retries is written to the same file as a row
 * with an `error` field, so aggregation can count it against its variant.
 *
 * Each piece is one paid call. The default (V0 on the probes, both languages,
 * 3 samples) is 30 calls.
 */
import { createWriterTarget, LANGS, type Lang } from '../example/business.ts';
import { CASE_SETS } from '../example/cases.ts';
import { VARIANTS } from '../example/variants.ts';
import { anthropicModelClient } from '../src/model.ts';
import { appendJsonl } from '../src/files.ts';
import { DUMP_NOW, dumpPrompts, planJobs, preflight, runEval } from '../src/runner.ts';
import { flag, freshOutputOrExit, hasFlag, intFlag, liveClient, positional, usageError } from './cli.ts';
import { writeFileSync } from 'node:fs';

const USAGE = 'usage: node evals/scripts/run-eval.ts <out.jsonl> [--variants V0,V4] [--cases probes|examples|all] [--langs en,es] [--samples 3] [--concurrency 3] [--dump]';
const [out] = positional(1, USAGE) as [string];

const variantIds = flag('variants', 'V0').split(',');
for (const v of variantIds) {
  if (!VARIANTS.some((x) => x.id === v)) usageError(`unknown variant ${v}; one of ${VARIANTS.map((x) => x.id).join(', ')}`);
}
const langs = flag('langs', LANGS.join(',')).split(',') as Lang[];
for (const l of langs) if (!LANGS.includes(l)) usageError(`unknown language ${l}; one of ${LANGS.join(', ')}`);
const casesName = flag('cases', 'probes');
const cases = CASE_SETS[casesName] ?? usageError(`unknown --cases ${casesName}; one of ${Object.keys(CASE_SETS).join(', ')}`);
const samples = intFlag('samples', 3);

const target = createWriterTarget();
const jobs = planJobs(cases, variantIds, langs, samples);

if (hasFlag('dump')) {
  let dump;
  try {
    dump = dumpPrompts(target, VARIANTS, jobs);
  } catch (e) {
    usageError(String((e as Error).message));
  }
  writeFileSync(freshOutputOrExit(out), JSON.stringify(dump, null, 1));
  console.log(`dumped ${Object.keys(dump).length} prompts at ${DUMP_NOW.toISOString()} -> ${out}`);
  process.exit(0);
}

const now = new Date();
preflight(target, VARIANTS, jobs, now);

// Looser than a product route on purpose: in production a slow call is a user
// waiting, here it is a sample that would otherwise be lost.
const client = anthropicModelClient(liveClient({ timeout: 60_000, maxRetries: 4 }));
freshOutputOrExit(out);
console.log(`${jobs.length} pieces: ${variantIds.join(',')} x ${langs.join(',')} x ${cases.length} cases x ${samples}`);
let done = 0;
const tick = () => {
  if (++done % 10 === 0 || done === jobs.length) console.log(`${done}/${jobs.length}`);
};
const { failures } = await runEval({
  client,
  target,
  variants: VARIANTS,
  jobs,
  now,
  concurrency: intFlag('concurrency', 3),
  onRow: (row) => {
    appendJsonl(out, row);
    tick();
  },
  onFailure: (f) => {
    appendJsonl(out, f);
    console.log(`FAILED ${f.variant} ${f.lang} ${f.case} #${f.sample}: ${f.error}`);
    tick();
  },
});
console.log(`done -> ${out}${failures.length ? ` (${failures.length} failed, recorded as error rows; aggregation stops on them unless --allow-missing)` : ''}`);
process.exitCode = failures.length ? 1 : 0;
