/**
 * Offline: scores outputs with a code rubric and writes a stored run.
 *
 *   node evals/scripts/score.ts classification <items.jsonl> <run.json> --labels price,hours,repair,other [--multi] [--label main]
 *   node evals/scripts/score.ts extraction <items.jsonl> <run.json> [--label main]
 *
 * Each line of the items file is {"case", "output", "expected"}, with an
 * optional "input" and "sample". A call that failed is {"case", "expected",
 * "error"}: it stays in the run, unscored. No model is called.
 */
import { writeFileSync } from 'node:fs';
import { classification } from '../src/classification.ts';
import { extraction } from '../src/extraction.ts';
import { readJsonl } from '../src/files.ts';
import { RubricError } from '../src/rubric.ts';
import { RunError, scoreItems, summarize, type StoredRun } from '../src/run.ts';
import { flag, freshOutputOrExit, hasFlag, positional, usageError } from './cli.ts';

const USAGE = 'usage: node evals/scripts/score.ts <classification|extraction> <items.jsonl> <run.json> [--label NAME] [--labels a,b,c] [--multi]';
const [name, itemsPath, out] = positional(3, USAGE) as [string, string, string];
const label = flag('label', 'run');

let run: StoredRun;
try {
  const items = readJsonl(itemsPath);
  if (name === 'classification') {
    const labels = flag('labels', '').split(',').map((l) => l.trim()).filter(Boolean);
    if (labels.length === 0) usageError('classification needs --labels a,b,c');
    run = scoreItems(classification({ labels, multi: hasFlag('multi') }), label, items);
  } else if (name === 'extraction') {
    run = scoreItems(extraction, label, items);
  } else {
    usageError(`unknown rubric ${name}; one of classification, extraction\n${USAGE}`);
  }
} catch (e) {
  if (e instanceof RunError || e instanceof RubricError) usageError(e.message);
  usageError(String((e as Error).message));
}
writeFileSync(freshOutputOrExit(out), JSON.stringify(run, null, 1) + '\n');
const s = summarize(run);
console.log(`${run.rubric.name} "${label}": ${s.passes}/${s.scored} pass${s.failed ? `, ${s.failed} failed` : ''} -> ${out}`);
