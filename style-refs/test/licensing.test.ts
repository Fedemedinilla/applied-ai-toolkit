import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXCERPT_MAX_SENTENCES, EXCERPT_MAX_WORDS, Source, US_FREE_THROUGH, validateRefs, type RefsData } from '../src/index.ts';

// The rules of design section 4.8, "Qué controla licensing.test.ts", tried on inline fixtures that
// break one rule each. The data on disk is checked against the same rules in the last block.

const empty: RefsData = { sources: [], principles: {}, excerpts: {}, examples: {} };

/** A literary source that may give excerpts: free in the United States, text from Gutenberg. */
const work = {
  id: 'plain-work',
  kind: 'literary',
  author: 'An invented author',
  work: 'An invented book',
  published: 1900,
  authorDied: 1920,
  lang: 'en',
  originalLang: 'en',
  nationality: ['us'],
  status: { ar: 'public-domain', us: 'public-domain', eu: 'public-domain', es: 'public-domain' },
  licence: 'public domain',
  url: 'https://www.gutenberg.org/ebooks/1',
  verified: '2026-11-15',
  evidence: 'REPORTADO',
  use: 'excerpts',
};
const excerpt = {
  id: 'plain-excerpt',
  source: 'plain-work',
  lang: 'en',
  text: 'He wrote short sentences. They worked.',
  teaches: 'brevity',
  avoid: 'the period spelling',
  url: 'https://www.gutenberg.org/cache/epub/1/pg1.txt',
  fetched: '2026-11-16',
};
const principle = {
  id: 'plain-principle',
  lang: 'en',
  genres: ['email'],
  registers: ['neutral'],
  text: 'Cut the words the sentence does not need.',
  check: 'No sentence loses a fact when a word is removed.',
  sources: ['plain-work'],
};

const withExcerpt = (src: object, ex: object = excerpt): RefsData => ({ ...empty, sources: [src], excerpts: { [`excerpts/${(ex as { lang: string }).lang}.json`]: [ex] } });
const messages = (data: RefsData): string[] => validateRefs(data).map((p) => `${p.file} ${p.path}: ${p.message}`);

describe('the valid fixture', () => {
  it('passes, so each failure below comes from the one field it breaks', () => {
    expect(messages({ ...withExcerpt(work), principles: { 'principles/en.json': [principle] } })).toEqual([]);
  });
});

describe('every source declares its status in four jurisdictions, its licence, URL, date and evidence', () => {
  for (const field of ['licence', 'url', 'verified', 'evidence', 'use'] as const) {
    it(`refuses a source with no ${field}`, () => {
      const { [field]: _gone, ...rest } = work;
      expect(validateRefs({ ...empty, sources: [rest] }).map((p) => `${p.file} ${p.path}`)).toEqual([`sources.json 0.${field}`]);
    });
  }
  for (const place of ['ar', 'us', 'eu', 'es'] as const) {
    it(`refuses a source with no status in ${place}`, () => {
      const { [place]: _gone, ...status } = work.status;
      expect(validateRefs({ ...empty, sources: [{ ...work, status }] }).map((p) => p.path)).toEqual([`0.status.${place}`]);
    });
  }
  it('refuses an empty licence', () => {
    expect(validateRefs({ ...empty, sources: [{ ...work, licence: '' }] }).map((p) => p.path)).toEqual(['0.licence']);
  });
  it('refuses an evidence tag outside the four of the report', () => {
    expect(validateRefs({ ...empty, sources: [{ ...work, evidence: 'FREE' }] }).map((p) => p.path)).toEqual(['0.evidence']);
  });
  it('refuses a date of freedom on a jurisdiction already marked free', () => {
    const problems = messages({ ...empty, sources: [{ ...work, freeFrom: { es: '2027-01-01' } }] });
    expect(problems).toEqual(['sources.json 0.freeFrom.es: free from 2027-01-01, so es cannot be public-domain yet']);
  });
});

