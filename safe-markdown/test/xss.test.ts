// @vitest-environment jsdom
// A battery of hostile replies. Each one is rendered and then parsed by jsdom: the check is on
// the DOM a browser would build, not on the string.

import { describe, expect, it } from 'vitest';
import { renderInline, renderMarkdown } from '../src/index.ts';
import { problems } from './helpers/inspect.ts';

const opts = { internalHosts: ['shop.example'] } as const;
const md = (s: string) => renderMarkdown(s, opts);
const inert = (s: string, o: typeof opts | { internalHosts: readonly string[]; externalHosts: readonly string[] } = opts) =>
  expect(problems(renderMarkdown(s, o), o)).toEqual([]);

describe('raw HTML in the reply', () => {
  const cases = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '<details open ontoggle=alert(1)>',
    '<style>body{display:none}</style>',
    '</p><img src=x onerror=alert(1)><p>',
    '<!--<img src=x onerror=alert(1)>-->',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  ];
  it.each(cases)('%s stays text', (s) => {
    inert(s);
    expect(md(s)).not.toMatch(/<(?:script|img|svg|iframe|style|details|math)/i);
  });

  it('inside a table cell, a list item, bold and a code block', () => {
    for (const s of [
      '| a |\n|---|\n| <img src=x onerror=alert(1)> |',
      '- <img src=x onerror=alert(1)>',
      '**<img src=x onerror=alert(1)>**',
      '```\n<img src=x onerror=alert(1)>\n```',
      '`<img src=x onerror=alert(1)>`',
    ]) inert(s);
  });
});

describe('link schemes', () => {
  const bad = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'javascript&#58;alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'DATA:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://shop.example/x',
    '%6Aavascript:alert(1)',
  ];
  it.each(bad)('[x](%s) is not a link', (url) => {
    const out = md(`[x](${url})`);
    expect(out).not.toContain('<a ');
    inert(`[x](${url})`);
  });

  it('a control character in front of the scheme is removed, and the URL is still refused', () => {
    expect(md('[x](\u0001javascript:alert(1))')).not.toContain('<a ');
    expect(md('[x](java\u0000script:alert(1))')).not.toContain('<a ');
  });

  it('protocol-relative URLs are refused, since they leave the page origin', () => {
    expect(md('[x](//evil.example/a)')).not.toContain('<a ');
    expect(md('[x](/\\evil.example/a)')).not.toContain('<a ');
  });

  it('userinfo is refused: the browser would visit the host after the @', () => {
    expect(md('[x](https://shop.example@evil.example/)')).not.toContain('<a ');
    expect(md('https://shop.example:pw@evil.example/')).not.toContain('<a ');
  });

  it('a lookalike host is external, not internal', () => {
    expect(md('[x](https://shop.example.evil.example/)')).toContain('target="_blank"');
    const strict = { internalHosts: ['shop.example'], externalHosts: [] as string[] };
    expect(renderMarkdown('[x](https://shop.example.evil.example/)', strict)).not.toContain('<a ');
    inert('[x](https://shop.example.evil.example/)', strict);
  });

  it('a backslash before an @ is read the way the browser reads it', () => {
    // WHATWG treats "\" as "/" in http(s), so the host is shop.example and the rest is a path.
    const out = md('[x](https://shop.example\\@evil.example/)');
    inert('[x](https://shop.example\\@evil.example/)');
    expect(out).toContain('href="https://shop.example/@evil.example/"');
  });
});

