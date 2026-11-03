/**
 * Offline: unblinds the verdicts and prints the results table as Markdown.
 *
 *   node evals/scripts/aggregate.ts <pieces.jsonl> <key.json> <verdicts.jsonl> [--judges N] [--allow-missing]
 *
 * Stops on anything that would give one variant a different denominator: a
 * piece with fewer judges than the rest, a failed call, a cut run. With
 * --allow-missing, failed calls and uneven totals are reported in the table
 * instead.
 */
import { readFileSync } from 'node:fs';
import { VARIANTS } from '../example/variants.ts';
import { aggregate, toMarkdown } from '../src/aggregate.ts';
import type { BlindKey, BlindPiece } from '../src/blind.ts';
import { readJsonl } from '../src/files.ts';
import { flag, hasFlag, intFlag, positional, usageError } from './cli.ts';

const [piecesPath, keyPath, verdictsPath] = positional(3, 'usage: node evals/scripts/aggregate.ts <pieces.jsonl> <key.json> <verdicts.jsonl> [--judges N] [--allow-missing]') as [string, string, string];
const { key } = JSON.parse(readFileSync(keyPath, 'utf8')) as { key: BlindKey };
const judges = flag('judges', '') === '' ? undefined : intFlag('judges', 1);
let rows;
try {
  rows = aggregate(readJsonl<BlindPiece>(piecesPath), key, readJsonl(verdictsPath), { judges, allowMissing: hasFlag('allow-missing') });
} catch (e) {
  usageError(String((e as Error).message));
}
const used = new Set(rows.map((r) => r.variant));
console.log(toMarkdown(rows, Object.fromEntries(VARIANTS.filter((v) => used.has(v.id)).map((v) => [v.id, v.what]))));
