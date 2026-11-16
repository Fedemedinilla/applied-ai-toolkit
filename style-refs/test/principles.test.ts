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
});
