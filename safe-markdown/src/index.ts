/**
 * Escape-first Markdown for model replies shown with innerHTML.
 *
 * The whole input is HTML-escaped before any formatting runs, so every tag in the output was
 * written by this file. Links and inline code are moved behind placeholders made of a NUL
 * character, an index and another NUL, so the emphasis passes cannot reach into an href or a
 * code span. The input has its NUL and other control characters removed first, so a reply cannot
 * forge a placeholder.
 *
 * The subset: paragraphs, line breaks, `-` lists, pipe tables, fenced code, inline code, links,
 * bare URLs, **bold** and *italic*. Anything else stays as escaped text.
 */

export interface MarkdownOptions {
  /**
   * Hosts that open in the same tab, matched exactly or with a `www.` prefix. A bare
   * `host/path` with no scheme becomes a link only for these hosts.
   */
  readonly internalHosts: readonly string[];
  /**
   * Hosts allowed for links outside `internalHosts`, which open in a new tab with
   * `rel="noopener noreferrer"`. `'*'` allows any http or https host; an empty list turns every
   * external link into plain text. Defaults to `'*'`.
   */
  readonly externalHosts?: readonly string[] | '*';
  /** Whether `mailto:` links are rendered. Defaults to true. */
  readonly mailto?: boolean;
  /** Prefix for the class names on code, tables and the table wrapper. Defaults to `md`. */
  readonly classPrefix?: string;
  /**
   * Characters rendered; the rest is cut and replaced by an ellipsis. Defaults to 20,000.
   * `Infinity` turns the cut off.
   */
  readonly maxLength?: number;
}

const Z = '\u0000';
const DEFAULT_MAX = 20_000;

/** Every C0 control except tab and newline, plus DEL. NUL is the placeholder delimiter. */
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The inverse of escapeHtml, for the five entities it writes and nothing else. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Removes the characters a placeholder is made of and normalizes line endings. */
export function clean(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(CONTROLS, '');
}

interface Resolved {
  internal: readonly string[];
  external: readonly string[] | '*';
  mailto: boolean;
  prefix: string;
  max: number;
  /** Bare `host/path` for the internal hosts (group 1 is the character before it), or null when there are none. */
  bareHost: RegExp | null;
}

function resolve(options: MarkdownOptions): Resolved {
  const prefix = options.classPrefix ?? 'md';
  if (!/^[a-z][a-z0-9-]*$/i.test(prefix)) throw new Error('safe-markdown: classPrefix must be letters, digits and hyphens');
  const norm = (h: string) => h.trim().toLowerCase().replace(/^www\./, '');
  const external = options.externalHosts ?? '*';
  const internal = options.internalHosts.map(norm);
  return {
    internal,
    bareHost: internal.length
      ? new RegExp(`(^|[^\\w./@-])((?:www\\.)?(?:${internal.map(escapeRegex).join('|')})/(?:(?!&(?:quot|#39|lt|gt);)[^\\s()\\u0000])*)`, 'gi')
      : null,
    external: external === '*' ? '*' : external.map(norm),
    mailto: options.mailto ?? true,
    prefix,
    max: options.maxLength ?? DEFAULT_MAX,
  };
}

function hostIn(hostname: string, list: readonly string[]): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  return list.includes(h);
}

/**
 * The anchor for an already-escaped URL and label, or null when the URL is not allowed.
 *
 * Absolute URLs are parsed with the WHATWG URL parser, the one the browser uses on the href, so
 * `https://allowed.example@evil.example` and `https://allowed.example.evil.example` are judged by
 * the host the browser would visit. The href written is the parser's own serialization, escaped.
 * A relative URL must start with one `/` or a `#`: `//host` and `/\host` are protocol-relative in
 * a browser and would leave the allowlist. A URL that holds a placeholder (a code span inside
 * the parentheses) is refused: restoring it would put a `<code>` tag inside the quoted href.
 */
