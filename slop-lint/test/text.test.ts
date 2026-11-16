import { describe, expect, it } from 'vitest';
import { extractAnchors as publicExtractAnchors } from '../src/lint.ts';
import { countAnchors, extractAnchors, isProse, lineColumn, lineStarts, splitSentences, words } from '../src/text.ts';

const texts = (t: string) => splitSentences(t).map((s) => s.text);

describe('splitSentences', () => {
  it('splits on terminal punctuation and keeps offsets', () => {
    const t = 'I built it. It runs weekly! Does it work?';
    const spans = splitSentences(t);
    expect(spans.map((s) => s.text)).toEqual(['I built it.', 'It runs weekly!', 'Does it work?']);
    for (const s of spans) expect(t.slice(s.start, s.end)).toBe(s.text);
  });

  it('does not split after abbreviations, initials or decimals', () => {
    expect(texts('Dear Ms. Reyes, I applied. It took 3.5 hours.')).toEqual(['Dear Ms. Reyes, I applied.', 'It took 3.5 hours.']);
    expect(texts('Estimada Sra. Paredes, me postulo.')).toEqual(['Estimada Sra. Paredes, me postulo.']);
    expect(texts('Trabajé con J. Pérez en RR. HH. el año pasado.')).toHaveLength(1);
    expect(texts('I moved to the U.S. Army in 2020. I like it.')).toEqual(['I moved to the U.S. Army in 2020.', 'I like it.']);
    expect(texts('Trabajé para EE.UU. desde 2021. Me gustó.')).toHaveLength(2);
  });

  it('treats a line break as a boundary unless the next line continues in lowercase', () => {
    expect(texts('Dear Ms. Reyes,\nI am applying.')).toEqual(['Dear Ms. Reyes,', 'I am applying.']);
    expect(texts('I built the dashboard that\nthe managers review.')).toEqual(['I built the dashboard that\nthe managers review.']);
    expect(texts('Sincerely,\nLucía Ferreyra')).toEqual(['Sincerely,', 'Lucía Ferreyra']);
  });

  it('keeps a closing quote or parenthesis with its sentence', () => {
    expect(texts('Lo llamamos «cierre.» Después cambió.')).toEqual(['Lo llamamos «cierre.»', 'Después cambió.']);
  });
});

describe('isProse', () => {
  it('leaves out salutations and signatures', () => {
    const [greeting, body, name] = splitSentences('Dear Ms. Reyes,\nI am applying for the role.\nLucía Ferreyra');
    expect(greeting && isProse(greeting)).toBe(false);
    expect(body && isProse(body)).toBe(true);
    expect(name && isProse(name)).toBe(false);
  });
});

describe('countAnchors', () => {
  it('counts numbers, number words, acronyms and proper nouns, not the first word or "I"', () => {
    expect(countAnchors('I love working with the team.', 'en')).toBe(0);
    expect(countAnchors('I led a team of 4 analysts.', 'en')).toBe(1);
    expect(countAnchors('Lideré un equipo de cuatro personas.', 'es')).toBe(1);
    expect(countAnchors('Trabajo con SQL en Contoso Agro.', 'es')).toBe(3);
    expect(countAnchors('Una persona proactiva.', 'es')).toBe(0);
  });

  it('counts lowercase tools and caller-supplied terms', () => {
    expect(countAnchors('uso dbt a diario.', 'es')).toBe(1);
    expect(countAnchors('uso airflow a diario.', 'es')).toBe(0);
    expect(countAnchors('uso airflow a diario.', 'es', ['airflow'])).toBe(1);
  });

  it('trims the extra terms, so a blank one anchors nothing', () => {
    expect(countAnchors('i am a proactive and passionate person.', 'en', [' '])).toBe(0);
    expect(countAnchors('i am a proactive and passionate person.', 'en', ['x '])).toBe(0);
    expect(countAnchors('uso airflow a diario.', 'es', [' airflow '])).toBe(1);
  });

  it('matches a multi-word term as whole words, not as a substring', () => {
    expect(countAnchors('We report in power bi.', 'en', ['Power BI'])).toBe(1);
    expect(countAnchors('We report in power\nbi.', 'en', ['Power BI'])).toBe(1);
    expect(countAnchors('We read the power bill.', 'en', ['Power BI'])).toBe(0);
    expect(countAnchors('We moved from nosql serverless.', 'en', ['SQL Server'])).toBe(0);
    expect(countAnchors('uso contoso agro (c++) a diario.', 'es', ['agro (c++)'])).toBe(1);
  });
});

describe('words and positions', () => {
  it('keeps contractions, hyphenated words and accents together', () => {
    expect(words("I'd use data-driven métricas.").map((w) => w.text)).toEqual(["I'd", 'use', 'data-driven', 'métricas']);
  });

  it('converts offsets to 1-based line and column', () => {
    const t = 'ab\ncd\nef';
    const starts = lineStarts(t);
    expect(lineColumn(starts, 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumn(starts, 4)).toEqual({ line: 2, column: 2 });
    expect(lineColumn(starts, 6)).toEqual({ line: 3, column: 1 });
  });
});

describe('extractAnchors', () => {
  it('returns the anchor terms countAnchors counts, in order', () => {
    expect(extractAnchors('I led a team of 4 analysts.', 'en')).toEqual(['4']);
    expect(extractAnchors('Lideré un equipo de cuatro personas.', 'es')).toEqual(['cuatro']);
    expect(extractAnchors('Trabajo con SQL en Contoso Agro.', 'es')).toEqual(['SQL', 'Contoso', 'Agro']);
    expect(extractAnchors('uso airflow a diario.', 'es', [' airflow '])).toEqual(['airflow']);
    expect(extractAnchors('We report in power\nbi.', 'en', ['Power BI'])).toEqual(['power\nbi']);
    expect(extractAnchors('Una persona proactiva.', 'es')).toEqual([]);
  });

  it('agrees with countAnchors on every case countAnchors is tested on', () => {
    const cases: Array<[string, 'en' | 'es', string[]]> = [
      ['I love working with the team.', 'en', []],
      ['I led a team of 4 analysts.', 'en', []],
      ['Lideré un equipo de cuatro personas.', 'es', []],
      ['Trabajo con SQL en Contoso Agro.', 'es', []],
      ['Una persona proactiva.', 'es', []],
      ['uso dbt a diario.', 'es', []],
      ['uso airflow a diario.', 'es', ['airflow']],
      ['i am a proactive and passionate person.', 'en', [' ']],
      ['We report in Power BI and SQL Server.', 'en', ['Power BI', 'SQL Server']],
      ['We read the power bill.', 'en', ['Power BI']],
      ['uso contoso agro (c++) a diario.', 'es', ['agro (c++)']],
    ];
    for (const [sentence, lang, extra] of cases) {
      expect(extractAnchors(sentence, lang, extra)).toHaveLength(countAnchors(sentence, lang, extra));
    }
  });

  it('is published from the entry point', () => {
    expect(publicExtractAnchors).toBe(extractAnchors);
  });
});
