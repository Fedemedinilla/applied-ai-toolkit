// The two widenings of the genre design (section 3.3): REG-02 and LEX-04 gain a phrase each, in
// every genre, cover letters included. Both are declared behaviour changes (CHANGELOG, 0.2.0).
import { describe, expect, it } from 'vitest';
import { GENRES } from '../src/genres.ts';
import { lint } from '../src/lint.ts';

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