describe('a translation names its translator and the year they died', () => {
  it('refuses a translation with no translator', () => {
    expect(messages({ ...empty, sources: [{ ...work, originalLang: 'ru' }] })).toEqual([
      'sources.json 0.translator: a translation from ru needs its translator and the year they died',
    ]);
  });
  it('refuses a translator without a year of death', () => {
    const problems = validateRefs({ ...empty, sources: [{ ...work, originalLang: 'ru', translator: { name: 'An invented translator' } }] });
    expect(problems.map((p) => p.path)).toEqual(['0.translator.died']);
  });
  it('refuses a translator on a work read in its own language', () => {
    expect(messages({ ...empty, sources: [{ ...work, translator: { name: 'An invented translator', died: 1930 } }] })).toEqual([
      'sources.json 0.translator: the work is read in its original language, so it has no translator',
    ]);
  });
});

describe('an excerpt comes only from a work in the public domain in the United States', () => {
  it('refuses an excerpt of a work protected in the United States', () => {
    const protectedThere = { ...work, status: { ...work.status, us: 'protected' } };
    expect(messages(withExcerpt(protectedThere))).toEqual([
      'sources.json 0.use: a source for excerpts must be public-domain in the US, and it is protected',
      'excerpts/en.json 0.source: plain-work is protected in the US; an excerpt needs public-domain there',
    ]);
  });
  it('refuses an excerpt of a work whose US status is unverified', () => {
    const unverified = { ...work, use: 'principles', status: { ...work.status, us: 'unverified' } };
    expect(messages(withExcerpt(unverified))).toEqual([
      'excerpts/en.json 0.source: plain-work is for principles only',
      'excerpts/en.json 0.source: plain-work is unverified in the US; an excerpt needs public-domain there',
    ]);
  });
  it('refuses an excerpt of an open-licence guide, which is not public domain', () => {
    const guide = { ...work, kind: 'guide', use: 'principles', status: { ar: 'open-licence', us: 'open-licence', eu: 'open-licence', es: 'open-licence' } };
    expect(messages(withExcerpt(guide))).toContain('excerpts/en.json 0.source: plain-work is open-licence in the US; an excerpt needs public-domain there');
  });
  it('refuses an excerpt and a principle of an excluded source', () => {
    const excluded = { ...work, use: 'excluded' };
    expect(messages({ ...withExcerpt(excluded), principles: { 'principles/en.json': [principle] } })).toEqual([
      'principles/en.json 0.sources.0: plain-work is excluded',
      'excerpts/en.json 0.source: plain-work is excluded',
    ]);
  });
  it(`refuses an excerpt source published after ${US_FREE_THROUGH}, or in a year nobody verified`, () => {
    expect(messages(withExcerpt({ ...work, published: US_FREE_THROUGH }))).toEqual([]);
    expect(messages(withExcerpt({ ...work, published: US_FREE_THROUGH + 1 }))).toEqual([
      `sources.json 0.published: a source for excerpts must be published in ${US_FREE_THROUGH} or earlier to be free in the US, and it is ${US_FREE_THROUGH + 1}`,
    ]);
    expect(messages(withExcerpt({ ...work, published: null }))).toEqual([
      `sources.json 0.published: a source for excerpts must be published in ${US_FREE_THROUGH} or earlier to be free in the US, and its year is unverified`,
    ]);
  });
  it('refuses a Gutenberg excerpt taken from an ebook other than its source', () => {
    expect(messages(withExcerpt(work, { ...excerpt, url: 'https://www.gutenberg.org/cache/epub/2/pg2.txt' }))).toEqual([
      'excerpts/en.json 0.url: Gutenberg ebook 2, and the source plain-work is ebook 1',
    ]);
    expect(messages(withExcerpt(work, { ...excerpt, url: 'https://www.gutenberg.org/ebooks/1.txt.utf-8' }))).toEqual([]);
  });
  describe('ties an excerpt URL to the page its source names', () => {
    const page = { ...work, lang: 'es', originalLang: 'es', nationality: ['es'], url: 'https://es.wikisource.org/wiki/Invented_book' };
    const fromPage = (url: string) => ({ ...excerpt, lang: 'es', text: 'Escribía corto. Funcionaba.', url });
    it('accepts the source page itself, or a variant the source lists in excerptUrls', () => {
      expect(messages(withExcerpt(page, fromPage('https://es.wikisource.org/wiki/Invented_book')))).toEqual([]);
      const listed = { ...page, excerptUrls: ['https://es.wikisource.org/wiki/Invented_book_(first_edition)'] };
      expect(messages(withExcerpt(listed, fromPage('https://es.wikisource.org/wiki/Invented_book_(first_edition)')))).toEqual([]);
    });
    it("refuses a Wikisource page of another work, such as an Argentine author's, under a cleared source", () => {
      expect(messages(withExcerpt(page, fromPage('https://es.wikisource.org/wiki/Aguafuertes_porte%C3%B1as')))).toEqual([
        'excerpts/es.json 0.url: https://es.wikisource.org/wiki/Aguafuertes_porte%C3%B1as is not the page of plain-work nor one of its excerptUrls',
      ]);
    });
    it('refuses a Gutenberg text under a source that names no Gutenberg ebook', () => {
      expect(messages(withExcerpt(page, fromPage('https://www.gutenberg.org/cache/epub/13507/pg13507.txt')))).toEqual([
        'excerpts/es.json 0.url: https://www.gutenberg.org/cache/epub/13507/pg13507.txt is not the page of plain-work nor one of its excerptUrls',
      ]);
    });
    it('refuses an excerptUrls entry off the text hosts', () => {
      expect(messages({ ...empty, sources: [{ ...page, excerptUrls: ['https://www.cervantesvirtual.com/obra/x'] }] })).toEqual([
        'sources.json 0.excerptUrls.0: www.cervantesvirtual.com is not gutenberg.org or wikisource.org',
      ]);
    });
  });
  it('refuses a principle that cites a link-only source', () => {
    expect(messages({ ...empty, sources: [{ ...work, use: 'link-only' }], principles: { 'principles/en.json': [principle] } })).toEqual([
      'principles/en.json 0.sources.0: plain-work is link-only',
    ]);
  });
});

