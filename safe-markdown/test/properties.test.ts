// @vitest-environment jsdom
// Property: whatever the input, the DOM built from the output has only the tags and attributes the
// renderer writes, every href is http(s), mailto, or same-origin, and every external link carries
// target and rel. Inputs are built from fragments chosen to collide: markup, schemes, quotes,
// placeholders, Markdown punctuation and digits.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { renderInline, renderMarkdown } from '../src/index.ts';
import { problems } from './helpers/inspect.ts';

const FRAGMENTS = [
  '<', '>', '"', "'", '&', '&#58;', '&quot;', '\u0000', '\u0000B', '\u00000\u0000', '\u0001', '\r', '\n', '\n\n', ' ',
  '[', ']', '(', ')', '](', '*', '**', '`', '```', '|', '|---|', '- ', '#', '/', '//', '\\', '@', ':',
  '0', '1', '12', 'a', 'x',
  'javascript:', 'JAVASCRIPT:', 'data:text/html,', 'vbscript:', 'mailto:', 'mailto:a@b.example', 'http://', 'https://',
  'shop.example', 'www.shop.example', 'evil.example', 'shop.example.evil.example',
  '<img src=x onerror=alert(1)>', '<script>', '</p>', 'onerror=', 'onclick="', 'style=', '<a href=', '<svg/onload=x>',
];

const reply = fc
  .array(fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...FRAGMENTS) }, { weight: 1, arbitrary: fc.string({ maxLength: 6 }) }), {
    maxLength: 60,
  })
  .map((parts) => parts.join(''));

// Links whose URL is made of fragments: the plain arbitrary rarely assembles `[label](url)`
// around a code span, which is how a placeholder once reached an href.
const URL_PARTS = ['/', '#', 'mailto:a@b', 'https://shop.example/', 'shop.example/', 'https://evil.example/', '`', '`c`', '"', '\'', '*', '**', '0', 'a', 'onx', '&quot;', '<', '\u0000'];
const linked = fc
  .tuple(
    fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 4 }),
    fc.array(fc.constantFrom('a', '`b`', '*c*', '"', '<'), { minLength: 1, maxLength: 3 }),
    fc.array(fc.constantFrom(...URL_PARTS), { minLength: 1, maxLength: 6 }),
    fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 4 }),
  )
  .map(([pre, label, url, post]) => `${pre.join('')}[${label.join('')}](${url.join('')})${post.join('')}`);
const anyReply = fc.oneof(reply, linked);

const policies = fc.constantFrom(
  { internalHosts: ['shop.example'] },
  { internalHosts: ['shop.example'], externalHosts: [] as string[] },
  { internalHosts: [] as string[], externalHosts: ['evil.example'] },
);

describe('the output is inert', () => {
  it('renderMarkdown', () => {
    fc.assert(
      fc.property(anyReply, policies, (s, policy) => {
        expect(problems(renderMarkdown(s, policy), policy)).toEqual([]);
      }),
      { numRuns: 600 },
    );
  }, 60_000);

  it('renderInline', () => {
    fc.assert(
      fc.property(anyReply, policies, (s, policy) => {
        expect(problems(renderInline(s, policy), policy)).toEqual([]);
      }),
      { numRuns: 400 },
    );
  }, 60_000);

  it('any printable text without Markdown punctuation comes back as the same text', () => {
    const plain = fc.string({ unit: fc.constantFrom(...'abc <>&"\'é字 '.split('')), maxLength: 40 }).filter((s) => s.trim() !== '');
    fc.assert(
      fc.property(plain, (s) => {
        const doc = new DOMParser().parseFromString(renderMarkdown(s, { internalHosts: [] }), 'text/html');
        expect(doc.body.textContent?.replace(/\s+/g, ' ').trim()).toBe(s.replace(/\s+/g, ' ').trim());
      }),
    );
  });
});
