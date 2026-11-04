// Runs the production build into a temporary folder and checks the loader a business will embed:
// one unhashed classic script, scoped so it adds nothing to the host page's window, with no
// HTML-parsing call, and pages that reach it and their assets by relative URLs.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';

const appRoot = join(import.meta.dirname, '..');
let out = '';

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'chat-widget-build-'));
  await build({ root: appRoot, configFile: join(appRoot, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out } });
}, 60_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe('production build', () => {
  it('emits embed/chat.js as a classic script that defines no globals', () => {
    const loader = readFileSync(join(out, 'embed/chat.js'), 'utf8');
    expect(loader.startsWith('(function () {')).toBe(true);
    expect(loader).not.toMatch(/^\s*(import|export)\b/mu);
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) expect(loader).not.toContain(sink);
    // Run it in an empty context with no currentScript: it warns and leaves the global object as it was.
    const warnings: unknown[] = [];
    const context: Record<string, unknown> = { document: { currentScript: null }, HTMLScriptElement: class {}, console: { warn: (...a: unknown[]) => warnings.push(a) } };
    const before = Object.keys(context).sort();
    runInNewContext(loader, context);
    expect(Object.keys(context).sort()).toEqual(before);
    expect(warnings).toHaveLength(1);
  });

  it('loads the loader from the demo page by the same tag a business pastes, and uses relative URLs', () => {
    const demo = readFileSync(join(out, 'index.html'), 'utf8');
    expect(demo).toContain('<script src="./embed/chat.js" data-tenant="vivero-demo" async></script>');
    const panel = readFileSync(join(out, 'panel/index.html'), 'utf8');
    for (const html of [demo, panel]) {
      const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)].map((m) => m[1] ?? '');
      expect(urls.filter((u) => u.startsWith('/') || /^https?:/u.test(u))).toEqual([]);
    }
    expect(panel).toMatch(/<script type="module" crossorigin src="\.\.\/assets\/panel-[\w-]+\.js"><\/script>/u);
  });
});
