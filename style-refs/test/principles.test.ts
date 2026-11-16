import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GENRES, Principle, REGISTERS, Source, principlesFor, validateRefs, type RefsData } from '../src/index.ts';

// Layer 1 of design 4.8: principles in our own words, with the "no imitar" list as `avoid` entries.
// The rule this file guards above all: a principle taken from a casual source never reaches a
// formal prompt, neither through the data (validateRefs) nor through the selector (principlesFor).

const empty: RefsData = { sources: [], principles: {}, excerpts: {}, examples: {} };

const casualSource = {
  id: 'casual-work',
  kind: 'literary',
  author: 'An invented columnist',
  work: 'Invented columns',
  published: 1929,
  authorDied: 1940,
  lang: 'es',
  originalLang: 'es',
  nationality: ['uy'],
  status: { ar: 'public-domain', us: 'public-domain', eu: 'public-domain', es: 'public-domain' },
  licence: 'public domain',
  url: 'https://es.wikisource.org/wiki/Invented',
  verified: '2026-11-15',
  evidence: 'REPORTADO',
  use: 'principles',
  scope: { genres: ['whatsapp'], registers: ['casual'] },
};
const plainSource = { ...casualSource, id: 'plain-work', scope: undefined };
const casualPrinciple = {
  id: 'es-talk-like-people',
  lang: 'es',
  genres: ['whatsapp'],
  registers: ['casual'],
  variety: 'rioplatense',
  text: 'Write the way people talk.',
  check: 'No letter formulas.',
  sources: ['casual-work'],
};
const avoidEntry = {
  id: 'es-avoid-slang-in-mail',
  kind: 'avoid',
  lang: 'es',
  genres: ['email'],
  registers: ['formal', 'neutral'],
  text: 'No slang in an email.',
  check: 'S6 looks for the terms.',
  terms: ['laburo'],
  sources: ['casual-work'],
};
const data = (sources: object[], principles: object[]): RefsData => ({ ...empty, sources, principles: { 'principles/es.json': principles } });
const messages = (d: RefsData): string[] => validateRefs(d).map((p) => `${p.file} ${p.path}: ${p.message}`);

describe('a principle from a casual source never reaches a formal register', () => {
  it('accepts the casual principle inside the scope of its source', () => {
    expect(messages(data([casualSource], [casualPrinciple]))).toEqual([]);
  });

  it('refuses it in a formal register, even when it also cites a source with no scope', () => {
    const formal = { ...casualPrinciple, registers: ['casual', 'formal'], sources: ['plain-work', 'casual-work'] };
    expect(messages(data([casualSource, plainSource], [formal]))).toEqual([
      'principles/es.json 0.registers: casual-work is limited to casual, and this principle also covers formal',
    ]);
  });

  it('refuses a source whose scope puts the casual and the formal register together', () => {
    const both = { ...casualSource, scope: { genres: ['whatsapp'], registers: ['casual', 'formal'] } };
    expect(messages(data([both], []))).toEqual([
      'sources.json 0.scope.registers: a source scoped to the casual register cannot also reach formal',
    ]);
  });

  it('lets an avoid entry name a casual source in a formal register, because it warns against it', () => {
    expect(messages(data([casualSource], [avoidEntry]))).toEqual([]);
    const { kind: _k, terms: _t, ...lesson } = avoidEntry;
    expect(messages(data([casualSource], [lesson]))).toEqual([
      'principles/es.json 0.genres: casual-work is limited to whatsapp, and this principle also covers email',
      'principles/es.json 0.registers: casual-work is limited to casual, and this principle also covers formal, neutral',
    ]);
  });
});

describe('the shape of a principle', () => {
  it('keeps terms to avoid entries', () => {
    expect(messages(data([casualSource], [{ ...casualPrinciple, terms: ['che'] }]))).toEqual([
      'principles/es.json 0.terms: only an avoid entry has terms',
    ]);
  });

  it('keeps a variety to Spanish principles', () => {
    const en = { ...casualPrinciple, lang: 'en', variety: 'rioplatense' };
    expect(messages({ ...empty, sources: [casualSource], principles: { 'principles/en.json': [en] } })).toContain(
      'principles/en.json 0.variety: a variety of Spanish on an en principle',
    );
  });

  it('names slop-lint rules by their id', () => {
    expect(messages(data([plainSource], [{ ...casualPrinciple, sources: ['plain-work'], slopRules: ['OFI-01', 'SIN-EN-01'] }]))).toEqual([]);
    expect(validateRefs(data([plainSource], [{ ...casualPrinciple, sources: ['plain-work'], slopRules: ['ofi 1'] }])).map((p) => p.path)).toEqual([
      '0.slopRules.0',
    ]);
  });

  it('refuses a kind outside do and avoid', () => {
    expect(validateRefs(data([casualSource], [{ ...avoidEntry, kind: 'maybe' }])).map((p) => p.path)).toEqual(['0.kind']);
  });
});

