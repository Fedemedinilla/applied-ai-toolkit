// The few-shot examples of style-refs (layer 3 of design 4.8) against the linter the rewriter will
// run on them. style-refs imports no library, so the lint check lives here, where prose-rewriter
// may use slop-lint's public entry (import-fences/repo.config.ts, LIBRARY_USES).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lint } from '../../slop-lint/src/lint.ts';
import { Example, GENRES, LANGS } from '../../style-refs/src/index.ts';
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

describe('the examples on disk', () => {
  it('cover every genre in both languages, one or two pairs each', () => {
    for (const lang of LANGS) {
      for (const genre of GENRES) {
        const n = examples.filter((e) => e.lang === lang && e.genre === genre).length;
        expect(n, `${genre} ${lang}`).toBeGreaterThanOrEqual(1);
        expect(n, `${genre} ${lang}`).toBeLessThanOrEqual(2);
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

  it('carry no real address, phone, host or owner identifier', () => {
    for (const e of examples) {
      const text = [e.before, e.after, e.previousMessage ?? '', e.notes].join('\n');
      expect(checkFictional(`style-refs/examples/${e.lang}.json#${e.id}`, text), e.id).toEqual([]);
    }
  });
});
