import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GENRES, validateRefs, type RefsData } from '../src/index.ts';

const FOLDER = join(import.meta.dirname, '..');
const json = (file: string): unknown => JSON.parse(readFileSync(join(FOLDER, file), 'utf8'));
const folder = (dir: string): Record<string, unknown> => {
  if (!existsSync(join(FOLDER, dir))) return {};
  return Object.fromEntries(
    readdirSync(join(FOLDER, dir))
      .filter((f) => f.endsWith('.json'))
      .map((f) => [`${dir}/${f}`, json(`${dir}/${f}`)]),
  );
};
const onDisk = (): RefsData => ({ sources: json('sources.json'), principles: folder('principles'), excerpts: folder('excerpts'), examples: folder('examples') });

const source = {
  id: 'plain-guide',
  kind: 'guide',
  author: 'An invented agency',
  work: 'An invented plain-language guide',
  published: 2020,
  authorDied: null,
  lang: 'en',
  originalLang: 'en',
  nationality: ['gb'],
  status: { ar: 'open-licence', us: 'open-licence', eu: 'open-licence', es: 'open-licence' },
  licence: 'CC BY 4.0',
  url: 'https://guide.example/plain',
  verified: '2026-11-15',
  evidence: 'REPORTADO',
  use: 'principles',
};
const principle = {
  id: 'subject-first',
  lang: 'en',
  genres: ['email'],
  registers: ['formal', 'neutral'],
  text: 'Start with what you need from the reader.',
  check: 'The first sentence names the request.',
  sources: ['plain-guide'],
};
const empty: RefsData = { sources: [], principles: {}, excerpts: {}, examples: {} };

describe('the data on disk', () => {
  it('has the files of the design and passes the validator', () => {
    const data = onDisk();
    expect(Object.keys(data.principles).sort()).toEqual(['principles/en.json', 'principles/es.json']);
    expect(Object.keys(data.excerpts).sort()).toEqual(['excerpts/en.json', 'excerpts/es.json']);
    expect(validateRefs(data)).toEqual([]);
  });
});

describe('validateRefs', () => {
  it('accepts a source and a principle that cites it', () => {
    expect(validateRefs({ ...empty, sources: [source], principles: { 'principles/en.json': [principle] } })).toEqual([]);
  });

  it('refuses a source without the status of every jurisdiction', () => {
    const { es: _es, ...status } = source.status;
    const problems = validateRefs({ ...empty, sources: [{ ...source, status }] });
    expect(problems.map((p) => `${p.file} ${p.path}`)).toEqual(['sources.json 0.status.es']);
  });

  it('refuses a principle that cites a missing source, or sits in the file of another language', () => {
    const problems = validateRefs({ ...empty, principles: { 'principles/es.json': [principle] } });
    expect(problems.map((p) => `${p.path}: ${p.message}`)).toEqual([
      '0.lang: lang en in the es file',
      '0.sources.0: cites source plain-guide, which is not in sources.json',
    ]);
  });

  it('refuses an excerpt of an unknown source and a repeated id', () => {
    const excerpt = { id: 'plain-guide', source: 'nowhere', lang: 'en', text: 'Short.', teaches: 'brevity', avoid: 'nothing', url: 'https://www.gutenberg.org/cache/epub/1/pg1.txt', fetched: '2026-11-16' };
    const problems = validateRefs({ ...empty, sources: [source], excerpts: { 'excerpts/en.json': [excerpt] } });
    expect(problems.map((p) => p.message)).toEqual([
      'id plain-guide is already used in sources.json',
      'cites source nowhere, which is not in sources.json',
    ]);
  });

  it('refuses an example that is not marked fictional or sits in the wrong genre file', () => {
    const example = { id: 'one', genre: 'email', lang: 'en', before: 'a', after: 'b', notes: 'c', fictional: true };
    expect(validateRefs({ ...empty, examples: { 'examples/email.en.json': [example] } })).toEqual([]);
    const problems = validateRefs({ ...empty, examples: { 'examples/whatsapp.en.json': [{ ...example, fictional: false }] } });
    expect(problems.map((p) => p.path)).toEqual(['0.fictional']);
    const misplaced = validateRefs({ ...empty, examples: { 'examples/whatsapp.en.json': [example] } });
    expect(misplaced.map((p) => p.message)).toEqual(['genre email in the whatsapp file']);
  });

  it('refuses a data file outside the layout', () => {
    const problems = validateRefs({ ...empty, examples: { 'examples/linkedin.en.json': [] }, principles: { 'principles/pt.json': [] } });
    expect(problems.map((p) => p.file).sort()).toEqual(['examples/linkedin.en.json', 'principles/pt.json']);
  });

  it('names the four genres of the design', () => {
    expect(GENRES).toEqual(['cover-letter', 'email', 'follow-up', 'whatsapp']);
  });
});
