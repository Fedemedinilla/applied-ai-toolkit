// The refactor safety net. reference-output.json holds the full output of the source parser,
// recorded before the split into named steps, for every corpus phrase and every hand-written case
// (212 phrases). The split must reproduce it field for field: value, literal, source, quantity,
// unitPrice, ambiguous, reason and approximate. Spans are new and are tested in spans.test.ts.
//
// After a deliberate behaviour change, re-record the file from the current parser with
//
//   UPDATE_REFERENCE=1 npx vitest run amount-parser/test/reference.test.ts
//
// and say in the commit which phrases changed (git diff on the JSON shows them).

import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAmount, type ParsedAmount } from '../src/index.ts';

const file = new URL('./reference-output.json', import.meta.url);
const reference = JSON.parse(readFileSync(file, 'utf8')) as Array<{
  phrase: string;
  output: Omit<ParsedAmount, 'spans'> | null;
}>;

if (process.env['UPDATE_REFERENCE'] === '1') {
  const recorded = reference.map(({ phrase }) => {
    const r = parseAmount(phrase);
    if (r === null) return { phrase, output: null };
    const { spans: _spans, ...output } = r;
    return { phrase, output };
  });
  writeFileSync(file, JSON.stringify(recorded, null, 1) + '\n');
  reference.splice(0, reference.length, ...recorded);
}

describe('output matches the source parser', () => {
  it('covers 212 phrases', () => {
    expect(reference).toHaveLength(212);
  });

  it.each(reference)('$phrase', ({ phrase, output }) => {
    const r = parseAmount(phrase);
    if (output === null) {
      expect(r).toBeNull();
      return;
    }
    expect(r).not.toBeNull();
    const { spans: _spans, ...rest } = r!;
    expect(rest).toStrictEqual(output);
  });
});
