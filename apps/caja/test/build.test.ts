// Runs the real production build into a temporary folder and checks what a phone would install:
// the manifest and its icons, a service worker at the root with no hash, and a precache that
// lists every file the build wrote, so nothing the app needs is missing offline.

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
  out = mkdtempSync(join(tmpdir(), 'caja-build-'));
  await build({ root: appRoot, configFile: join(appRoot, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out } });
}, 60_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe('production build', () => {
  it('writes the manifest, with icons that exist', () => {
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.webmanifest'), 'utf8')) as {
      start_url: string;
      scope: string;
      display: string;
      icons: Array<{ src: string; purpose: string }>;
    };
    expect(manifest).toMatchObject({ start_url: './', scope: './', display: 'standalone' });
    for (const icon of manifest.icons) expect(statSync(join(out, icon.src)).size).toBeGreaterThan(0);
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('uses relative URLs only, so it works under any subpath', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)].map((m) => m[1] ?? '');
    const local = urls.filter((u) => !u.startsWith('https://') && !u.startsWith('#'));
    expect(local.length).toBeGreaterThan(4);
    for (const u of local) expect(u.startsWith('./')).toBe(true);
  });

  it('writes sw.js at the root, with the placeholders replaced', () => {
    const sw = readFileSync(join(out, 'sw.js'), 'utf8');
    expect(sw).not.toMatch(/__CAJA_/u);
    expect(sw).toMatch(/caja-/u);
  });

  it('sw.js is a self-contained classic script: no import or export a shared chunk would add', () => {
    // main.ts registers it without { type: 'module' }, so an ES import would stop it from installing.
    const sw = readFileSync(join(out, 'sw.js'), 'utf8');
    expect(sw).not.toMatch(/(^|[;}\s])(import|export)\s*[{*\w"'(]/u);
  });

  it('the precache lists every file in the output except the worker itself', () => {
    const sw = readFileSync(join(out, 'sw.js'), 'utf8');
    const list = /addAll\((\[[^\]]*\])/u.exec(sw)?.[1];
    expect(list).toBeDefined();
    const precache = JSON.parse(list ?? '[]') as string[];
    const files = walk(out).filter((f) => f !== 'sw.js');
    expect([...precache].filter((p) => p !== './').sort()).toEqual(files.sort());
    expect(precache).toContain('./');
    expect(precache).toContain('index.html');
    expect(precache).toContain('corpus.json');
  });

  it('ships the corpus unchanged', () => {
    const shipped = readFileSync(join(out, 'corpus.json'), 'utf8');
    const source = readFileSync(new URL('../../../amount-parser/corpus/corpus.json', import.meta.url), 'utf8');
    expect(shipped).toBe(source);
  });
});