describe('the Argentine authors give no excerpts while the paid public domain is unresolved', () => {
  const argentine = { ...work, nationality: ['ar'], lang: 'es', originalLang: 'es', paidPublicDomain: 'unresolved' };
  const spanish = { ...excerpt, lang: 'es', text: 'Escribía corto. Funcionaba.' };
  const sourceRule = 'sources.json 0.use: an Argentine author gives no excerpts while the paid public domain (Decreto-ley 1224/58) is unresolved';
  it('refuses an Argentine source declared for excerpts, with or without an excerpt citing it', () => {
    expect(messages({ ...empty, sources: [argentine] })).toEqual([sourceRule]);
    expect(messages({ ...empty, sources: [{ ...argentine, use: 'principles' }] })).toEqual([]);
    expect(messages({ ...empty, sources: [{ ...argentine, paidPublicDomain: 'cleared' }] })).toEqual([]);
  });
  it('refuses an Argentine excerpt, even from a work free in the United States', () => {
    expect(messages(withExcerpt(argentine, spanish))).toEqual([
      sourceRule,
      'excerpts/es.json 0.source: plain-work is by an Argentine author and the paid public domain (Decreto-ley 1224/58) is unresolved',
    ]);
  });
  it('refuses an Argentine source that does not declare the paid public domain question', () => {
    const { paidPublicDomain: _gone, ...silent } = argentine;
    expect(messages({ ...empty, sources: [silent] })).toEqual([
      'sources.json 0.paidPublicDomain: an Argentine author needs paidPublicDomain (Decreto-ley 1224/58)',
      sourceRule,
    ]);
  });
  it('lets the excerpt through once the flag is cleared, as the README says a reading of the decree may do', () => {
    expect(messages(withExcerpt({ ...argentine, paidPublicDomain: 'cleared' }, spanish))).toEqual([]);
  });
  it('counts an author of two nationalities, one of them Argentine', () => {
    expect(messages(withExcerpt({ ...argentine, nationality: ['uy', 'ar'] }, spanish))).toHaveLength(2);
  });
  it('keeps a principle of a scoped source inside its genres and registers', () => {
    const casual = { ...argentine, use: 'principles', scope: { genres: ['whatsapp'], registers: ['casual'] } };
    const formal = { ...principle, lang: 'es', genres: ['whatsapp', 'email'], registers: ['casual', 'formal'] };
    expect(messages({ ...empty, sources: [casual], principles: { 'principles/es.json': [formal] } })).toEqual([
      'principles/es.json 0.genres: plain-work is limited to whatsapp, and this principle also covers email',
      'principles/es.json 0.registers: plain-work is limited to casual, and this principle also covers formal',
    ]);
  });
});

