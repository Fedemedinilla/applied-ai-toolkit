// Runs the real production build into a temporary folder and checks what a phone would install:
// the manifest and its icons, relative URLs, and a classic-script worker at the root with no hash.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';

const appRoot = new URL('..', import.meta.url).pathname;
let out = '';

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'push-lab-build-'));
  await build({ root: appRoot, configFile: join(appRoot, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out } });
}, 60_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe('production build', () => {
  it('writes the manifest, standalone, with icons that exist', () => {
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.webmanifest'), 'utf8')) as {
      start_url: string;
      scope: string;
      display: string;
      icons: Array<{ src: string; purpose: string }>;
    };
    expect(manifest).toMatchObject({ start_url: './', scope: './', display: 'standalone' });
    for (const icon of manifest.icons) expect(statSync(join(out, icon.src)).size).toBeGreaterThan(0);
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    expect(statSync(join(out, 'apple-touch-icon.png')).size).toBeGreaterThan(0);
  });

  it('uses relative URLs only, so it works under any subpath', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)].map((m) => m[1] ?? '');
    expect(urls.length).toBeGreaterThan(4);
    for (const u of urls) expect(u.startsWith('./')).toBe(true);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/u); // no inline script, for a strict CSP
  });

  it('writes sw.js at the root as a self-contained classic script with its version set', () => {
    const sw = readFileSync(join(out, 'sw.js'), 'utf8');
    expect(sw).not.toMatch(/(^|[;}\s])(import|export)\s*[{*\w"'(]/u);
    expect(sw).not.toContain('__PUSH_LAB_VERSION__');
    expect(sw).toContain('api/subscribe');
    expect(sw).toContain('showNotification');
  });
});
