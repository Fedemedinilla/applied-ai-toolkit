// parseAmount over every corpus phrase. One iteration is the whole corpus, so a sample is long
// enough for the timer and the mix of families is the corpus's own.
//
//   npm run bench
//
// The number is compared with test/bench/baseline.json by `npm run bench:compare`.

import { expect, test } from 'vitest';
import { parseAmount } from '../src/index.ts';
import { corpus } from './corpus-data.ts';

const phrases = corpus.map((c) => c.phrase);
/** How many phrases give a reading, counted once outside the timed loop. */
const expected = phrases.filter((phrase) => parseAmount(phrase) !== null).length;

test('amount-parser: parse the corpus', async ({ bench }) => {
  let readings = 0;
  await bench('amount-parser/parse-corpus', { writeResult: 'reports/bench/raw/amount-parser/parse-corpus.json' }, () => {
    readings = 0;
    for (const phrase of phrases) if (parseAmount(phrase) !== null) readings += 1;
  }).run();
  // The timed loop went through the whole corpus and got the readings it gets outside the bench.
  expect(phrases.length).toBeGreaterThan(100);
  expect(expected).toBeGreaterThan(100);
  expect(readings).toBe(expected);
});