describe('principlesFor', () => {
  const sources = [casualSource, plainSource].map((s) => Source.parse(s));
  const general = Principle.parse({ ...casualPrinciple, id: 'es-general', genres: [...GENRES], registers: [...REGISTERS], variety: undefined, sources: ['plain-work'] });
  const casual = Principle.parse(casualPrinciple);
  const avoid = Principle.parse(avoidEntry);
  const all = [general, casual, avoid];
  const ids = (q: Parameters<typeof principlesFor>[2]) => principlesFor(all, sources, q).map((p) => p.id);

  it('picks by language, genre, register and variety', () => {
    expect(ids({ lang: 'es', genre: 'whatsapp', register: 'casual', variety: 'rioplatense' })).toEqual(['es-general', 'es-talk-like-people']);
    expect(ids({ lang: 'es', genre: 'whatsapp', register: 'casual', variety: 'neutral' })).toEqual(['es-general']);
    expect(ids({ lang: 'en', genre: 'whatsapp', register: 'casual' })).toEqual([]);
  });

  it('picks the avoid entries apart, for the negative constraint and the lexical check', () => {
    expect(ids({ lang: 'es', genre: 'email', register: 'formal', kind: 'avoid' })).toEqual(['es-avoid-slang-in-mail']);
    expect(ids({ lang: 'es', genre: 'email', register: 'formal', kind: 'do' })).toEqual(['es-general']);
  });

  it('drops a lesson whose source does not reach the register, even when the data was not validated', () => {
    const leaked = Principle.parse({ ...casualPrinciple, id: 'es-leaked', genres: ['whatsapp', 'email'], registers: ['casual', 'formal'] });
    expect(principlesFor([leaked], sources, { lang: 'es', genre: 'email', register: 'formal', variety: 'rioplatense' })).toEqual([]);
    expect(principlesFor([leaked], sources, { lang: 'es', genre: 'whatsapp', register: 'formal', variety: 'rioplatense' })).toEqual([]);
    expect(principlesFor([leaked], [], { lang: 'es', genre: 'whatsapp', register: 'casual', variety: 'rioplatense' })).toEqual([]);
  });

  it('drops a lesson whose source does not reach the genre, even when the register matches', () => {
    const leaked = Principle.parse({ ...casualPrinciple, id: 'es-leaked', genres: ['whatsapp', 'email'] });
    expect(principlesFor([leaked], sources, { lang: 'es', genre: 'email', register: 'casual', variety: 'rioplatense' })).toEqual([]);
    expect(principlesFor([leaked], sources, { lang: 'es', genre: 'whatsapp', register: 'casual', variety: 'rioplatense' }).map((p) => p.id)).toEqual(['es-leaked']);
  });

  it('drops a lesson whose source is link-only or excluded, even when the data was not validated', () => {
    for (const use of ['link-only', 'excluded']) {
      const unusable = [Source.parse({ ...plainSource, use })];
      expect(principlesFor([general], unusable, { lang: 'es', genre: 'email', register: 'neutral' }), use).toEqual([]);
    }
  });
});

describe('the principles on disk', () => {
  const read = (file: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, '..', file), 'utf8'));
  const sources = (read('sources.json') as unknown[]).map((s) => Source.parse(s));
  const byId = new Map(sources.map((s) => [s.id, s]));
  const principles = [...(read('principles/es.json') as unknown[]), ...(read('principles/en.json') as unknown[])].map((p) => Principle.parse(p));
  const lessons = principles.filter((p) => p.kind !== 'avoid');
  const avoid = principles.filter((p) => p.kind === 'avoid');
  const citing = (id: string) => principles.filter((p) => p.sources.includes(id)).map((p) => p.id);

  it('has lessons and avoid entries in both languages', () => {
    for (const lang of ['es', 'en'] as const) {
      expect(lessons.filter((p) => p.lang === lang).length, lang).toBeGreaterThan(0);
      expect(avoid.filter((p) => p.lang === lang).length, lang).toBeGreaterThan(0);
    }
  });

  it('uses Arlt only for the casual rioplatense register of WhatsApp', () => {
    const arlt = lessons.filter((p) => p.sources.includes('arlt-aguafuertes'));
    expect(arlt.length).toBeGreaterThan(0);
    for (const p of arlt) expect([p.genres, p.registers, p.variety], p.id).toEqual([['whatsapp'], ['casual'], 'rioplatense']);
  });

  it('never cites a casual source from a lesson in a formal register', () => {
    const casual = new Set(sources.filter((s) => s.scope?.registers.includes('casual')).map((s) => s.id));
    const leaks = lessons.filter((p) => p.registers.includes('formal') && p.sources.some((id) => casual.has(id)));
    expect(leaks.map((p) => p.id)).toEqual([]);
  });

  it('covers the principles the design names in layer 1', () => {
    expect(citing('quiroga-decalogo').length).toBeGreaterThan(0);
    expect(citing('strunk-elements-1920').length).toBeGreaterThan(0);
    expect(citing('govuk-style-guide').length).toBeGreaterThan(0);
    for (const rule of ['OFI-01', 'EST-11']) {
      for (const lang of ['es', 'en'] as const) expect(lessons.some((p) => p.lang === lang && p.slopRules?.includes(rule)), `${rule} ${lang}`).toBe(true);
    }
  });

  it('carries the "no imitar" list of the design, with terms for the lexical check', () => {
    const terms = avoid.flatMap((p) => p.terms ?? []);
    for (const t of ['díjole', 'hállase', 'empero']) expect(terms, t).toContain(t);
    for (const id of ['arlt-aguafuertes', 'sarmiento-facundo', 'twain-cooper-offences', 'bierce-write-it-right']) {
      expect(avoid.some((p) => p.sources.includes(id)), id).toBe(true);
    }
    const lunfardo = avoid.find((p) => p.sources.includes('arlt-aguafuertes'));
    expect(lunfardo?.genres).not.toContain('whatsapp');
  });

  it('never tells a formal prompt to switch to vos: a lesson on treatment keeps the one the writer used', () => {
    const treatment = lessons.filter((p) => p.registers.includes('formal') && /\bvos\b/.test(p.text));
    expect(treatment.length).toBeGreaterThan(0);
    for (const p of treatment) expect(p.text, p.id).toMatch(/keep the treatment the writer used/i);
  });

  it('cites only sources that may give principles', () => {
    for (const p of principles) {
      for (const id of p.sources) expect(['principles', 'excerpts'], `${p.id} ${id}`).toContain(byId.get(id)?.use);
    }
  });
});
