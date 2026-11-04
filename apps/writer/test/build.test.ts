// Runs the production build into a temporary folder and checks what a static host would serve:
// relative URLs, one script with no inline code, the catalog the page needs and none of the
// prompt text, and no zod in the bundle.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { build } from 'vite';
import { RULES } from '../server/prompt.ts';
import { realConfig } from './raw-config.ts';

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
  out = mkdtempSync(join(tmpdir(), 'writer-build-'));
  await build({ root: appRoot, configFile: join(appRoot, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out } });
}, 60_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe('production build', () => {
  it('writes the page, one script and one stylesheet, with relative URLs only', () => {
    const files = walk(out).sort();
    expect(files.filter((f) => f.endsWith('.js'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.css'))).toHaveLength(1);
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)].map((m) => m[1] ?? '').filter((u) => !u.startsWith('#'));
    expect(urls).toHaveLength(2);
    for (const u of urls) expect(u.startsWith('./')).toBe(true);
  });

  it('has no inline script, no eval and no regex lookbehind', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/u);
    expect(js()).not.toMatch(/\beval\(|new Function\(/u);
    expect(js()).not.toMatch(/\(\?<[=!]/u);
  });

  it('carries the catalog and none of the prompt, the style guide or the examples', () => {
    const code = js();
    const config = realConfig();
    for (const c of config.catalog.categories) expect(code).toContain(c.name);
    expect(code).not.toContain(RULES.slice(0, 60));
    expect(code).not.toContain('SENSITIVITY');
    expect(code).not.toContain(config.school.style[0]!);
    expect(code).not.toContain(config.examples[0]!.title);
    expect(code).not.toContain(config.catalog.categories[0]!.tone);
  });

  it('does not bundle zod', () => {
    expect(js()).not.toMatch(/ZodError|\$ZodType/u);
  });
});
