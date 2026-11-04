// Times parseAmount over every corpus phrase and prints the average per phrase.
//
//   node amount-parser/bench.ts
//
// A rough number for one machine, not a benchmark suite: it warms up, then runs the corpus 200 times.

import { readFileSync } from 'node:fs';
import { parseAmount } from './src/index.ts';

const corpus = JSON.parse(readFileSync(new URL('./corpus/corpus.json', import.meta.url), 'utf8')) as Array<{ phrase: string }>;
const phrases = corpus.map((c) => c.phrase);
const ROUNDS = 200;

for (let i = 0; i < 20; i++) for (const p of phrases) parseAmount(p);

const start = performance.now();
for (let i = 0; i < ROUNDS; i++) for (const p of phrases) parseAmount(p);
const elapsed = performance.now() - start;

const perPhrase = (elapsed * 1000) / (ROUNDS * phrases.length);
console.log(`${phrases.length} phrases x ${ROUNDS} rounds: ${perPhrase.toFixed(1)} µs per phrase (Node ${process.versions.node})`);
