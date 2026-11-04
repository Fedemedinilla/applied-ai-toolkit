// Runs the production build into a temporary folder and checks what a static host would serve:
// relative URLs only, one script with pdf-lib bundled in it, and the sample logo.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { build } from 'vite';

const appRoot = new URL('..', import.meta.url).pathname;
let out = '';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [relative(out, path)];
  });
}

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'receipt-build-'));
  await build({ root: appRoot, configFile: join(appRoot, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out } });
}, 60_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe('production build', () => {
  it('writes the page, one script, one stylesheet and the logo', () => {
    const files = walk(out).sort();
    expect(files.filter((f) => f.endsWith('.js'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.css'))).toHaveLength(1);
    expect(files).toContain('index.html');
    expect(files).toContain('logo-ejemplo.png');
  });

  it('uses relative URLs only, so it works under any subpath', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)].map((m) => m[1] ?? '');
    // '../' is the bar's link back to the list of demos, one level up on the Pages site.
    expect(urls).toContain('../');
    const local = urls.filter((u) => !u.startsWith('#') && u !== '../');
    expect(local.length).toBe(3);
    for (const u of local) expect(u.startsWith('./')).toBe(true);
  });

  it('has no inline script and no eval, so a strict Content-Security-Policy holds', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/u);
    const js = walk(out).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, f), 'utf8')).join('\n');
    expect(js).not.toMatch(/\beval\(|new Function\(/u);
  });
});