describe('an excerpt is short, verbatim from Gutenberg or Wikisource, and never names Project Gutenberg', () => {
  it(`refuses more than ${EXCERPT_MAX_SENTENCES} sentences`, () => {
    expect(messages(withExcerpt(work, { ...excerpt, text: 'One. Two. Three.' }))).toEqual([
      `excerpts/en.json 0.text: 3 sentences; the cap is ${EXCERPT_MAX_SENTENCES}`,
    ]);
  });
  it('counts a last sentence with no closing punctuation', () => {
    expect(messages(withExcerpt(work, { ...excerpt, text: 'One. Two. three' }))).toEqual([
      `excerpts/en.json 0.text: 3 sentences; the cap is ${EXCERPT_MAX_SENTENCES}`,
    ]);
  });
  it(`refuses more than ${EXCERPT_MAX_WORDS} words`, () => {
    const long = `${Array.from({ length: EXCERPT_MAX_WORDS + 1 }, () => 'word').join(' ')}.`;
    expect(messages(withExcerpt(work, { ...excerpt, text: long }))).toEqual([
      `excerpts/en.json 0.text: ${EXCERPT_MAX_WORDS + 1} words; the cap is ${EXCERPT_MAX_WORDS}`,
    ]);
  });
  it('accepts exactly the cap', () => {
    const atCap = `${Array.from({ length: EXCERPT_MAX_WORDS }, () => 'word').join(' ')}.`;
    expect(messages(withExcerpt(work, { ...excerpt, text: atCap }))).toEqual([]);
  });
  it('refuses an excerpt that names Project Gutenberg', () => {
    expect(messages(withExcerpt(work, { ...excerpt, text: 'This eBook is for the use of anyone, from Project  Gutenberg.' }))).toEqual([
      'excerpts/en.json 0.text: names Project Gutenberg; its licence lets the text go only without that name',
    ]);
    for (const text of ['FROM PROJECT GUTENBERG.', 'See gutenberg.org for more.']) {
      expect(messages(withExcerpt(work, { ...excerpt, text })), text).toEqual([
        'excerpts/en.json 0.text: names Project Gutenberg; its licence lets the text go only without that name',
      ]);
    }
  });
  it('refuses a text fetched from a host other than Gutenberg or Wikisource', () => {
    expect(messages(withExcerpt(work, { ...excerpt, url: 'https://www.cervantesvirtual.com/obra/1' }))).toEqual([
      'excerpts/en.json 0.url: www.cervantesvirtual.com is not gutenberg.org or wikisource.org',
    ]);
  });
  it('refuses a lookalike host that only contains or ends in the name of one', () => {
    for (const host of ['gutenberg.org.evil.example', 'notgutenberg.org', 'evilwikisource.org', 'notwikisource.org']) {
      expect(messages(withExcerpt(work, { ...excerpt, url: `https://${host}/x` })), host).toContain(
        `excerpts/en.json 0.url: ${host} is not gutenberg.org or wikisource.org`,
      );
      expect(messages({ ...empty, sources: [{ ...work, url: `https://${host}/x` }] }), host).toEqual([
        `sources.json 0.url: ${host} is not gutenberg.org or wikisource.org`,
      ]);
    }
  });
  it('refuses a literary source hosted elsewhere, unless it is excluded', () => {
    expect(messages({ ...empty, sources: [{ ...work, url: 'https://www.cervantesvirtual.com/obra/1' }] })).toEqual([
      'sources.json 0.url: www.cervantesvirtual.com is not gutenberg.org or wikisource.org',
    ]);
    expect(messages({ ...empty, sources: [{ ...work, use: 'excluded', url: 'https://en.wikipedia.org/wiki/Book' }] })).toEqual([]);
  });
  it('refuses an excerpt with no fetch date or no URL, or in a language other than its source', () => {
    const { fetched: _f, url: _u, ...bare } = excerpt;
    expect(validateRefs(withExcerpt(work, bare)).map((p) => p.path)).toEqual(['0.url', '0.fetched']);
    expect(messages(withExcerpt({ ...work, lang: 'es', originalLang: 'es' }))).toEqual(['excerpts/en.json 0.lang: the source plain-work is read in es']);
  });
  it('refuses an excerpt filed under the other language', () => {
    expect(messages({ ...empty, sources: [work], excerpts: { 'excerpts/es.json': [excerpt] } })).toEqual(['excerpts/es.json 0.lang: lang en in the es file']);
  });
});

