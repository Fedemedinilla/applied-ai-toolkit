/**
 * Offline: the CI gate. Compares two stored runs and exits by the result.
 *
 *   node evals/scripts/gate.ts <baseline.json> <candidate.json> [--margin 0.1] [--json | --markdown]
 *        [--summary <file>] [--allow-missing]
 *
 * Exit codes:
 *   0  pass          the candidate is not worse, within the margin
 *   1  fail          the candidate is worse
 *   2  refused       bad usage, or the runs cannot be compared (another rubric
 *                    or version, other cases, missing results)
 *   3  inconclusive  the samples are too small to say either
 *
 * The rule and its reason are in src/gate.ts. --summary appends the Markdown
 * summary to a file, for example "$GITHUB_STEP_SUMMARY". Nothing here calls a
 * model.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { DEFAULT_MARGIN, gate, gateMarkdown, GateRefusal, gateText } from '../src/gate.ts';
import { parseRun, RunError, type StoredRun } from '../src/run.ts';
import { flag, hasFlag, positional, usageError } from './cli.ts';

const USAGE = 'usage: node evals/scripts/gate.ts <baseline.json> <candidate.json> [--margin 0.1] [--json | --markdown] [--summary <file>] [--allow-missing]';
const [baselinePath, candidatePath] = positional(2, USAGE) as [string, string];

function load(path: string): StoredRun {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    usageError(`${path}: cannot read as JSON (${String((e as Error).message).slice(0, 120)})`);
  }
  try {
    return parseRun(raw, path);
  } catch (e) {
    if (e instanceof RunError) usageError(e.message);
    throw e;
  }
}

let result;
try {
  result = gate(load(baselinePath), load(candidatePath), { margin: Number(flag('margin', String(DEFAULT_MARGIN))), allowMissing: hasFlag('allow-missing') });
} catch (e) {
  if (e instanceof GateRefusal) usageError(`gate: REFUSED (exit 2)\n${e.message}`);
  throw e;
}

const summary = flag('summary', '');
if (summary) appendFileSync(summary, gateMarkdown(result) + '\n');
console.log(hasFlag('json') ? JSON.stringify(result, null, 1) : hasFlag('markdown') ? gateMarkdown(result) : gateText(result));
process.exitCode = result.exitCode;
