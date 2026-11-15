/**
 * Offline: splits an eval run into blind pieces for the judge and a key that
 * the judge never sees.
 *
 *   node evals/scripts/blind.ts <rows.jsonl> <pieces.jsonl> <key.json> [--seed N]
 *
 * Without --seed a random one is drawn and written into the key, so the
 * blinding can be rebuilt later. Failed calls, refusals and empty replies go
 * into the key only: there is nothing in them to judge.
 */
import { randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { blind } from '../src/blind.ts';
import { appendJsonl, readJsonl } from '../src/files.ts';
import type { EvalFailure, EvalRow } from '../src/runner.ts';
import { flag, freshOutputsOrExit, positional, usageError } from './cli.ts';

const [rowsPath, piecesPath, keyPath] = positional(3, 'usage: node evals/scripts/blind.ts <rows.jsonl> <pieces.jsonl> <key.json> [--seed N]') as [string, string, string];
const rawSeed = flag('seed', String(randomInt(2 ** 31)));
const seed = Number(rawSeed);
// The key has to record the seed the shuffle really used. NaN would be stored
// as null while mulberry32 used 0, and a fraction or a value past 2^32 - 1
// would be stored as typed but used truncated.
if (rawSeed.trim() === '' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) usageError('--seed must be an integer from 0 to 4294967295');
const { pieces, key } = blind(readJsonl<EvalRow | EvalFailure>(rowsPath), seed);
freshOutputsOrExit([piecesPath, keyPath]);
for (const p of pieces) appendJsonl(piecesPath, p);
writeFileSync(keyPath, JSON.stringify({ seed, key }, null, 1));
const withheld = Object.values(key).filter((k) => k.withheld).length;
console.log(`${pieces.length} pieces -> ${piecesPath}; key -> ${keyPath} (do not hand the key to the judge)`);
if (withheld) console.log(`${withheld} row(s) withheld from the judge (failed, refused or empty); the results table counts them per variant`);
