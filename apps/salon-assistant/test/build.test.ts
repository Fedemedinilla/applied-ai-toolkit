// Runs the production build into a temporary folder and checks what a static host would serve:
// relative URLs only, one script and one stylesheet, and none of the server or its secrets.

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
  out = mkdtempSync(join(tmpdir(), 'salon-assistant-build-'));
  await build({ root: appRoot, configFile: join(appRoot, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out } });
}, 60_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe('production build', () => {
  it('writes the page, one script and one stylesheet, with relative URLs', () => {
    const files = walk(out).sort();
    expect(files.filter((f) => f.endsWith('.js'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.css'))).toHaveLength(1);
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)].map((m) => m[1] ?? '');
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u.startsWith('./'), u).toBe(true);
  });

  it('ships the renderer and none of the server', () => {
    const js = walk(out).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, f), 'utf8')).join('\n');
    expect(js).toContain('noopener noreferrer');
    for (const s of ['ASSISTANT_HISTORY_SECRET', 'ANTHROPIC_API_KEY', 'createHmac', 'BUSINESS CONTEXT', 'api.anthropic.com']) expect(js).not.toContain(s);
  });
});