describe('an open-licence source names its attribution before anything draws on it', () => {
  const guide = { ...work, kind: 'guide', authorDied: null, use: 'principles', status: { ar: 'open-licence', us: 'open-licence', eu: 'open-licence', es: 'open-licence' } };
  it('refuses an open-licence guide that gives principles with no attribution', () => {
    expect(messages({ ...empty, sources: [guide] })).toEqual([
      'sources.json 0.attribution: an open licence asks for attribution, and this source gives principles without one',
    ]);
  });
  it('accepts it with an attribution, and asks none of a link-only guide or a public-domain work', () => {
    expect(messages({ ...empty, sources: [{ ...guide, attribution: 'Contains material from an invented guide, CC BY 4.0.' }] })).toEqual([]);
    expect(messages({ ...empty, sources: [{ ...guide, use: 'link-only' }] })).toEqual([]);
    expect(messages({ ...empty, sources: [work] })).toEqual([]);
  });
});

describe('the Biblioteca Virtual Miguel de Cervantes stays out, whatever kind a source declares', () => {
  const guide = { ...work, kind: 'guide', authorDied: null, use: 'principles', url: 'https://www.cervantesvirtual.com/obra/x' };
  it('refuses a guide on its host that gives principles or excerpts', () => {
    const refused = 'sources.json 0.url: www.cervantesvirtual.com claims rights over its database (design 4.8), so nothing draws on it';
    expect(messages({ ...empty, sources: [guide] })).toEqual([refused]);
    expect(messages({ ...empty, sources: [{ ...guide, use: 'excerpts' }] })).toContain(refused);
  });
  it('lets it stay as a link for the reader', () => {
    expect(messages({ ...empty, sources: [{ ...guide, use: 'link-only' }] })).toEqual([]);
  });
});

describe('the Argentine rule reaches works, not open-licence guides', () => {
  it('asks no paid public domain flag of an Argentine guide', () => {
    const guide = { ...work, kind: 'guide', authorDied: null, nationality: ['ar'], lang: 'es', originalLang: 'es', use: 'principles', url: 'https://www.argentina.gob.ar/acerca' };
    expect(messages({ ...empty, sources: [guide] })).toEqual([]);
  });
});

