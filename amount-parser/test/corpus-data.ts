// Loads corpus/corpus.json with its type, for the test files that read it.

import { readFileSync } from 'node:fs';

export interface CorpusCase {
  phrase: string;
  family: string;
  kind: 'expense' | 'income';
  quantity: number | null;
  unit_price: number | null;
  total: number | null;
  ambiguous: boolean;
  note: string;
  corrected: boolean;
  source: 'first-sweep' | 'red-team';
  earlier_parser?: string;
  known_conflict?: string;
}

export const corpus: CorpusCase[] = JSON.parse(
  readFileSync(new URL('../corpus/corpus.json', import.meta.url), 'utf8'),
) as CorpusCase[];
