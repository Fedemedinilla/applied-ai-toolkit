// The parser's corpus, read from the data amount-parser publishes (corpus/corpus.json) rather
// than from its test helpers, which are not part of its interface (import-fences/repo.config.ts).

import { readFileSync } from 'node:fs';
import { readCorpus, type CorpusCase } from '../src/corpus.ts';

const raw: unknown = JSON.parse(readFileSync(new URL('../../../amount-parser/corpus/corpus.json', import.meta.url), 'utf8'));

/** Validated with the app's own reader. A case it would drop fails here instead of shrinking the tests. */
export const corpus: readonly CorpusCase[] = readCorpus(raw);
if (!Array.isArray(raw) || corpus.length !== raw.length) {
  throw new Error('amount-parser/corpus/corpus.json has cases the app cannot read');
}
