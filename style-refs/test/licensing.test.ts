import { describe, expect, it } from 'vitest';
import { EXCERPT_MAX_SENTENCES, EXCERPT_MAX_WORDS, validateRefs, type RefsData } from '../src/index.ts';

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
  it('refuses a principle that cites a link-only source', () => {
    expect(messages({ ...empty, sources: [{ ...work, use: 'link-only' }], principles: { 'principles/en.json': [principle] } })).toEqual([
      'principles/en.json 0.sources.0: plain-work is link-only',
    ]);
  });
});

describe('the Argentine authors give no excerpts while the paid public domain is unresolved', () => {
  const argentine = { ...work, nationality: ['ar'], lang: 'es', originalLang: 'es', paidPublicDomain: 'unresolved' };
  const spanish = { ...excerpt, lang: 'es', text: 'Escribía corto. Funcionaba.' };
  it('refuses an Argentine excerpt, even from a work free in the United States', () => {
    expect(messages(withExcerpt(argentine, spanish))).toEqual([
      'excerpts/es.json 0.source: plain-work is by an Argentine author and the paid public domain (Decreto-ley 1224/58) is unresolved',
    ]);
  });
  it('refuses an Argentine source that does not declare the paid public domain question', () => {
    const { paidPublicDomain: _gone, ...silent } = argentine;
    expect(messages({ ...empty, sources: [silent] })).toEqual([
      'sources.json 0.paidPublicDomain: an Argentine author needs paidPublicDomain (Decreto-ley 1224/58)',
    ]);
  });
  it('counts an author of two nationalities, one of them Argentine', () => {
    expect(messages(withExcerpt({ ...argentine, nationality: ['uy', 'ar'] }, spanish))).toHaveLength(1);
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
  });
  it('refuses a text fetched from a host other than Gutenberg or Wikisource', () => {
    expect(messages(withExcerpt(work, { ...excerpt, url: 'https://www.cervantesvirtual.com/obra/1' }))).toEqual([
      'excerpts/en.json 0.url: www.cervantesvirtual.com is not gutenberg.org or wikisource.org',
    ]);
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
});
