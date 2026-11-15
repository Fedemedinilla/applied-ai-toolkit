// The supported subset, rendered: what a model reply in a chat widget actually uses.

import { describe, expect, it } from 'vitest';
import { escapeHtml, linkTag, renderInline, renderMarkdown } from '../src/index.ts';

const opts = { internalHosts: ['shop.example'] } as const;
const md = (s: string) => renderMarkdown(s, opts);

describe('blocks', () => {
  it('paragraphs, with single newlines as <br>', () => {
    expect(md('one\ntwo\n\nthree')).toBe('<p>one<br>two</p><p>three</p>');
  });

  it('a dash list', () => {
    expect(md('Hours:\n- Mon 9 to 18\n- Sat 9 to 13')).toBe('<p>Hours:</p><ul><li>Mon 9 to 18</li><li>Sat 9 to 13</li></ul>');
  });

  it('a pipe table, with missing cells filled', () => {
    expect(md('| Service | Price |\n|---|---|\n| Cut | 10 |\n| Wash |')).toBe(
      '<div class="md-tablewrap"><table class="md-table"><thead><tr><th>Service</th><th>Price</th></tr></thead>' +
        '<tbody><tr><td>Cut</td><td>10</td></tr><tr><td>Wash</td><td></td></tr></tbody></table></div>',
    );
  });

  it('a fenced block keeps its content literal', () => {
    expect(md('```js\nconst a = **b**;\n```')).toBe('<pre class="md-pre"><code>const a = **b**;</code></pre>');
  });

  it('a fence that opens mid-line splits the paragraph, so the <pre> is never inside a <p>', () => {
    expect(md('see ```x``` here')).toBe('<p>see </p><pre class="md-pre"><code>x</code></pre><p> here</p>');
  });

  it('a fence inside bold splits the bold instead of nesting a <pre> in <strong>', () => {
    expect(md('**a ```x``` b**')).toBe('<p>**a </p><pre class="md-pre"><code>x</code></pre><p> b**</p>');
  });

  it('the class prefix is configurable and validated', () => {
    expect(renderMarkdown('`x`', { ...opts, classPrefix: 'chat' })).toBe('<p><code class="chat-code">x</code></p>');
    expect(() => renderMarkdown('x', { ...opts, classPrefix: '" onclick="x' })).toThrow(/classPrefix/);
  });
});

