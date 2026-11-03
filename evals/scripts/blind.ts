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
import { flag, freshOutputOrExit, positional } from './cli.ts';

const [rowsPath, piecesPath, keyPath] = positional(3, 'usage: node evals/scripts/blind.ts <rows.jsonl> <pieces.jsonl> <key.json> [--seed N]') as [string, string, string];
const seed = Number(flag('seed', String(randomInt(2 ** 31))));
const { pieces, key } = blind(readJsonl<EvalRow | EvalFailure>(rowsPath), seed);
freshOutputOrExit(piecesPath);
freshOutputOrExit(keyPath);
for (const p of pieces) appendJsonl(piecesPath, p);
writeFileSync(keyPath, JSON.stringify({ seed, key }, null, 1));
const withheld = Object.values(key).filter((k) => k.withheld).length;
console.log(`${pieces.length} pieces -> ${piecesPath}; key -> ${keyPath} (do not hand the key to the judge)`);
if (withheld) console.log(`${withheld} row(s) withheld from the judge (failed, refused or empty); the results table counts them per variant`);