describe('sources.json against the author table and register guides of design 4.8', () => {
  const sources = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'sources.json'), 'utf8')) as unknown[]).map((s) => Source.parse(s));
  const byId = new Map(sources.map((s) => [s.id, s]));
  const get = (id: string): Source => {
    const s = byId.get(id);
    if (s === undefined) throw new Error(`sources.json has no ${id}`);
    return s;
  };

  it('lists every author and guide of the tables, excluded ones included', () => {
    expect(sources.map((s) => s.id).sort()).toEqual([
      'andis-lenguaje-claro', 'argentina-gob-ar', 'arlt-aguafuertes', 'azorin', 'baroja', 'bierce-write-it-right',
      'chekhov-garnett-lady-with-the-dog', 'ec-how-to-write-clearly', 'federal-plain-language', 'franklin-autobiography',
      'galdos-fortunata-y-jacinta', 'govuk-style-guide', 'lincoln-gettysburg', 'mansilla-ranqueles', 'orwell-politics',
      'quiroga-cuentos-1917', 'quiroga-decalogo', 'red-lenguaje-claro-es', 'sarmiento-facundo', 'strunk-elements-1920',
      'strunk-white-1959', 'twain-cooper-offences',
    ]);
  });

  it('records the excluded works as excluded, so nothing can cite them', () => {
    const excluded = sources.filter((s) => s.use === 'excluded').map((s) => s.id).sort();
    expect(excluded).toEqual(['azorin', 'baroja', 'orwell-politics', 'strunk-white-1959']);
    expect(get('orwell-politics').status.us).toBe('protected');
  });

  it('keeps the Argentine authors to principles while Decreto-ley 1224/58 is unresolved', () => {
    const argentine = sources.filter((s) => s.kind === 'literary' && s.nationality.includes('ar'));
    expect(argentine.map((s) => s.id).sort()).toEqual(['arlt-aguafuertes', 'mansilla-ranqueles', 'quiroga-cuentos-1917', 'quiroga-decalogo', 'sarmiento-facundo']);
    for (const s of argentine) {
      expect(s.paidPublicDomain, s.id).toBe('unresolved');
      expect(s.use, s.id).toBe('principles');
    }
    expect(get('arlt-aguafuertes').scope).toEqual({ genres: ['whatsapp'], registers: ['casual'] });
  });

  it('marks Spain not free until 2027-01-01 for Strunk and for Garnett', () => {
    for (const id of ['strunk-elements-1920', 'chekhov-garnett-lady-with-the-dog']) {
      expect(['protected', 'unverified'], id).toContain(get(id).status.es);
      expect(get(id).freeFrom?.es, id).toBe('2027-01-01');
    }
    expect(get('chekhov-garnett-lady-with-the-dog').translator).toEqual({ name: 'Constance Garnett', died: 1946 });
  });

  it('keeps every [SIN VERIFICAR] cell of the tables as unverified, never as free', () => {
    expect(get('quiroga-decalogo').status.us).toBe('unverified');
    expect(get('quiroga-decalogo').published).toBeNull();
    expect(get('strunk-elements-1920').status.es).toBe('unverified');
    const plain = get('federal-plain-language').status;
    expect([plain.us, plain.ar, plain.eu, plain.es]).toEqual(['public-domain', 'unverified', 'unverified', 'unverified']);
    for (const id of ['ec-how-to-write-clearly', 'red-lenguaje-claro-es']) {
      expect(Object.values(get(id).status), id).toEqual(['unverified', 'unverified', 'unverified', 'unverified']);
      expect(get(id).use, id).toBe('link-only');
    }
    expect(get('andis-lenguaje-claro').use).toBe('link-only');
  });

  it('tags every status as REPORTADO, since none was checked against each law', () => {
    expect(sources.filter((s) => s.evidence !== 'REPORTADO').map((s) => s.id)).toEqual([]);
  });

  it('gives excerpts only from works in the public domain in the US, read from Gutenberg or Wikisource', () => {
    for (const s of sources.filter((x) => x.use === 'excerpts')) {
      expect(s.status.us, s.id).toBe('public-domain');
      expect(s.url, s.id).toMatch(/^https:\/\/([a-z]+\.)?(gutenberg\.org|wikisource\.org)\//);
    }
  });
});
