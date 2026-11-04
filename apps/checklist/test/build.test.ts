// Runs the production build into a temporary folder and checks what a static host would serve:
// relative URLs only, no inline script, the service worker with its precache filled in, and the
// catalogue shipped as committed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { build } from 'vite';
import { appDir } from './helpers.ts';

let out = '';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [relative(out, path).split('\\').join('/')];
  });
}

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'checklist-build-'));
  await build({ root: appDir, configFile: join(appDir, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out } });
}, 60_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe('production build', () => {
  it('writes the page, one script, one stylesheet, the worker, the manifest, the icons and the catalogue', () => {
    const files = walk(out).sort();
    expect(files.filter((f) => f.startsWith('assets/') && f.endsWith('.js'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.css'))).toHaveLength(1);
    for (const f of ['index.html', 'sw.js', 'catalogue.json', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
      expect(files).toContain(f);
    }
  });

  it('uses relative URLs only, so it works under any subpath', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)].map((m) => m[1] ?? '').filter((u) => !u.startsWith('#') && !u.startsWith('https://github.com/'));
    expect(urls.length).toBeGreaterThanOrEqual(5);
    for (const u of urls) expect(u.startsWith('./'), u).toBe(true);
  });

  it('has no inline script and no eval, so a strict Content-Security-Policy holds', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/u);
    expect(html).not.toMatch(/\sstyle="/u);
    const js = walk(out).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, f), 'utf8')).join('\n');
    expect(js).not.toMatch(/\beval\(|new Function\(|innerHTML/u);
  });

  it('fills the service worker precache with every file of the build, and a version', () => {
    const sw = readFileSync(join(out, 'sw.js'), 'utf8');
    expect(sw).not.toMatch(/__CHECKLIST_(PRECACHE|VERSION)__/u);
    expect(sw).not.toMatch(/^\s*(import|export)\s/mu);
    const list = /\["\.\/",[^\]]*\]/u.exec(sw)?.[0];
    expect(list).toBeDefined();
    const precache = JSON.parse(list ?? '[]') as string[];
    expect(precache.slice(1).sort()).toEqual(walk(out).filter((f) => f !== 'sw.js').sort());
  });

  it('ships catalogue.json exactly as committed', () => {
    expect(readFileSync(join(out, 'catalogue.json'), 'utf8')).toBe(readFileSync(join(appDir, 'public/catalogue.json'), 'utf8'));
  });
});
