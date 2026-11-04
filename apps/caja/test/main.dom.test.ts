// @vitest-environment jsdom
//
// The browser entry, not mountApp: main.ts must hand model mode a fetch, or the published page never
// asks ./api/health and the switch never appears. The other DOM tests pass their own `api` to
// mountApp, so only this file catches an entry point that forgets it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../index.html'), 'utf8');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('main.ts', () => {
  it('asks ./api/health on load and shows the switch when it answers ok', async () => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    document.body.replaceWith(document.importNode(parsed.body, true));
    // Vite's `define` replaces this in a build; true here keeps the service worker out.
    Object.assign(globalThis, { __CAJA_DEV__: true });
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (input: string) => {
      asked.push(input);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await import('../src/main.ts');

    expect(asked).toContain('./api/health');
    const toggle = document.querySelector<HTMLElement>('#model-toggle');
    for (let i = 0; i < 100 && toggle?.hidden; i++) await new Promise((r) => setTimeout(r, 5));
    expect(toggle?.hidden).toBe(false);
  });
});
