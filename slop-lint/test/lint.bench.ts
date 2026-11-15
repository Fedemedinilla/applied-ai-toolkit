// lint() over a long document, in English and in Spanish. The document is the "before" cover
// letter of the fixtures repeated 40 times (about 29,000 and 33,000 characters), so every
// repetition has findings and the cost of reporting them is part of the number.
//
//   npm run bench
//
// The numbers are compared with test/bench/baseline.json by `npm run bench:compare`.

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { lint } from '../src/lint.ts';

const REPEATS = 40;
const fixture = (name: string) => readFileSync(new URL(`../fixtures/cover-letters/${name}`, import.meta.url), 'utf8');
const long = (letter: string) => Array.from({ length: REPEATS }, () => letter).join('\n\n');

const en = long(fixture('en-before.txt'));
const es = long(fixture('es-rioplatense-before.txt'));

test('slop-lint: lint a long English document', async ({ bench }) => {
  let findings = 0;
  await bench('slop-lint/lint-long-en', { writeResult: 'reports/bench/raw/slop-lint/lint-long-en.json' }, () => {
    findings = lint(en, { lang: 'en' }).findings.length;
  }).run();
  // Every repetition of the letter was linted: at least one finding in each.
  expect(findings).toBeGreaterThanOrEqual(REPEATS);
});

test('slop-lint: lint a long Spanish document', async ({ bench }) => {
  let findings = 0;
  await bench('slop-lint/lint-long-es', { writeResult: 'reports/bench/raw/slop-lint/lint-long-es.json' }, () => {
    findings = lint(es, { lang: 'es' }).findings.length;
  }).run();
  expect(findings).toBeGreaterThanOrEqual(REPEATS);
});
