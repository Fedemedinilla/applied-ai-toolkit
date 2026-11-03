import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lint } from '../src/lint.ts';
import type { Lang } from '../src/types.ts';

const dir = new URL('../fixtures/cover-letters/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');

// Section 15 of the research report: the same fictional candidate writing to three
// fictional companies. "Before" is a model with no instructions; "after" passes the rubric.
const pairs: Array<{ name: string; lang: Lang; expectedBefore: string[] }> = [
  {
    name: 'es-rioplatense',
    lang: 'es',
    expectedBefore: ['LEX-01', 'EST-01', 'ESP-01', 'EST-08', 'ESP-04', 'SIN-11', 'RET-01', 'EST-05', 'REG-02'],
  },
  { name: 'es-neutral', lang: 'es', expectedBefore: ['LEX-01', 'EST-08', 'SIN-11', 'RET-01'] },
  { name: 'en', lang: 'en', expectedBefore: ['LEX-03', 'LEX-04', 'EST-08'] },
];

describe('section 15 cover letters', () => {
  for (const { name, lang, expectedBefore } of pairs) {
    it(`${name}: the "before" letter fails tier 1 with the failures the report annotates`, () => {
      const result = lint(read(`${name}-before.txt`), { lang });
      expect(result.passesTier1).toBe(false);
      for (const id of expectedBefore) expect(result.findings.map((f) => f.ruleId), id).toContain(id);
      expect(result.score.points).toBeLessThanOrEqual(6);
    });

    it(`${name}: the "after" letter passes tier 1`, () => {
      const result = lint(read(`${name}-after.txt`), { lang });
      expect(result.findings.filter((f) => f.level === 1)).toEqual([]);
      expect(result.passesTier1).toBe(true);
      expect(result.score.points).toBeGreaterThanOrEqual(13.5);
    });
  }

  it('the English "before" letter reports the three Tier 2 words the report annotates once the budget is spent', () => {
    const result = lint(read('en-before.txt'), { lang: 'en' });
    const tier2 = result.findings.filter((f) => f.ruleId === 'LEX-04').map((f) => f.match.toLowerCase());
    expect(tier2).toEqual(['dynamic', 'fostering', 'align with']);
  });

  it('the English "after" letter keeps one level 2 warning: a participle tail with a number in it', () => {
    const result = lint(read('en-after.txt'), { lang: 'en' });
    expect(result.findings.map((f) => f.ruleId)).toEqual(['EST-08']);
  });
});
