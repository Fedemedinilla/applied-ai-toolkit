# safe-markdown

An escape-first Markdown renderer for model replies that a chat widget shows with `innerHTML`. A model reply is untrusted text: it can echo what a visitor typed, and a prompt injection can make it write HTML or a `javascript:` link. This module HTML-escapes the whole reply before any formatting runs, so every tag in the output is one this file wrote, and every link goes through one function that checks its scheme and host. It covers what a support reply uses: paragraphs, `-` lists, pipe tables, fenced and inline code, links, bare URLs, bold and italic. I extracted it from the chat widget on [kyndredai.com](https://kyndredai.com), where it renders every assistant turn, and fixed the gaps the tests below found in it. It is one TypeScript file with no dependencies and no Node built-ins, so the same module runs in the browser and in tests.

## Run it

From the repository root, offline:

```sh
npx vitest run safe-markdown   # 73 tests, about 7 seconds (most of it is jsdom parsing in the property test)
npm run check                  # tsc --noEmit, strict
```

```ts
import { renderMarkdown } from './safe-markdown/src/index.ts';

bubble.innerHTML = renderMarkdown(reply, {
  internalHosts: ['shop.example'],   // same tab; a bare "shop.example/hours" becomes a link too
  externalHosts: ['maps.example'],   // new tab with rel="noopener noreferrer"; '*' allows any host
});
```

Exports: `renderMarkdown`, `renderInline` (one line, no blocks), `linkTag` (one anchor, or null), `escapeHtml` and `clean` (drops control characters).

## Design decisions

**Escape first, format second.** The usual order (parse Markdown, then sanitize the HTML) needs an HTML sanitizer, which is a large dependency with its own parser differentials. Here `<`, `>`, `&` and both quotes are escaped before anything else, so raw HTML in a reply can only come out as text. The formatting passes add tags around escaped text and never remove an escape.

**Links and code hide behind NUL placeholders.** Inline code and finished anchors are replaced by NUL, an index and NUL before the emphasis passes run, and put back at the end. Without that, `*` and `**` inside an href or a code span would turn into `<em>` inside an attribute. The delimiter is NUL so that digits next to a placeholder (`10[a](/x)20`) are never read as part of the index.

**A link URL that holds a placeholder is refused.** Code runs before links, so ``[x](/a`c`)`` reached the link pass with a code placeholder inside the URL. An earlier version of this file wrote it into the href and restored it there, which produced `<a href="/a<code class="md-code">c</code>">`, with markup inside a quoted attribute. `anchor()` now refuses any URL that contains NUL, and bare URLs stop at one, so the code span after `https://shop.example/a` stays outside the link.

**The input cannot forge a placeholder.** The source assumed NUL never appears in model text. It can, and `a \0` `0\0` in a reply pulled in a copy of another token. `clean()` now removes NUL and the other C0 controls (tab and newline stay) before escaping, and `\r\n` becomes `\n`.

**Nested placeholders are restored.** A code span inside a link label (``[`npm ci`](/docs)``) is a placeholder inside a placeholder. The source restored in one pass, so the inner one reached the screen as NUL characters. Restoring is recursive now; a token can only name an earlier token, so it ends.

**Hosts are judged by the URL parser the browser uses.** The source told internal from external with a prefix regex, so `https://<own host>.evil.example` counted as internal and opened in the same tab with no `rel`. `anchor()` parses absolute URLs with the WHATWG `URL` parser, compares `hostname` exactly (with an optional `www.`), and writes the parser's serialization as the href. `https://shop.example\@evil.example` therefore goes where the browser would send it. The `\` reads as `/`, so the host is `shop.example`. URLs with a user or password are refused, since a reader sees the host before the `@` and the browser visits the one after it.

**Relative means one slash.** The source accepted anything that starts with `/`. `//evil.example` and `/\evil.example` are protocol-relative in a browser and leave the page's origin, so they now stay text. Allowed schemes are http, https and `mailto:` with one `@`; `javascript:`, `data:`, `vbscript:` and `file:` are never links, in any case and behind any control character.

**The host lists are parameters.** `internalHosts` replaces the hardcoded domain, and `externalHosts` can restrict outbound links to a list or forbid them (`[]`). A link that fails the check stays as its literal Markdown text, so the reader still sees what the model wrote.

**Quotes around a bare URL stay outside it.** After escaping, `"https://shop.example/a"` reads `&quot;https://shop.example/a&quot;`, and the source's bare-URL pattern took `&quot` into the link and left a stray `;`. The pattern stops at an escaped quote or angle bracket.

**Patterns that cannot go quadratic.** The source's link pattern `\[([^\]]+)\]` scans to the end of the input from every unclosed `[`. On this machine, 20,000 `[` took 510 ms with it and 50,000 took 3,126 ms; the renderer here takes under 2 ms on both. Labels stop at the next bracket, URLs at the next bracket or parenthesis, and inline code at a newline. A default `maxLength` of 20,000 characters bounds the rest.

**No regex lookbehind.** The bare-host pattern captures the character before the host instead of using `(?<!...)`, because Safari before 16.4 fails to parse a script that contains a lookbehind, and the whole widget would stop loading. The salon-assistant app's build passes the repository's csp-build-guard lookbehind check with Safari 15.6 as a target.

**A fence never lands inside a paragraph.** Each fenced block's placeholder is put on a line of its own before the line pass, so ```` see ```x``` here ```` becomes a paragraph, the `<pre>` and another paragraph. Restoring it in place wrote `<pre>` inside `<p>`, and inside `<strong>` when the fence sat in bold. A browser repairs that by moving elements around, so the DOM no longer matched the string.

**A fence language only before a newline.** The source read ```` ```x``` ```` as language `x` with an empty block. The language tag now needs a newline after it.

## What the tests cover

| File | Covers |
|---|---|
| `test/render.test.ts` | Each block and inline form, internal and external links, bare URLs and hosts, trailing punctuation, the external allowlist, `mailto` off, the class prefix (validated, since it lands in an attribute), the length cut |
| `test/xss.test.ts` | Raw HTML in every block (`<script>`, `<img onerror>`, `<svg onload>`, comments, mXSS-style nesting); `javascript:`, `data:` and other schemes with case, entities, percent-encoding and control characters; protocol-relative and userinfo URLs; lookalike hosts; quotes in hrefs, labels, bare URLs and `mailto`; inline code inside a link URL; forged and nested placeholders; digits next to placeholders; 200 kB of each of ten patterns that break a naive regex, each under 1.5 s |
| `test/properties.test.ts` | fast-check over inputs built from markup, schemes, quotes, NUL, Markdown punctuation and digits, under three host policies, plus `[label](url)` built from fragments so that code spans, quotes and NUL land inside the URL. jsdom parses each output, and the test checks that every element and attribute is on the renderer's list, every href is http(s), `mailto` or same-origin, and every external link has `target` and `rel`. A second property checks that text with no Markdown in it comes back as the same text |

`test/helpers/inspect.ts` is the checker. It reads the DOM jsdom builds, so an attribute that only appears after the browser's parsing would still be caught. It also reads the string before parsing. Every tag must close in order, and no block element may open inside a paragraph or an inline element, since a parser would silently repair either.

## Limits

- The subset is small on purpose. Headings, ordered lists, images, blockquotes and nested lists come out as text.
- URLs with parentheses in them (some encyclopedia links) end at the first `(`.
- Emphasis does not apply inside a link label.
- The output is safe for element content (`innerHTML` of a `div`). It is not meant for an attribute value or a `<script>` block.
- The external allowlist decides where a link can go, not whether the destination is honest. With `'*'`, a model can still link to any https site.
