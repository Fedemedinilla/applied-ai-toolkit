// Runs the production build into a temporary folder and checks what a phone would install: the
// manifest and its icons, relative URLs, a service worker at the root that is a classic script, and
// a precache that lists every file the build wrote, the batch worker included.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const appRoot = new URL('..', import.meta.url).pathname;
let out = '';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [relative(out, path)];
  });
}

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'replay-lab-build-'));
  await build({ root: appRoot, configFile: join(appRoot, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out } });
}, 60_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe('production build', () => {
  it('writes the manifest, with icons that exist and a maskable one', () => {
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

  it('uses relative URLs only', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)].map((m) => m[1] ?? '');
    const local = urls.filter((u) => !u.startsWith('https://') && !u.startsWith('#'));
    expect(local.length).toBeGreaterThan(4);
    for (const u of local) expect(u.startsWith('./')).toBe(true);
  });

  it('emits the batch worker as its own hashed file, referenced relatively from the page script', () => {
    const files = walk(out);
    const worker = files.find((f) => /^assets\/batch-worker-[\w-]+\.js$/u.test(f));
    expect(worker).toBeDefined();
    const page = files.filter((f) => /^assets\/index-[\w-]+\.js$/u.test(f)).map((f) => readFileSync(join(out, f), 'utf8')).join('');
    expect(page).toContain(worker?.slice('assets/'.length));
    // The worker carries the core: it replays runs on its own.
    expect(readFileSync(join(out, worker ?? ''), 'utf8')).toContain('dice-1');
  });

  it('sw.js is at the root, a classic script, with the placeholders replaced', () => {
    const sw = readFileSync(join(out, 'sw.js'), 'utf8');
    expect(sw).not.toMatch(/__REPLAY_LAB_/u);
    expect(sw).not.toMatch(/(^|[;}\s])(import|export)\s*[{*\w"'(]/u);
  });

  it('the precache lists every file in the output except the worker script itself', () => {
    const sw = readFileSync(join(out, 'sw.js'), 'utf8');
    const list = /addAll\((\[[^\]]*\])/u.exec(sw)?.[1];
    const precache = JSON.parse(list ?? '[]') as string[];
    expect(precache.filter((p) => p !== './').sort()).toEqual(walk(out).filter((f) => f !== 'sw.js').sort());
    expect(precache).toContain('./');
  });
});
