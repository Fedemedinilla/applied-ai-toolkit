// The two widenings of the genre design (section 3.3): REG-02 and LEX-04 gain a phrase each, in
// every genre, cover letters included. Both are declared behaviour changes (CHANGELOG, 0.2.0).
import { describe, expect, it } from 'vitest';
import { applySetting, GENRES } from '../src/genres.ts';
import { lint } from '../src/lint.ts';
import { ruleById } from '../src/rules.ts';

describe('REG-02 reports "me encantaría tener la oportunidad de"', () => {
  // Section 11, item 4 of the report lists it among the calques REG-02 detects.
  const text = 'Me encantaría tener la oportunidad de sumarme al equipo de Lumbre.';

  for (const genre of GENRES) {
    it(`in ${genre}`, () => {
      const result = lint(text, { lang: 'es', genre });
      const hits = result.findings.filter((f) => f.ruleId === 'REG-02');
      expect(hits.map((f) => f.match)).toEqual(['Me encantaría tener la oportunidad de']);
    });
  }

  it('leaves a plain "me encantaría" alone', () => {
    const result = lint('Me encantaría charlar el jueves.', { lang: 'es' });
    expect(result.findings.map((f) => f.ruleId)).not.toContain('REG-02');
  });
});

describe('LEX-04 counts "this matters" and "why X matters" as Tier 2 words at low severity', () => {
  // Section 4.1 of the report: Graphite, a commercial analytics firm, reported both phrases in a
  // recent Claude model [REPORTADO, commercial source], so they enter at low severity.
  const lex04 = (text: string, genre: (typeof GENRES)[number]) => {
    const result = lint(text, { lang: 'en', genre });
    return {
      tier2Used: result.stats.tier2Used,
      reported: result.findings.filter((f) => f.ruleId === 'LEX-04').map((f) => [f.match, f.severity]),
    };
  };

  for (const genre of GENRES) {
    it(`in ${genre}: "this matters" spends the Tier 2 budget and is reported at low once it is spent`, () => {
      expect(lex04('This matters for the March close.', genre)).toEqual({ tier2Used: 1, reported: [] });
      expect(lex04('The pivotal work was robust. This matters for the March close.', genre)).toEqual({
        tier2Used: 3,
        reported: [['This matters', 'low']],
      });
    });

    it(`in ${genre}: "why X matters" is one Tier 2 word, and the words before it keep their severity`, () => {
      expect(lex04('Here is why the Rosario branch matters. The work was pivotal and robust.', genre)).toEqual({
        tier2Used: 3,
        reported: [['robust', 'medium']],
      });
      expect(lex04('The work was pivotal and robust. That is why it matters.', genre)).toEqual({
        tier2Used: 3,
        reported: [['why it matters', 'low']],
      });
    });
  }

  it('leaves other uses of "matters" alone', () => {
    const result = lint('The matters on the agenda were the March close. It matters little.', { lang: 'en' });
    expect(result.stats.tier2Used).toBe(0);
  });

  it('takes the severity a setting gives the rule', () => {
    const result = lint('The work was pivotal and robust. This matters.', { lang: 'en', rules: [ruleById('LEX-04')].map((r) => applySetting(r, { severity: 'high' })!) });
    expect(result.findings.map((f) => [f.match, f.severity])).toEqual([['This matters', 'high']]);
  });
});