describe('inline', () => {
  it('bold, italic and code', () => {
    expect(renderInline('**a** *b* `c*d*`', opts)).toBe('<strong>a</strong> <em>b</em> <code class="md-code">c*d*</code>');
  });

  it('an internal link opens in the same tab; an external one in a new tab', () => {
    expect(renderInline('[hours](https://shop.example/hours)', opts)).toBe('<a href="https://shop.example/hours">hours</a>');
    expect(renderInline('[map](https://maps.example/x)', opts)).toBe(
      '<a href="https://maps.example/x" target="_blank" rel="noopener noreferrer">map</a>',
    );
  });

  it('www. counts as the same host, and host case does not matter', () => {
    expect(renderInline('https://WWW.Shop.Example/a', opts)).toBe('<a href="https://www.shop.example/a">https://WWW.Shop.Example/a</a>');
  });

  it('relative links, anchors and mailto', () => {
    expect(renderInline('[a](/prices) [b](#faq) [c](mailto:desk@shop.example)', opts)).toBe(
      '<a href="/prices">a</a> <a href="#faq">b</a> <a href="mailto:desk@shop.example">c</a>',
    );
  });

  it('a bare URL keeps trailing punctuation outside the link', () => {
    expect(renderInline('See https://shop.example/faq.', opts)).toBe('See <a href="https://shop.example/faq">https://shop.example/faq</a>.');
  });

  it('a bare URL that ends in & keeps the & and leaves no stray ;', () => {
    expect(renderInline('https://maps.example/?q=1&', opts)).toBe(
      '<a href="https://maps.example/?q=1&amp;" target="_blank" rel="noopener noreferrer">https://maps.example/?q=1&amp;</a>',
    );
    expect(renderInline('Go to shop.example/a&b&.', opts)).toBe(
      'Go to <a href="https://shop.example/a&amp;b&amp;">shop.example/a&amp;b&amp;</a>.',
    );
  });

  it('bold or italic around a bare URL closes outside the link', () => {
    expect(renderInline('Book at **https://shop.example**', opts)).toBe(
      'Book at <strong><a href="https://shop.example/">https://shop.example</a></strong>',
    );
    expect(renderInline('*see https://maps.example/a*', opts)).toBe(
      '<em>see <a href="https://maps.example/a" target="_blank" rel="noopener noreferrer">https://maps.example/a</a></em>',
    );
    expect(renderInline('**shop.example/hours**', opts)).toBe('<strong><a href="https://shop.example/hours">shop.example/hours</a></strong>');
    expect(renderInline('**https://shop.example/faq.**', opts)).toBe(
      '<strong><a href="https://shop.example/faq">https://shop.example/faq</a>.</strong>',
    );
  });

  it('a bare internal host with a path becomes a link; any other bare host does not', () => {
    expect(renderInline('Go to shop.example/book, or other.example/x', opts)).toBe(
      'Go to <a href="https://shop.example/book">shop.example/book</a>, or other.example/x',
    );
  });

  it('an empty or blank internal host entry is ignored, so a path in prose stays text', () => {
    for (const internalHosts of [[''], ['  '], ['shop.example', '']]) {
      expect(renderInline('see /etc/passwd and 1 /2', { internalHosts })).toBe('see /etc/passwd and 1 /2');
    }
    expect(renderInline('shop.example/a', { internalHosts: ['shop.example', ''] })).toBe('<a href="https://shop.example/a">shop.example/a</a>');
  });

  it('quotes around a bare URL stay outside it', () => {
    expect(renderInline('"https://shop.example/a"', opts)).toBe('&quot;<a href="https://shop.example/a">https://shop.example/a</a>&quot;');
  });

  it('an external allowlist turns other hosts into text', () => {
    const strict = { internalHosts: ['shop.example'], externalHosts: ['maps.example'] };
    expect(renderInline('[a](https://maps.example/) [b](https://evil.example/)', strict)).toBe(
      '<a href="https://maps.example/" target="_blank" rel="noopener noreferrer">a</a> [b](https://evil.example/)',
    );
  });

  it('a mailto without an address and a scheme-less external host stay text', () => {
    for (const s of ['[x](mailto:nobody)', '[x](mailto:)', '[x](mailto:a@b@c.example)', '[x](evil.example/a)', '[x](evil.example)']) {
      expect(renderInline(s, opts)).toBe(s);
    }
  });

  it('mailto can be turned off', () => {
    expect(renderInline('[c](mailto:a@shop.example)', { ...opts, mailto: false })).toBe('[c](mailto:a@shop.example)');
  });

  it('a code span inside a link label is restored, not left as a placeholder', () => {
    const out = renderInline('[`npm ci`](/docs)', opts);
    expect(out).toBe('<a href="/docs"><code class="md-code">npm ci</code></a>');
    expect(out).not.toContain('\u0000');
  });
});

describe('linkTag', () => {
  it('escapes its own arguments', () => {
    expect(linkTag('/a', '<b>', opts)).toBe('<a href="/a">&lt;b&gt;</a>');
    expect(linkTag('javascript:alert(1)', 'x', opts)).toBeNull();
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters that matter in text and in quoted attributes', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});

describe('length', () => {
  it('cuts at maxLength with an ellipsis', () => {
    expect(renderMarkdown('abcdef', { ...opts, maxLength: 3 })).toBe('<p>abc…</p>');
  });

  it('a cut inside an emoji drops the whole character instead of leaving half a surrogate pair', () => {
    expect(renderMarkdown('a\u{1F600}b', { ...opts, maxLength: 2 })).toBe('<p>a…</p>');
    expect(renderMarkdown('\u{1F600}\u{1F600}', { ...opts, maxLength: 3 })).toBe('<p>\u{1F600}…</p>');
  });

  it('maxLength must be a whole number of zero or more, or Infinity', () => {
    for (const maxLength of [-1, Number.NaN, 1.5, -Infinity]) {
      expect(() => renderMarkdown('abc', { ...opts, maxLength })).toThrow(/maxLength/);
      expect(() => renderInline('abc', { ...opts, maxLength })).toThrow(/maxLength/);
    }
    expect(renderMarkdown('abc', { ...opts, maxLength: Infinity })).toBe('<p>abc</p>');
    expect(renderMarkdown('abc', { ...opts, maxLength: 0 })).toBe('<p>…</p>');
  });
});
