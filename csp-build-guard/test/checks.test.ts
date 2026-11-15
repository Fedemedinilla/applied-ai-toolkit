import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { staticImports } from '../src/checks/js-budget.ts';
import { findLookbehind } from '../src/checks/lookbehind.ts';
import { needlesFor } from '../src/checks/secrets.ts';
import { ConfigError, parseConfig } from '../src/config.ts';
import { normalizeHash } from '../src/csp.ts';
import { listFiles } from '../src/site.ts';
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

  it('finds a value embedded in a larger base64 or base64url blob at any offset', () => {
    const secret = 'fixture-secret-value-0001'; // 25 characters, not a multiple of 3
    const files = {
      'index.html': '<p></p>',
      'a.js': `atob("${Buffer.from(`{"k":"${secret}"}`).toString('base64')}")`,
      'b.js': `"${Buffer.from(`${secret}!`).toString('base64')}"`,
      'd.js': `"${Buffer.from('unrelated-value-0001-unrelated').toString('base64')}"`,
    };
    const report = guard(files, { secrets: { env: ['S'] } }, { S: secret });
    expect(messages(report, 'secrets')).toEqual(['the value of S is in a.js (base64)', 'the value of S is in b.js (base64)']);
    // VALUE encodes with '+' and '/', so its base64url form differs; here it starts at offset 2.
    const url = guard({ 'index.html': '<p></p>', 'c.js': `"${Buffer.from(`xy${VALUE}!`).toString('base64url')}"` }, { secrets: { env: ['S'] } }, { S: VALUE });
    expect(messages(url, 'secrets')).toEqual(['the value of S is in c.js (base64url)']);
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

describe('js-budget inputs', () => {
  it('reports a script URL or import specifier that is not a valid URL instead of crashing', () => {
    const report = guard(
      {
        'index.html': '<script src="https://bad host/a.js"></script><script type="module" src="/m.js"></script>',
        'm.js': 'import"https://bad host/x.js";',
      },
      { budgets: [{ pages: '**/*.html', gzipKb: 10 }] },
    );
    expect(messages(report, 'js-budget')).toEqual([
      'cannot measure https://bad host/a.js (not a valid URL), loaded by index.html',
      'cannot measure https://bad host/x.js (not a valid URL), loaded by index.html',
    ]);
  });
});

describe('js-budget globs', () => {
  it('fails a budget whose glob matches no page, which would otherwise measure nothing', () => {
    const files = { 'index.html': '<script src="/a.js"></script>', 'a.js': 'run()' };
    const typo = guard(files, { budgets: [{ pages: 'index.htm', gzipKb: 1 }] });
    expect(check(typo, 'js-budget')?.status).toBe('fail');
    expect(messages(typo, 'js-budget')).toEqual(['the budget for "index.htm" matches no page, so it measures nothing']);
    const partly = guard(files, { budgets: [{ pages: 'index.html', gzipKb: 1 }, { pages: 'blog/**', gzipKb: 1 }] });
    expect(messages(partly, 'js-budget')).toEqual(['the budget for "blog/**" matches no page, so it measures nothing']);
  });
});

describe('build folder walk', () => {
  it('skips a dangling symlink instead of crashing the run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csp-guard-'));
    writeFileSync(join(dir, 'index.html'), '<p></p>');
    writeFileSync(join(dir, 'a.js'), 'run()');
    symlinkSync('nowhere', join(dir, 'dangling'));
    expect(listFiles(dir)).toEqual(['a.js', 'index.html']);
    const report = runGuard({ dir, config: parseConfig({ secrets: { env: ['S'] } }, dir), env: { S: 'fixture-secret-value-0001' } });
    expect(check(report, 'secrets')).toMatchObject({ status: 'pass', summary: '2 files searched, no value of S' });
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

  it('does not count a byte order mark as a column on line 1', () => {
    const plain = guard(files, {});
    const bom = guard({ ...files, 'a.js': `\uFEFF${files['a.js']}` }, {});
    expect(messages(plain, 'lookbehind')).toEqual([expect.stringMatching(/^a\.js:1:10: /)]);
    expect(messages(bom, 'lookbehind')).toEqual(messages(plain, 'lookbehind'));
    expect(findLookbehind('\uFEFFx\n/(?<!a)b/')).toEqual({ count: 1, line: 2, column: 2 });
  });

  it('rejects a fractional number, which would read 16.10 as 16.1', () => {
    expect(() => parseConfig({ lookbehind: { targets: { safari: 16.4 } } }, '.')).toThrow(ConfigError);
  });

  it('rejects an empty targets object, which would leave nothing to compare against', () => {
    expect(() => parseConfig({ lookbehind: { targets: {} } }, '.')).toThrow(/lookbehind\.targets: list at least one browser/);
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

  it('fails a page whose delivered policy is empty, since it restricts nothing', () => {
    const page = '<script>alert(1)</script>';
    const empty = 'index.html: the Content-Security-Policy is empty, so inline content is not restricted and there is nothing to check hashes against';
    for (const value of ['', ' ', ';']) {
      expect(messages(guard({ 'index.html': page }, literal(value)), 'inline-hashes')).toEqual([empty]);
    }
    const meta = guard({ 'index.html': `<meta http-equiv="Content-Security-Policy" content="">${page}` }, { csp: { from: 'meta' } });
    expect(messages(meta, 'inline-hashes')).toEqual([empty]);
    const vercel = JSON.stringify({ headers: [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: '' }] }] });
    const header = guard({ 'index.html': page, 'vercel.json': vercel }, { csp: { from: 'vercel-json' } });
    expect(messages(header, 'inline-hashes')).toEqual([empty]);
    expect(header.ok).toBe(false);
  });

  it('runs the guard with a base64url digest: padded it matches, unpadded it does not, as CSP3 compares text', () => {
    const text = 'run()';
    const url = createHash('sha256').update(text).digest('base64url');
    const padded = guard({ 'index.html': `<script>${text}</script>` }, literal(`script-src 'self' 'sha256-${url}='`));
    expect(check(padded, 'inline-hashes')?.status).toBe('pass');
    const unpadded = guard({ 'index.html': `<script>${text}</script>` }, literal(`script-src 'self' 'sha256-${url}'`));
    expect(messages(unpadded, 'inline-hashes')).toEqual([
      expect.stringContaining(`does not list ${sha256(text)}`),
      expect.stringContaining(`lists 'sha256-${url}', which matches no inline content`),
    ]);
  });

  it("reports only 'unsafe-inline' when it is the reason inline content runs, not a block the browser does not make", () => {
    const page = '<script>run()</script><p onclick="x()">';
    const loose = guard({ 'index.html': page }, literal("script-src 'self' 'unsafe-inline'"));
    expect(messages(loose, 'inline-hashes')).toEqual([
      "index.html: script-src has 'unsafe-inline', which lets any injected inline script run. Allow inline content by hash instead.",
    ]);
    // Next to a hash, CSP3 browsers ignore 'unsafe-inline', so content without its hash is blocked.
    const mixed = guard({ 'index.html': '<script>run()</script><script>other()</script>' }, literal(`script-src 'self' 'unsafe-inline' ${sha256('run()')}`));
    expect(messages(mixed, 'inline-hashes')).toEqual([
      "index.html: script-src has 'unsafe-inline', which lets any injected inline script run. Allow inline content by hash instead.",
      expect.stringContaining(`does not list ${sha256('other()')}`),
    ]);
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

  it('fails a page whose only <meta> policy sits in <body>, since the browser ignores it', () => {
    const page = `<head><title>x</title></head><body><meta http-equiv="Content-Security-Policy" content="script-src 'self'"><p>hi</p></body>`;
    const report = guard({ 'index.html': page }, config);
    expect(messages(report, 'policy')).toEqual([
      'index.html: a <meta> policy outside <head>, which the browser ignores',
      'index.html: no Content-Security-Policy',
    ]);
    expect(check(report, 'inline-hashes')?.status).toBe('fail');
  });

  it('checks a <meta> policy next to a header policy, since the browser enforces both', () => {
    const header = `script-src ${sha256('alert(1)')}`;
    const vercel = JSON.stringify({ headers: [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: header }] }] });
    const page = `<head><meta http-equiv="Content-Security-Policy" content="script-src https://evil.example"><script>alert(1)</script></head>`;
    const report = guard({ 'index.html': page, 'vercel.json': vercel }, { csp: { from: 'vercel-json' }, policy: { 'script-src': { sources: [], hashes: true } } });
    expect(messages(report, 'inline-hashes')).toEqual([expect.stringMatching(/^script-src does not list 'sha256-.*on index\.html\. The browser blocks it/)]);
    expect(messages(report, 'policy')).toEqual([
      'index.html: the page also carries a <meta> policy, which the browser enforces next to the header; one policy is expected',
    ]);
    const literal = guard({ 'index.html': page }, { csp: { from: 'literal', value: header }, policy: { 'script-src': { sources: [], hashes: true } } });
    expect(messages(literal, 'policy')).toEqual(messages(report, 'policy'));
  });

  it('agrees the verb and the nouns with their counts in a passing summary', () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`;
    expect(check(guard({ 'index.html': meta }, config), 'policy')?.summary).toBe('1 page sends exactly the expected policy (1 directive)');
    expect(check(guard({ 'index.html': meta, 'about.html': meta }, config), 'policy')?.summary).toBe('2 pages send exactly the expected policy (1 directive)');
  });
});
