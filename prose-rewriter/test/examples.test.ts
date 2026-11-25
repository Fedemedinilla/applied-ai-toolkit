// The few-shot examples of style-refs (layer 3 of design 4.8) against the linter the rewriter will
// run on them. style-refs imports no library, so the lint check lives here, where prose-rewriter
// may use slop-lint's public entry (import-fences/repo.config.ts, LIBRARY_USES).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lint } from '../../slop-lint/src/lint.ts';
import { CHANNEL_GENRES, Channel, Example, GENRES, LANGS } from '../../style-refs/src/index.ts';
import { checkFictional } from './fictional.ts';

const REPO = join(import.meta.dirname, '..', '..');
const read = (file: string): string => readFileSync(join(REPO, file), 'utf8');
const examples = LANGS.flatMap((lang) => (JSON.parse(read(`style-refs/examples/${lang}.json`)) as unknown[]).map((e) => Example.parse(e)));
const CV = { en: read('prose-rewriter/evals/cases/cv/en.md'), es: read('prose-rewriter/evals/cases/cv/es-rioplatense.md') };

const lintOf = (e: Example, text: string) =>
  lint(text, {
    lang: e.lang,
    genre: e.genre,
    ...(e.variety === undefined ? {} : { variety: e.variety }),
    ...(e.previousMessage === undefined ? {} : { previous: e.previousMessage }),
  });
/** Every run of digits, so a number in an example can be traced to the CV or the earlier message. */
const numbers = (text: string): string[] => [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0]);
/**
 * The named facts of a text: capitalised words that do not open a sentence or a line (a person, a
 * company, a tool, a month), and every day of the week in either language, written in lower case in Spanish.
 */
const names = (text: string): string[] => {
  const capitalised = [...text.matchAll(/\p{Lu}\p{L}+/gu)]
    .filter((m) => !/(?:^|[.!?:\n])[\s¿¡]*$/u.test(text.slice(0, m.index)))
    .map((m) => m[0]);
  const days = [...text.matchAll(/(?<!\p{L})(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|miércoles|jueves|viernes|sábado|domingo)(?!\p{L})/giu)].map((m) => m[0]);
  return [...capitalised, ...days];
};
const mentions = (text: string, name: string): boolean => new RegExp(`(?<!\\p{L})${name}(?!\\p{L})`, 'iu').test(text);
/** The last line of a message, where it is signed. */
const signature = (text: string): string | undefined => text.trim().split('\n').at(-1)?.trim();

describe('the examples on disk', () => {
  it('cover every genre in both languages: three to five pairs for each channel with a guide, one or two for a cover letter', () => {
    for (const lang of LANGS) {
      for (const genre of GENRES) {
        const n = examples.filter((e) => e.lang === lang && e.genre === genre).length;
        const [min, max] = (CHANNEL_GENRES as readonly string[]).includes(genre) ? [3, 5] : [1, 2];
        expect(n, `${genre} ${lang}`).toBeGreaterThanOrEqual(min);
        expect(n, `${genre} ${lang}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it('write the Spanish ones in rioplatense, like the Spanish CV', () => {
    for (const e of examples.filter((x) => x.lang === 'es')) expect(e.variety, e.id).toBe('rioplatense');
  });

  it('have an after with no level 1 finding of slop-lint for its genre and variety', () => {
    for (const e of examples) {
      const result = lintOf(e, e.after);
      expect(result.findings.filter((f) => f.level === 1).map((f) => `${f.ruleId} ${f.match}`), e.id).toEqual([]);
      expect(result.passesTier1, e.id).toBe(true);
    }
  });

  it('have a before with real slop: at least one finding, and more findings than its after', () => {
    for (const e of examples) {
      const before = lintOf(e, e.before);
      expect(before.findings.length, e.id).toBeGreaterThan(0);
      expect(before.findings.length, e.id).toBeGreaterThan(lintOf(e, e.after).findings.length);
    }
  });

  it('use no number that is not in the CV of their language or in the message a follow-up answers', () => {
    for (const e of examples) {
      const known = new Set([...numbers(CV[e.lang]), ...numbers(e.previousMessage ?? '')]);
      expect(numbers(`${e.before}\n${e.after}`).filter((n) => !known.has(n)), e.id).toEqual([]);
    }
  });

  it('name no person, company, tool or day in the after that the before, the earlier message or the CV does not', () => {
    for (const e of examples) {
      const known = [e.before, e.previousMessage ?? '', CV[e.lang]].join('\n');
      expect(names(e.after).filter((n) => !mentions(known, n)), e.id).toEqual([]);
    }
  });

  it('sign a follow-up the way its earlier message is signed', () => {
    for (const e of examples.filter((x) => x.previousMessage !== undefined)) {
      expect(signature(e.after), e.id).toBe(signature(e.previousMessage ?? ''));
    }
  });

  it('carry no real address, phone, host or owner identifier', () => {
    for (const e of examples) {
      const text = [e.before, e.after, e.previousMessage ?? '', e.notes].join('\n');
      expect(checkFictional(`style-refs/examples/${e.lang}.json#${e.id}`, text), e.id).toEqual([]);
    }
  });
});

const channels = LANGS.flatMap((lang) => (JSON.parse(read(`style-refs/channels/${lang}.json`)) as unknown[]).map((c) => Channel.parse(c)));

describe('the channel guides on disk', () => {
  it('have a canonical sample with no level 1 finding of slop-lint for its channel and variety', () => {
    for (const c of channels) {
      const result = lint(c.canonical, { lang: c.lang, genre: c.genre, ...(c.variety === undefined ? {} : { variety: c.variety }) });
      expect(result.findings.filter((f) => f.level === 1).map((f) => `${f.ruleId} ${f.match}`), c.id).toEqual([]);
    }
  });

  it('name no number, person, company or tool in the canonical sample, so a prompt cannot lift a fact from it', () => {
    for (const c of channels) {
      expect(numbers(c.canonical), c.id).toEqual([]);
      expect(names(c.canonical), c.id).toEqual([]);
    }
  });

  it('carry no real address, phone, host or owner identifier', () => {
    for (const c of channels) {
      const text = [c.persona, c.reader, c.shape.opening, c.shape.closing, c.canonical].join('\n');
      expect(checkFictional(`style-refs/channels/${c.lang}.json#${c.id}`, text), c.id).toEqual([]);
    }
  });
});
