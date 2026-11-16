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

  it.each([
      'Está en la pág. 4 del informe.',
      'Son aprox. 30 horas por semana.',
      'Hay varias, p. ej. Astro y Next.',
      'Hay varias, p.ej. Astro y Next.',
      'Es el N.º 4 de la lista.',
      'Hablé con el Sr. Pérez, la Sra. Gómez y la Dra. Ruiz.',
      'Usamos Astro, Supabase, etc. para todo el sitio.',
      'Trabajé con clientes de EE.UU. y de Europa.',
      'Trabajé con clientes de EE. UU. y de Europa.',
      'Lo llamamos plan B. y funcionó.',
      'Escribí el informe con J. Pérez.',
      'I met Dr. Smith and Mr. Jones.',
      'Use a tool, e.g. Astro, or a framework, i.e. Next.',
      'Astro vs. Next is the question.',
      'I worked in the U.S. for two years.',
      'J. R. R. Tolkien wrote it.',
      'I wrote it with J. Smith.',
  ])('keeps "%s" as one sentence across its abbreviations', (t) => {
    expect(texts(t)).toEqual([t]);
  });

  it.each([
    ['Usamos Astro, Supabase, etc.', 'Después fuimos al cine.'],
    ['Trabajé con clientes de EE.UU.', 'Después volví.'],
    ['Trabajé con clientes de EE. UU.', 'Ahora estoy en Europa.'],
    ['Tenemos un plan B.', 'Si falla, seguimos.'],
    ['We tried Astro, Next, etc.', 'Then we chose Astro.'],
    ['I work for Acme Inc.', 'The team is small.'],
    ['Probamos Astro, Next, etc.', '¿Cuál elegimos?'],
  ])('ends "%s" at its abbreviation when "%s" starts in uppercase', (first, second) => {
    expect(texts(`${first} ${second}`)).toEqual([first, second]);
  });

  it.each([
    'Hablé con el señor J. Pérez ayer.',
    'Le escribí a J. Pérez ayer.',
    'Lo escribió M. López en 2020.',
    'La autora es J. K. Rowling.',
    'El ingeniero M. Gómez revisó el código.',
    'Me reuní en Rosario con la arquitecta A. Fernández.',
    'Nadal vs. A. Murray fue la final.',
    'I met author J. K. Rowling once.',
    'I sent it to the author J. Smith last week.',
  ])('keeps the initial in "%s" inside the sentence after any word', (t) => {
    expect(texts(t)).toEqual([t]);
  });

  // A word that is not a letter after "etc." and the like: the period stays inside the sentence
  // unless that word starts in uppercase, past opening punctuation.
  it.each([
    'Usamos Astro, etc. 30 horas por semana.',
    'Usamos Astro, etc. «para» todo.',
    'Usamos Astro, etc. (para todo) y Next.',
    'Trabajé en RR. HH. 3 años.',
    'Trabajé en EE. UU. 2 años.',
    'Trabajé en Acme Inc. 3 años.',
    'Trabajé en Acme Ltd. 3 años.',
    'Lo firmó John Smith Jr. 2 veces.',
    'Ver cf. Smith 2020 para más detalle.',
    'Es el núm. 4 de la lista.',
    'Ver págs. 4 a 6 del informe.',
  ])('keeps "%s" as one sentence when no uppercase word follows the abbreviation', (t) => {
    expect(texts(t)).toEqual([t]);
  });

  it.each([
    ['Tardó una hora aprox.', 'Después siguió.'],
    ['Trabajamos 30 horas aprox.', 'Después bajamos a 20.'],
    ['It took an hour approx.', 'Then it ended.'],
    ['Usamos Astro, etc.', '«Después» vino Next.'],
    ['Usamos Astro, etc.', '(Después vino Next.)'],
    ['I work for Acme Ltd.', 'The team is small.'],
    ['Nos falta la vitamina C.', 'Por eso la compramos.'],
  ])('ends "%s" before "%s", which starts in uppercase', (first, second) => {
    expect(texts(`${first} ${second}`)).toEqual([first, second]);
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
