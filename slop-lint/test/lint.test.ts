import { describe, expect, it } from 'vitest';
import { lint } from '../src/lint.ts';

const ids = (text: string, lang: 'en' | 'es', anchors?: string[]) =>
  lint(text, anchors ? { lang, anchors } : { lang }).findings.map((f) => f.ruleId);

describe('Tier 2 budget', () => {
  it('tolerates two different Tier 2 words and reports the third', () => {
    expect(ids('The pivotal work was robust.', 'en')).toEqual([]);
    const result = lint('The pivotal work was robust and comprehensive.', { lang: 'en' });
    expect(result.findings.map((f) => [f.ruleId, f.match])).toEqual([['LEX-04', 'comprehensive']]);
    expect(result.findings[0]?.detail).toMatch(/budget is 2/);
    expect(result.stats.tier2Used).toBe(3);
  });

  it('reports a repeated Tier 2 word even under budget', () => {
    const result = lint('Fue un cambio fundamental. Fue fundamental para el área.', { lang: 'es' });
    expect(result.findings.map((f) => f.ruleId)).toEqual(['LEX-02']);
    expect(result.findings[0]?.detail).toMatch(/repeated/);
  });

  it('pools Tier 3 words without an anchor into the same budget', () => {
    expect(ids('I like the team. I like the impact. I like the results.', 'en')).toEqual(['LEX-08']);
    expect(ids('I led a team of 4. I measured the impact in 2023. Results came in May.', 'en')).toEqual([]);
  });
});

describe('anchors', () => {
  it('lets a self-assessment adjective through when the sentence carries a fact', () => {
    expect(ids('Soy una persona proactiva.', 'es')).toContain('ESP-04');
    expect(ids('Fui proactiva: en 2023 automaticé el cierre con Python.', 'es')).not.toContain('ESP-04');
  });

  it('accepts anchors from the caller, such as lowercase tools from the CV', () => {
    expect(ids('Me apasiona el equipo. Me gusta el impacto. Uso airflow con el equipo de datos.', 'es')).toContain('LEX-07');
    const withAnchor = lint('Uso airflow con el equipo.', { lang: 'es', anchors: ['airflow'] });
    expect(withAnchor.findings.map((f) => f.ruleId)).not.toContain('LEX-07');
    expect(withAnchor.stats.tier2Used).toBe(0);
  });
});

describe('overlaps, quotes and languages', () => {
  it('charges each span once, to the stricter rule', () => {
    expect(ids('I am passionate about data.', 'en')).toEqual(['LEX-03']);
    expect(ids('Ultimately, I wrote the report.', 'en')).toEqual(['EST-05']);
    expect(ids('Quiero agregar valor.', 'es')).toEqual(['LEX-01']);
  });

  it('skips banned phrases inside quotes', () => {
    expect(ids('The posting asks for a "proven track record" in SQL.', 'en')).toEqual([]);
    expect(ids('The posting asks for a proven track record in SQL.', 'en')).toEqual(['LEX-03']);
  });

  it('does not let a stray quote mark exempt the sentences after it', () => {
    expect(ids('He said "hi. I am passionate about data. Then "bye" again.', 'en')).toEqual(['LEX-03']);
    // A "quotation" longer than 80 characters is not treated as one.
    expect(ids(`The posting says "${'x '.repeat(45)}proven track record" twice.`, 'en')).toContain('LEX-03');
    expect(ids('The posting says "proven track record" twice.', 'en')).not.toContain('LEX-03');
  });

  it('counts "Overall," and "Ultimately," as closers only in the last two prose sentences', () => {
    expect(ids('I wrote the 12 reports. Overall, the cost fell 12% in 2023. I documented it in 2024. I want the role.', 'en')).toEqual([]);
    expect(ids('I wrote the 12 reports in 2023. I documented them in 2024. Overall, I am a strong fit.', 'en')).toEqual(['EST-05']);
    expect(ids('In conclusion, I wrote the 12 reports in 2023. I documented them in 2024. I want the role.', 'en')).toEqual(['EST-05']);
  });

  it('applies only the rules of the requested language', () => {
    expect(ids('I have a proven track record.', 'es')).toEqual([]);
    expect(ids('Por medio de la presente me postulo.', 'en')).toEqual([]);
  });

  it('matches Spanish words that end in an accented vowel, which \\b cannot do', () => {
    expect(ids('Lideré la migración, logrando bajar costos.', 'es')).toContain('EST-08');
    expect(/Lideré\b/u.test('Lideré la')).toBe(false);
  });
});

describe('result', () => {
  it('returns offsets that slice back to the match, with line and column', () => {
    const text = 'Hello.\nIn summary, I like SQL.';
    const [f] = lint(text, { lang: 'en' }).findings;
    expect(f).toMatchObject({ ruleId: 'EST-05', line: 2, column: 1, level: 1, severity: 'high' });
    expect(f && text.slice(f.start, f.end)).toBe(f?.match);
  });

  it('scores the slop dimension with the rubric weights', () => {
    expect(lint('I built the dashboard in 2023.', { lang: 'en' }).score).toEqual({ points: 15, max: 15 });
    expect(lint('In summary, I built it in 2023.', { lang: 'en' }).score.points).toBe(12);
    expect(lint('In summary, to be honest, I delve into SQL.', { lang: 'en' }).score.points).toBe(0);
  });

  it('marks a placeholder as disqualifying', () => {
    const result = lint('I would love to join [Company Name] in 2027.', { lang: 'en' });
    expect(result.disqualified).toBe(true);
    expect(result.passesTier1).toBe(false);
    expect(result.score.points).toBe(0);
  });

  it('is pure', () => {
    const text = 'Por medio de la presente, en resumen, me postulo.';
    expect(lint(text, { lang: 'es' })).toEqual(lint(text, { lang: 'es' }));
  });

  it('handles empty input', () => {
    const result = lint('', { lang: 'en' });
    expect(result.findings).toEqual([]);
    expect(result.passesTier1).toBe(true);
    expect(result.stats.sentenceLengthCV).toBeNull();
  });
});

describe('structural checks', () => {
  it('flags a mix of voseo and tuteo at the minority register', () => {
    const result = lint('Si querés, te muestro el tablero. Si podés, avisame. Si puedes, escribime.', { lang: 'es' });
    expect(result.findings.filter((f) => f.ruleId === 'REG-01').map((f) => f.match)).toEqual(['puedes']);
  });

  it('allows one em dash in English and reports the second', () => {
    expect(ids('I wrote it — all of it.', 'en')).toEqual([]);
    expect(ids('I wrote it — all of it — alone.', 'en')).toEqual(['ORT-05']);
  });

  it('allows one aside between rayas in Spanish and reports the second', () => {
    expect(ids('Trabajé con Ana —una analista— en 2023.', 'es')).toEqual([]);
    expect(ids('Trabajé con Ana —una analista— y con Juan —un ingeniero— en 2023.', 'es')).toEqual(['ORT-04']);
  });

  it('checks the opening sign per sentence', () => {
    expect(ids('¿Querés verlo? Querés verlo?', 'es')).toEqual(['ORT-01']);
  });

  it('checks throat-clearing at every sentence start, not only the first', () => {
    expect(ids('Me postulo al puesto. Hoy en día los datos importan.', 'es')).toEqual(['EST-04']);
  });
});