function anchor(url: string, label: string, r: Resolved): string | null {
  if (url.includes(Z)) return null;
  const raw = unescapeHtml(url);
  if (/^mailto:/i.test(raw)) {
    if (!r.mailto || !/^mailto:[^\s@]+@[^\s@]+$/i.test(raw)) return null;
    return `<a href="${escapeHtml(raw)}">${label}</a>`;
  }
  if (raw.startsWith('#') || (raw.startsWith('/') && !/^\/[/\\]/.test(raw))) {
    return `<a href="${escapeHtml(raw)}">${label}</a>`;
  }
  let absolute = raw;
  if (!/^https?:\/\//i.test(raw)) {
    // A bare host only for an internal host: "shop.example/hours".
    const bare = /^([a-z0-9.-]+)(?:[/?#]|$)/i.exec(raw);
    if (!bare?.[1] || !hostIn(bare[1], r.internal)) return null;
    absolute = `https://${raw}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  const href = escapeHtml(parsed.href);
  if (hostIn(parsed.hostname, r.internal)) return `<a href="${href}">${label}</a>`;
  if (r.external !== '*' && !hostIn(parsed.hostname, r.external)) return null;
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/**
 * An anchor for a raw URL and label, or null when the URL is not allowed. Both arguments are
 * escaped here.
 */
export function linkTag(url: string, label: string, options: MarkdownOptions): string | null {
  return anchor(escapeHtml(clean(url)), escapeHtml(clean(label)), resolve(options));
}

// Labels stop at the next bracket and URLs at the next bracket or parenthesis, so a run of
// unclosed brackets is scanned once instead of once per bracket (see the huge-input tests).
const CODE = /`([^`\n]+)`/g;
const LINK = /\[([^[\]\n]+)\]\(([^()[\]\s]+)\)/g;
// A bare URL stops at whitespace, a parenthesis, an escaped quote or angle bracket, or a
// placeholder, so the quotes around "https://site.example" and a code span after it stay outside.
const BARE_URL = /https?:\/\/(?:(?!&(?:quot|#39|lt|gt);)[^\s()\u0000])+/g;
const RESTORE = new RegExp(`${Z}(\\d+)${Z}`, 'g');

/** Inline formatting over text that is already escaped and cleaned. */
function inlineEscaped(s: string, r: Resolved): string {
  const tokens: string[] = [];
  const stash = (html: string) => `${Z}${tokens.push(html) - 1}${Z}`;
  const bare = (m: string) => {
    const trail = /[.,;:!?]+$/.exec(m)?.[0] ?? '';
    const core = m.slice(0, m.length - trail.length);
    const a = anchor(core, core, r);
    return a ? stash(a) + trail : m;
  };

  let t = s
    .replace(CODE, (_m, code: string) => stash(`<code class="${r.prefix}-code">${code}</code>`))
    .replace(LINK, (m, label: string, url: string) => {
      const a = anchor(url, label, r);
      return a ? stash(a) : m;
    })
    .replace(BARE_URL, bare);
  // A captured prefix instead of a lookbehind, which Safari before 16.4 cannot parse.
  if (r.bareHost) t = t.replace(r.bareHost, (_m, pre: string, url: string) => pre + bare(url));
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  // A link label can hold a code placeholder. Tokens only name earlier tokens, so this ends.
  const restore = (x: string): string => x.replace(RESTORE, (m, i: string) => {
    const tok = tokens[Number(i)];
    return tok === undefined ? m : restore(tok);
  });
  return restore(t);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function prepare(src: string, r: Resolved): string {
  const c = clean(src);
  return c.length > r.max ? `${c.slice(0, r.max)}…` : c;
}

/** One line of inline Markdown (code, links, bare URLs, emphasis) as HTML. */
export function renderInline(src: string, options: MarkdownOptions): string {
  const r = resolve(options);
  return inlineEscaped(escapeHtml(prepare(src, r)), r);
}

const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l: string) => /^[\s|:-]+$/.test(l) && l.includes('-') && l.includes('|');
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** A model reply as HTML that is safe to assign to innerHTML. */
export function renderMarkdown(src: string, options: MarkdownOptions): string {
  const r = resolve(options);
  const escaped = escapeHtml(prepare(src, r));
  const inline = (s: string) => inlineEscaped(s, r);

  const blocks: string[] = [];
  // Each block placeholder gets a line of its own, so a fence that opened mid-line splits the
  // paragraph, list item or emphasis around it and the <pre> never lands inside a <p> or <strong>.
  const withoutBlocks = escaped.replace(/```(?:[a-zA-Z0-9]*\n)?([\s\S]*?)```/g, (_m, code: string) => {
    blocks.push(`<pre class="${r.prefix}-pre"><code>${code.replace(/\n+$/, '')}</code></pre>`);
    return `\n${Z}B${blocks.length - 1}${Z}\n`;
  });
  const standaloneBlock = new RegExp(`^${Z}B(\\d+)${Z}$`);

  const lines = withoutBlocks.split('\n');
  const out: string[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flushList = () => {
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = [];
  };
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const block = standaloneBlock.exec(line);
    if (block) {
      flushList();
      flushPara();
      out.push(blocks[Number(block[1])] ?? '');
      continue;
    }
    const next = lines[i + 1];
    if (isRow(line) && next !== undefined && isSep(next)) {
      flushList();
      flushPara();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i] ?? '')) rows.push(cells(lines[i++] ?? ''));
      i--;
      const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
      const trs = rows.map((row) => `<tr>${head.map((_c, ci) => `<td>${inline(row[ci] ?? '')}</td>`).join('')}</tr>`).join('');
      out.push(`<div class="${r.prefix}-tablewrap"><table class="${r.prefix}-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`);
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      flushPara();
      list.push(line.replace(/^\s*-\s+/, ''));
      continue;
    }
    if (line.trim() === '') {
      flushList();
      flushPara();
      continue;
    }
    flushList();
    para.push(line);
  }
  flushList();
  flushPara();
  return out.join('');
}
