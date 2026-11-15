/**
 * Offline: turns a judged groundedness eval into stored runs, one file per
 * variant, for the gate and the HTML report.
 *
 *   node evals/scripts/runs.ts <pieces.jsonl> <key.json> <verdicts.jsonl> <out-prefix> [--judges N] [--allow-missing]
 *
 * Writes <out-prefix>-<variant>.json. The same refusals as aggregate.ts
 * apply, so a run with a lost judge does not become a file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { AggregateError } from '../src/aggregate.ts';
import type { BlindKey, BlindPiece } from '../src/blind.ts';
import { readJsonl } from '../src/files.ts';
import { groundedness, JudgeError } from '../src/judge.ts';
import { judgedRuns, summarize } from '../src/run.ts';
import { flag, freshOutputsOrExit, hasFlag, intFlag, positional, usageError } from './cli.ts';

const [piecesPath, keyPath, verdictsPath, prefix] = positional(4, 'usage: node evals/scripts/runs.ts <pieces.jsonl> <key.json> <verdicts.jsonl> <out-prefix> [--judges N] [--allow-missing]') as [string, string, string, string];
const { key } = JSON.parse(readFileSync(keyPath, 'utf8')) as { key: BlindKey };
const judges = flag('judges', '') === '' ? undefined : intFlag('judges', 1);
let runs;
try {
  runs = judgedRuns(groundedness, readJsonl<BlindPiece>(piecesPath), key, readJsonl(verdictsPath), { judges, allowMissing: hasFlag('allow-missing') });
} catch (e) {
  if (e instanceof AggregateError || e instanceof JudgeError) usageError(e.message);
  throw e;
}
for (const run of runs) {
  if (!/^[A-Za-z0-9._-]+$/.test(run.label)) usageError(`variant "${run.label}" cannot be used in a file name`);
}
const pathOf = (label: string) => `${prefix}-${label}.json`;
freshOutputsOrExit(runs.map((run) => pathOf(run.label)));
for (const run of runs) {
  const path = pathOf(run.label);
  writeFileSync(path, JSON.stringify(run, null, 1) + '\n');
  const s = summarize(run);
  console.log(`${run.label}: ${s.passes}/${s.scored} pass -> ${path}`);
}
