import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { staticImports } from '../src/checks/js-budget.ts';
import { needlesFor } from '../src/checks/secrets.ts';
import { ConfigError, parseConfig } from '../src/config.ts';
import { normalizeHash } from '../src/csp.ts';
import { runGuard } from '../src/run.ts';
import type { CheckId, GuardReport } from '../src/types.ts';

const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** Writes a tiny build into a fresh temp folder and runs the guard over it. */
function guard(files: Record<string, string | Buffer>, config: unknown, env: Record<string, string> = {}): GuardReport {
  const dir = mkdtempSync(join(tmpdir(), 'csp-guard-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return runGuard({ dir, config: parseConfig(config, dir), env });
}
const check = (report: GuardReport, id: CheckId) => report.checks.find((c) => c.id === id);
const messages = (report: GuardReport, id: CheckId) => check(report, id)?.failures.map((f) => f.message) ?? [];

describe('secrets', () => {
  // '"' and '\' change under JSON, ' ' and '&' under URL encoding, and '>>>?' gives base64 with '+'
  // and '/', which base64url writes as '-' and '_'.
  const VALUE = 'a"b\\c d&e>>>?fgh';

  it('builds one needle per distinct form of the value', () => {
    const forms = Object.fromEntries(needlesFor(VALUE).map((n) => [n.form, n.bytes.toString()]));
    expect(forms).toEqual({
      plain: VALUE,
      'JSON-escaped': 'a\\"b\\\\c d&e>>>?fgh',
      'URL-encoded': 'a%22b%5Cc%20d%26e%3E%3E%3E%3Ffgh',
      base64: Buffer.from(VALUE).toString('base64').replace(/=+$/, ''),
      base64url: Buffer.from(VALUE).toString('base64url'),
    });
    expect(forms.base64).not.toBe(forms.base64url);
    // A value no encoding changes yields a single needle per distinct text.
    expect(needlesFor('abcdefgh').map((n) => n.form)).toEqual(['plain', 'base64']);
  });

  it.each([
    ['JSON-escaped', `{"k":"${JSON.stringify(VALUE).slice(1, -1)}"}`],
    ['URL-encoded', `fetch("/x?k=${encodeURIComponent(VALUE)}")`],
    ['base64url', `const t="${Buffer.from(VALUE).toString('base64url')}"`],
  ])('finds the %s form in a built file', (form, content) => {
    const report = guard({ 'index.html': '<p></p>', 'a.js': content }, { secrets: { env: ['S'] } }, { S: VALUE });
    expect(messages(report, 'secrets')).toEqual([`the value of S is in a.js (${form})`]);
  });

  it('decompresses a .br file before searching it', () => {
    const report = guard(
      { 'index.html': '<p></p>', 'a.js.br': brotliCompressSync(Buffer.from(`const k="${VALUE}"`)) },
      { secrets: { env: ['S'] } },
      { S: VALUE },
    );
    expect(messages(report, 'secrets')).toEqual(['the value of S is in a.js.br']);
  });
});

describe('staticImports', () => {
  it('reads minified and spaced static imports and re-exports, and skips dynamic import()', () => {
    const code = [
      'import"./a.js";',
      'import{a as b}from"./b.js";',
      'export*from"./c.mjs";',
      "export { d } from './d.js'",
      'import e, * as f from "/e.js"',
      'import"./g.js?v=1";',
      'import"./h";',
      'import("./lazy.js");',
      'const x=await import("./lazy2.js")',
    ].join('\n');
    expect(staticImports(code)).toEqual(['./a.js', './b.js', './c.mjs', './d.js', '/e.js', './g.js?v=1', './h']);
  });

  it('counts a query-string import against the file and fails on an extensionless one', () => {
    const report = guard(
      {
        'index.html': '<script type="module" src="/main.js"></script>',
        'main.js': 'import"./dep.js?v=1";import"./missing";',
        'dep.js': 'export const dep=1;',
      },
      { budgets: [{ pages: '**/*.html', gzipKb: 10 }] },
    );
    const weight = (check(report, 'js-budget')?.details as Array<{ files: Array<{ url: string }> }>)[0];
    expect(weight?.files.map((f) => f.url).sort()).toEqual(['/dep.js', '/main.js']);
    expect(messages(report, 'js-budget')).toEqual(['cannot measure /missing (not in the build), loaded by index.html']);
  });
});

describe('lookbehind targets', () => {
  const files = { 'index.html': '<p></p>', 'a.js': 'const r=/(?<=\\$)\\d+/;' };

  it('skips when every target supports lookbehind, comparing versions as numbers per part', () => {
    const report = guard(files, { lookbehind: { targets: { safari: '16.10', chrome: 120 } } });
    expect(check(report, 'lookbehind')).toMatchObject({ status: 'skip', summary: 'every configured target supports lookbehind' });
  });

  it('fails for a target one minor version short, and names it as written', () => {
    const report = guard(files, { lookbehind: { targets: { safari: '16.3', ios: '16.4' } } });
    expect(messages(report, 'lookbehind')).toEqual([expect.stringContaining('which Safari 16.3 cannot parse')]);
  });

  it('rejects a fractional number, which would read 16.10 as 16.1', () => {
    expect(() => parseConfig({ lookbehind: { targets: { safari: 16.4 } } }, '.')).toThrow(ConfigError);
  });
});

describe('inline hashes', () => {
  const literal = (value: string) => ({ csp: { from: 'literal', value }, inline: { styles: 'skip' } });

  it('needs no hash for an empty <script></script>, but does for a whitespace-only one', () => {
    const empty = guard({ 'index.html': '<script></script>' }, literal("script-src 'self'"));
    expect(check(empty, 'inline-hashes')?.status).toBe('pass');
    const blank = guard({ 'index.html': '<script> </script>' }, literal("script-src 'self'"));
    expect(messages(blank, 'inline-hashes')).toEqual([expect.stringContaining(`does not list ${sha256(' ')}`)]);
  });

  it('accepts a hash with an uppercase algorithm or a base64url digest, as the browser does', () => {
    const text = 'run()';
    const base64 = createHash('sha256').update(text).digest('base64');
    expect(normalizeHash(`'SHA256-${base64}'`)).toBe(sha256(text));
    const url = createHash('sha256').update(text).digest('base64url');
    expect(normalizeHash(`'sha256-${url}'`)).toBe(`'sha256-${base64.replace(/=+$/, '')}'`);
    const report = guard({ 'index.html': `<script>${text}</script>` }, literal(`script-src 'self' 'SHA256-${base64}'`));
    expect(check(report, 'inline-hashes')?.status).toBe('pass');
  });

  it('reports a hash left in script-src when script-src-elem and script-src-attr shadow it', () => {
    const text = 'run()';
    const policy = `script-src 'self' ${sha256(text)}; script-src-elem 'self' ${sha256(text)}; script-src-attr 'none'`;
    const report = guard({ 'index.html': `<script>${text}</script>` }, literal(policy));
    expect(messages(report, 'inline-hashes')).toEqual([
      `script-src lists ${sha256(text)}, but more specific directives take precedence over script-src for every inline kind on index.html, so the hash has no effect; remove it.`,
    ]);
  });
});

describe('meta policies', () => {
  const config = { csp: { from: 'meta' }, policy: { 'script-src': ["'self'"] } };

  it('reads a comma in a <meta> as part of a source, not as a second policy', () => {
    const report = guard({ 'index.html': `<meta http-equiv="Content-Security-Policy" content="script-src 'self', https:">` }, config);
    expect(messages(report, 'policy')).toEqual(["index.html: script-src: missing 'self'", "index.html: script-src: unexpected 'self',", 'index.html: script-src: unexpected https:']);
  });

  it('reports two <meta> policies as such', () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`;
    const report = guard({ 'index.html': meta + meta }, config);
    expect(messages(report, 'policy')).toEqual(['index.html: 2 <meta> policies; the browser enforces each of them, and one is expected']);
    expect(check(report, 'policy')?.summary).toBe('1 of 1 page differs from the expected policy');
  });

  it('agrees the verb and the nouns with their counts in a passing summary', () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`;
    expect(check(guard({ 'index.html': meta }, config), 'policy')?.summary).toBe('1 page sends exactly the expected policy (1 directive)');
    expect(check(guard({ 'index.html': meta, 'about.html': meta }, config), 'policy')?.summary).toBe('2 pages send exactly the expected policy (1 directive)');
  });
});
