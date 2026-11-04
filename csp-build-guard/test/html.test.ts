import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeEntities, hashSources, parseAttributes, parsePage, scriptKind } from '../src/html.ts';

const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

describe('parsePage', () => {
  it('hashes inline scripts and styles with CRLF turned into LF, as the HTML parser does', () => {
    const { inline } = parsePage('<script>\r\nlet a = 1;\r\n</script><style>p{}\r</style>');
    expect(inline.map((i) => [i.kind, i.text])).toEqual([
      ['script-elem', '\nlet a = 1;\n'],
      ['style-elem', 'p{}\n'],
    ]);
    expect(inline[0]?.hashes.sha256).toBe(sha256('\nlet a = 1;\n'));
  });

  it('skips an empty inline script, which the browser never checks, and keeps a whitespace-only one', () => {
    const { inline, inlineJs } = parsePage('<script></script><script type="module"></script><script> </script>');
    expect(inline.map((i) => i.text)).toEqual([' ']);
    expect(inlineJs).toEqual([' ']);
  });

  it('skips data blocks and comments, and keeps import maps, which CSP still checks', () => {
    const html = `<!-- <script>commented()</script> -->
      <script type="application/ld+json">{"a":1}</script>
      <script type="text/template"><p></p></script>
      <script type="importmap">{"imports":{}}</script>
      <script type="module">import "./a.js";</script>`;
    const { inline, inlineJs } = parsePage(html);
    expect(inline.map((i) => i.label)).toEqual(['<script type="importmap">', '<script type="module">']);
    expect(inlineJs).toEqual(['import "./a.js";']);
  });

  it('reads a ">" inside a quoted attribute as part of the attribute', () => {
    const { scriptSrcs, inline } = parsePage('<script data-x="a>b" src="/x.js"></script><script data-y=\'>\'>run()</script>');
    expect(scriptSrcs).toEqual(['/x.js']);
    expect(inline.map((i) => i.text)).toEqual(['run()']);
  });

  it('collects external scripts, modulepreload links and Astro island URLs, but not data block sources', () => {
    const parts = parsePage(`<script src="/a.js"></script><script type="module" src="./b.js"></script>
      <script type="application/json" src="/data.json"></script>
      <link rel="modulepreload" href="/c.js"><link rel="preload stylesheet" href="/s.css">
      <astro-island component-url="/d.js" renderer-url="/e.js" before-hydration-url="/f.js"></astro-island>`);
    expect(parts.scriptSrcs).toEqual(['/a.js', './b.js']);
    expect(parts.modulePreloads).toEqual(['/c.js']);
    expect(parts.islandUrls).toEqual(['/d.js', '/e.js', '/f.js']);
  });

  it('records event handlers and style attributes with their decoded values', () => {
    const { inline } = parsePage(`<button ONCLICK="go(&quot;x&quot;)" style='color:red'>x</button>`);
    expect(inline.map((i) => [i.kind, i.label, i.text])).toEqual([
      ['script-attr', '<button onclick>', 'go("x")'],
      ['style-attr', '<button style>', 'color:red'],
    ]);
  });

  it('reads meta policies with entities decoded, and notices one placed after a script', () => {
    const before = parsePage(`<meta http-equiv="Content-Security-Policy" content="script-src &#39;self&#39;"><script>x()</script>`);
    expect(before.metaPolicies).toEqual(["script-src 'self'"]);
    expect(before.metaAfterContent).toBe(false);
    const after = parsePage(`<script>x()</script><meta http-equiv="content-security-policy" content="script-src 'self'">`);
    expect(after.metaAfterContent).toBe(true);
    const afterJsonLd = parsePage(`<script type="application/ld+json">{}</script><meta http-equiv="content-security-policy" content="x">`);
    expect(afterJsonLd.metaAfterContent).toBe(false);
  });
});

describe('helpers', () => {
  it('classifies script types by MIME essence', () => {
    expect(scriptKind(undefined)).toBe('js');
    expect(scriptKind(' Text/JavaScript ; charset=utf-8')).toBe('js');
    expect(scriptKind('module')).toBe('module');
    expect(scriptKind('importmap')).toBe('checked');
    expect(scriptKind('application/ld+json')).toBe('data');
  });

  it('decodes named and numeric entities and leaves unknown ones alone', () => {
    expect(decodeEntities('&#39;a&#x27;&amp;&lt;&unknown;')).toBe("'a'&<&unknown;");
  });

  it('keeps the first of a repeated attribute, as HTML does', () => {
    expect(parseAttributes('<script src="/a.js" SRC="/b.js" defer>').get('src')).toBe('/a.js');
  });

  it('computes the three hash sources a policy can list', () => {
    const h = hashSources('x');
    expect(h.sha256).toBe(sha256('x'));
    expect(h.sha384).toMatch(/^'sha384-/);
    expect(h.sha512).toMatch(/^'sha512-/);
  });
});
