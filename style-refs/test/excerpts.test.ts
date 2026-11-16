import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Excerpt, Source } from '../src/index.ts';

// The excerpts on disk against layer 2 of design 4.8 and decision D12. Whether each text is
// verbatim is checked against the fetched plain text outside the repository (the texts are not
// stored here); these tests hold what can be checked offline.

const FOLDER = join(import.meta.dirname, '..');
const read = (file: string): unknown => JSON.parse(readFileSync(join(FOLDER, file), 'utf8'));
const sources = (read('sources.json') as unknown[]).map((s) => Source.parse(s));
const byId = new Map(sources.map((s) => [s.id, s]));
const excerpts = {
  en: (read('excerpts/en.json') as unknown[]).map((e) => Excerpt.parse(e)),
  es: (read('excerpts/es.json') as unknown[]).map((e) => Excerpt.parse(e)),
};
const all = [...excerpts.en, ...excerpts.es];
const count = (list: readonly Excerpt[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const e of list) out[e.source] = (out[e.source] ?? 0) + 1;
  return out;
};

describe('the excerpts on disk', () => {
  it('come from the English authors of the table and, in Spanish, from Galdós only', () => {
    expect(Object.keys(count(excerpts.en)).sort()).toEqual([
      'bierce-write-it-right', 'chekhov-garnett-lady-with-the-dog', 'franklin-autobiography',
      'lincoln-gettysburg', 'strunk-elements-1920', 'twain-cooper-offences',
    ]);
    expect(Object.keys(count(excerpts.es))).toEqual(['galdos-fortunata-y-jacinta']);
  });

  it('give two to four excerpts per author', () => {
    for (const [id, n] of Object.entries(count(all))) {
      expect(n, id).toBeGreaterThanOrEqual(2);
      expect(n, id).toBeLessThanOrEqual(4);
    }
  });

  it('never cite an Argentine author, while Decreto-ley 1224/58 is unresolved (D12)', () => {
    for (const e of all) expect(byId.get(e.source)?.nationality, e.id).not.toContain('ar');
  });

  it('were all fetched on 2026-11-16 from the plain text of their source', () => {
    for (const e of all) {
      expect(e.fetched, e.id).toBe('2026-11-16');
      expect(e.url, e.id).toMatch(/^https:\/\/(www\.gutenberg\.org\/cache\/epub\/\d+\/pg\d+\.txt|en\.wikisource\.org\/wiki\/.+)$/);
      expect(new URL(e.url).hostname.split('.').slice(-2).join('.'), e.id).toBe(new URL(byId.get(e.source)?.url ?? 'https://x.invalid').hostname.split('.').slice(-2).join('.'));
    }
  });

  it('date each source by the text quoted: Franklin by Bigelow\'s English text of 1868, not the French edition of 1791', () => {
    expect(byId.get('franklin-autobiography')?.published).toBe(1868);
    expect(byId.get('franklin-autobiography')?.note).toContain('1791');
  });

  it('carry none of the marks the hosts add: no italics underscores, no footnote brackets', () => {
    for (const e of all) expect(e.text, e.id).not.toMatch(/[_[\]]/);
  });

  it('repeat no text, and say what they teach apart from what not to imitate', () => {
    expect(new Set(all.map((e) => e.text)).size).toBe(all.length);
    for (const e of all) expect(e.teaches, e.id).not.toBe(e.avoid);
  });
});
