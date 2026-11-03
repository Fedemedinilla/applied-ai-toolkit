import { describe, expect, it } from 'vitest';
import { countAnchors, isProse, lineColumn, lineStarts, splitSentences, words } from '../src/text.ts';

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