describe('quotes and attributes', () => {
  it('a double quote in an href cannot close the attribute', () => {
    const s = '[x](https://shop.example/"onmouseover="alert(1))';
    inert(s);
    expect(md(s)).toContain('&quot;onmouseover=&quot;');
  });

  it('a single quote in an href cannot close the attribute', () => {
    inert("[x](https://shop.example/'onmouseover='alert(1))");
  });

  it('a quote in a bare URL', () => {
    inert('https://shop.example/a"onmouseover="alert(1)');
    inert('https://shop.example/a\'><img src=x onerror=alert(1)>');
  });

  it('a quote in a link label', () => {
    inert('[" onclick="alert(1)](/a)');
  });

  it('a quote in a mailto link', () => {
    inert('[x](mailto:a"onclick="alert(1)@shop.example)');
  });

  it('angle brackets in the URL are percent-encoded in the href', () => {
    expect(md('[x](https://shop.example/<b>)')).toContain('href="https://shop.example/%3Cb%3E"');
  });
});

describe('placeholders', () => {
  it('a NUL-delimited index in the reply does not pull in another token', () => {
    const s = 'a \u00000\u0000 b [x](/one)';
    const out = md(s);
    expect(out.match(/<a /g)).toHaveLength(1);
    expect(out).not.toContain('\u0000');
  });

  it('a forged block placeholder does not pull in a code block', () => {
    const out = md('\u0000B0\u0000\n```\ncode\n```');
    expect(out.match(/<pre/g)).toHaveLength(1);
  });

  it('digits next to where a placeholder goes stay digits', () => {
    expect(renderInline('10[a](/x)20 `3`4', opts)).toBe('10<a href="/x">a</a>20 <code class="md-code">3</code>4');
  });

  it('nested markers: emphasis around a link, a link label with code and emphasis', () => {
    expect(renderInline('**[a](/x)**', opts)).toBe('<strong><a href="/x">a</a></strong>');
    const out = renderInline('[`a` *b*](/x) *[c](/y)*', opts);
    expect(problems(out, opts)).toEqual([]);
    expect(out).not.toContain('\u0000');
  });

  it('inline code inside a link URL does not put a tag inside the href', () => {
    // CODE runs before LINK, so the URL holds a code placeholder; restoring it inside the quoted
    // href once wrote <a href="/a<code class="md-code">c</code>">.
    for (const s of ['[x](/a`c`)', '[x](mailto:a@b`c`)', '[x](#`a`onx`b`)', '[x](https://shop.example/`c`)', '[x](shop.example/`c`)']) {
      const out = md(s);
      expect(problems(out, opts)).toEqual([]);
      expect(out).not.toMatch(/href="[^"]*</);
      expect(out).not.toContain('>x</a>');
    }
  });

  it('a bare URL stops before a code span that follows it', () => {
    expect(renderInline('https://shop.example/a`c` shop.example/b`d`', opts)).toBe(
      '<a href="https://shop.example/a">https://shop.example/a</a><code class="md-code">c</code> ' +
        '<a href="https://shop.example/b">shop.example/b</a><code class="md-code">d</code>',
    );
  });

  it('emphasis markers inside an href are not turned into tags', () => {
    expect(renderInline('[a](/x*y*z) https://shop.example/**b**', opts)).toBe(
      '<a href="/x*y*z">a</a> <a href="https://shop.example/**b**">https://shop.example/**b**</a>',
    );
  });
});

describe('huge inputs', () => {
  // Each pattern is one a naive regex scans once per opening character, which is quadratic.
  const patterns = ['[', '[a](', '`', '**a', '*a', '| ', 'https://', '```', '[a](b', '<'];
  it.each(patterns)('200 kB of %j renders in linear time', (p) => {
    const s = p.repeat(Math.ceil(200_000 / p.length));
    const t0 = performance.now();
    const out = renderMarkdown(s, { ...opts, maxLength: Infinity });
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(out.length).toBeGreaterThan(0);
  });

  it('the default limit cuts a 1 MB reply to 20,000 characters', () => {
    const out = md('a'.repeat(1_000_000));
    expect(out).toBe(`<p>${'a'.repeat(20_000)}…</p>`);
  });

  it('a large mixed reply stays inert', () => {
    const chunk = '**a** [x](javascript:alert(1)) <img src=x onerror=alert(1)> https://shop.example/a"b `c`\n';
    inert(chunk.repeat(200));
  });
});
