// Runs the production build into a temporary folder and checks what a static host would serve:
// relative URLs, one script with no inline code, the recordings next to the page and not in the
// script, and none of the rewriter's prompt, zod or slop-lint in the bundle.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARD_RULES } from '../../../prose-rewriter/src/index.ts';

const appRoot = new URL('..', import.meta.url).pathname;
let out = '';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [relative(out, path)];
  });
}
const js = () => walk(out).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, f), 'utf8')).join('\n');

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'rewriter-build-'));
  await build({ root: appRoot, configFile: join(appRoot, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out } });
}, 60_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe('production build', () => {
  it('writes the page, one script, one stylesheet and the recordings, with relative URLs only', () => {
    const files = walk(out).sort();
    expect(files.filter((f) => f.endsWith('.js'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.css'))).toHaveLength(1);
    expect(files).toContain('examples.json');
    expect(readFileSync(join(out, 'examples.json'), 'utf8')).toBe(readFileSync(join(appRoot, 'demo/examples.json'), 'utf8'));
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)].map((m) => m[1] ?? '').filter((u) => !u.startsWith('#'));
    // The script, the stylesheet and the way back to the list of demos.
    expect(urls.sort()).toEqual(['../', ...urls.filter((u) => u.startsWith('./assets/'))].sort());
    expect(urls.filter((u) => u.startsWith('./assets/'))).toHaveLength(2);
  });

  it('has no inline script, no eval and no regex lookbehind', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/u);
    expect(html).not.toMatch(/\son[a-z]+=/u);
    expect(js()).not.toMatch(/\beval\(|new Function\(/u);
    expect(js()).not.toMatch(/\(\?<[=!]/u);
  });

  it('fetches the recordings instead of bundling them', () => {
    const [first] = (JSON.parse(readFileSync(join(appRoot, 'demo/examples.json'), 'utf8')) as { examples: Array<{ result: { rewritten: string } }> }).examples;
    expect(js()).toContain('./examples.json');
    expect(js()).not.toContain(first?.result.rewritten.slice(0, 40));
  });

  it('bundles none of the prompt, zod or slop-lint', () => {
    const code = js();
    for (const rule of HARD_RULES) expect(code).not.toContain(rule.slice(0, 50));
    expect(code).not.toMatch(/ZodError|\$ZodType/u);
    expect(code).not.toContain('LEX-01');
  });
});
