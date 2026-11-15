import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFictional } from './fictional.ts';
import { RewriteInput } from '../src/index.ts';

const REPO = join(import.meta.dirname, '..', '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
const files = (dir: string, ext: RegExp) => walk(join(REPO, dir)).filter((f) => ext.test(f));
const read = (path: string) => readFileSync(path, 'utf8');
const rel = (path: string) => relative(REPO, path);

const CASES = files('prose-rewriter/evals', /\.(md|json|txt)$/);
const CVS = CASES.filter((f) => rel(f).startsWith('prose-rewriter/evals/cases/cv/'));
const STYLE_DATA = files('style-refs', /\.json$/);
// slop-lint's labelled set by genre, read by slop-lint/scripts/genre-eval.ts.
const LABELED = ['email', 'follow-up', 'whatsapp'].flatMap((genre) => files(`slop-lint/fixtures/${genre}`, /\.json$/));

describe('the fixtures carry no real data', () => {
  it('has a fictional CV in Spanish and one in English', () => {
    expect(CVS.map(rel).sort()).toEqual(['prose-rewriter/evals/cases/cv/en.md', 'prose-rewriter/evals/cases/cv/es-rioplatense.md']);
  });

  it('keeps every eval case under reserved hosts, with zero-filled phones, no owner identifier and a fiction marker on each CV', () => {
    const found = CASES.flatMap((f) => checkFictional(rel(f), read(f), { needsMarker: CVS.includes(f) }));
    expect(found).toEqual([]);
  });

  it('keeps the style-refs data free of personal addresses, phones and owner identifiers', () => {
    // sources.json links to the works it cites, so real hosts are allowed there.
    const found = STYLE_DATA.flatMap((f) => checkFictional(rel(f), read(f), { realHosts: true }));
    expect(found).toEqual([]);
  });

  it("keeps slop-lint's labelled set under the same rules, each file marked as fiction", () => {
    expect(LABELED.length).toBe(6);
    const found = LABELED.flatMap((f) => checkFictional(rel(f), read(f)));
    expect(found).toEqual([]);
    // JSON has no comments, so the marker is the "fictional" field the evaluator also checks.
    for (const f of LABELED) expect(String((JSON.parse(read(f)) as { fictional?: unknown }).fictional), rel(f)).toMatch(/^Fictional/);
  });

  // Witnesses: if the checks stopped seeing real data, the tests above would pass for the wrong reason.
  it('reports a real address, a real phone, a real host, the owner and a missing marker', () => {
    const owner = 'Medi' + 'nilla';
    const text = `Write to someone@gmail.com or call +54 9 11 4567-8901. See https://portfolio.dev, linkedin.com/in/x and www.portfolio.dev. WhatsApp 3515551234. Signed ${owner}.`;
    expect(checkFictional('bad.md', text, { needsMarker: true }).map((f) => `${f.kind} ${f.match}`)).toEqual([
      'email someone@gmail.com',
      'host https://portfolio.dev',
      'host linkedin.com',
      'host www.portfolio.dev',
      'phone +54 9 11 4567-8901',
      'phone 3515551234',
      `owner ${owner}`,
      'marker Write to someone@gmail.com or call +54 9',
    ]);
  });

  it('accepts reserved hosts, zero-filled phones and year ranges', () => {
    const text = '<!-- Fictional -->\nana@school.test, ana@example.org, https://ana.example, ana.example/cv, +54 9 351 0000-0000, 35100000000, 2019-2023, Node.js, cv.md, e.g. this.';
    expect(checkFictional('ok.md', text, { needsMarker: true })).toEqual([]);
  });
});

describe('the fictional CVs as rewriter input', () => {
  it('fit the RewriteInput contract', () => {
    for (const cv of CVS) {
      const lang = rel(cv).endsWith('en.md') ? 'en' : 'es';
      const input = { text: 'Borrador.', genre: 'email', lang, profile: { cvMarkdown: read(cv) } };
      expect(RewriteInput.safeParse(input).success).toBe(true);
    }
  });
});
