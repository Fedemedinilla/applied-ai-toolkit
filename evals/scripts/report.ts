/**
 * Offline: writes a stored run, or a comparison of two, as one HTML file.
 *
 *   node evals/scripts/report.ts <run.json> <out.html>
 *   node evals/scripts/report.ts <baseline.json> <candidate.json> <out.html> [--margin 0.1] [--allow-missing]
 *
 * The file needs nothing else to be read: no script, no external asset. The
 * comparison carries the gate's decision and refuses, like the gate, two runs
 * that cannot be compared.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_MARGIN, GateRefusal } from '../src/gate.ts';
import { renderComparisonReport, renderRunReport } from '../src/report.ts';
import { parseRun, type StoredRun } from '../src/run.ts';
import { freshOutputOrExit, hasFlag, numberFlag, positional, usageError } from './cli.ts';

const args = positional(2, 'usage: node evals/scripts/report.ts <run.json> [<candidate.json>] <out.html> [--margin 0.1] [--allow-missing]');
if (args.length > 3) usageError('report takes one run or two (baseline, candidate) and the output file');
const out = args.at(-1)!;

function load(path: string): StoredRun {
  try {
    return parseRun(JSON.parse(readFileSync(path, 'utf8')), path);
  } catch (e) {
    usageError(`${path}: ${String((e as Error).message).slice(0, 200)}`);
  }
}

let html: string;
try {
  html =
    args.length === 2
      ? renderRunReport(load(args[0]!))
      : renderComparisonReport(load(args[0]!), load(args[1]!), { margin: numberFlag('margin', DEFAULT_MARGIN), allowMissing: hasFlag('allow-missing') });
} catch (e) {
  if (e instanceof GateRefusal) usageError(`report: the runs cannot be compared\n${e.message}`);
  throw e;
}
writeFileSync(freshOutputOrExit(out), html);
console.log(`report -> ${out}`);
