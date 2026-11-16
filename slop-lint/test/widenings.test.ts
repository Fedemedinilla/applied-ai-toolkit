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

describe('a "why X matters" phrase never swallows a full-strength hit inside X', () => {
  // dropCovered() keeps the longer of two nested hits. The weaker phrase is longer than any word
  // inside X, so without this guard it would demote a medium Tier 2 word to low, hide a repeat
  // and drop another rule's finding. The outputs below are the ones before the widening.
  const lintEn = (text: string) => {
    const result = lint(text, { lang: 'en' });
    return {
      points: result.score.points,
      tier2Used: result.stats.tier2Used,
      reported: result.findings.map((f) => [f.ruleId, f.match, f.severity]),
    };
  };

  it('keeps a Tier 2 word inside X at medium once the budget is spent', () => {
    expect(lintEn('The work was pivotal and robust. Why innovative design matters.')).toEqual({
      points: 13.5,
      tier2Used: 3,
      reported: [['LEX-04', 'innovative', 'medium']],
    });
    expect(lintEn('Additionally, I wrote the docs. Moreover, I fixed it. I explain why this pivotal work matters.')).toEqual({
      points: 13.5,
      tier2Used: 3,
      reported: [['LEX-04', 'pivotal', 'medium']],
    });
  });

  it('reports a Tier 2 word repeated inside X', () => {
    const result = lint('Key role. Why the key role matters.', { lang: 'en' });
    expect(result.findings.map((f) => [f.ruleId, f.match, f.severity])).toEqual([['LEX-04', 'key role', 'medium']]);
    expect(result.findings[0]?.detail).toContain('repeated');
  });

  it("keeps another rule's hit inside X", () => {
    expect(lintEn('I explain why it really matters. I really like it.')).toEqual({
      points: 14.5,
      tier2Used: 0,
      reported: [['LEX-05', 'really', 'low']],
    });
  });

  it('still counts a phrase with nothing else inside it once', () => {
    expect(lintEn('The work was pivotal and robust. That is why this matters.').reported).toEqual([['LEX-04', 'why this matters', 'low']]);
  });
});
