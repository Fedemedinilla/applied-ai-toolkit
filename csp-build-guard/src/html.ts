/**
 * The parts of a built HTML page the checks need, read with a small tokenizer: inline scripts and
 * styles with the text the browser hashes, inline event handlers and style attributes, external
 * scripts, modulepreload links, Astro island URLs and `<meta http-equiv>` policies. It is not a full
 * HTML parser. It handles comments, raw-text elements and quoted attributes, which is what bundlers
 * emit.
 */
import { createHash } from 'node:crypto';

export type InlineKind = 'script-elem' | 'script-attr' | 'style-elem' | 'style-attr';

export interface InlineItem {
  readonly kind: InlineKind;
  /** The text the browser hashes: element content or the attribute value, with CRLF normalized. */
  readonly text: string;
  /** A short label for reports: the element, or the element and attribute name. */
  readonly label: string;
  /** Hash sources for this text, one per algorithm, quoted as they appear in a policy. */
  readonly hashes: { readonly sha256: string; readonly sha384: string; readonly sha512: string };
}

export interface PageParts {
  readonly inline: readonly InlineItem[];
  /**
   * `src` of external scripts a browser with module support loads, in document order. A classic
   * script with `nomodule` is skipped there ("prepare the script element"), so it is listed in
   * `nomoduleSrcs` instead.
   */
  readonly scriptSrcs: readonly string[];
  /** `src` of classic scripts with `nomodule`, the legacy bundles only old browsers load. */
  readonly nomoduleSrcs: readonly string[];
  /** `href` of `<link rel="modulepreload">`. */
  readonly modulePreloads: readonly string[];
  /** `component-url`, `renderer-url` and `before-hydration-url` of `<astro-island>` elements. */
  readonly islandUrls: readonly string[];
  /** Content of each `<meta http-equiv="Content-Security-Policy">` in `<head>`, entities decoded. */
  readonly metaPolicies: readonly string[];
  /**
   * `<meta>` policies the browser ignores: outside `<head>` (CSP3 applies a meta policy only when
   * the element is a child of head), inside `<noscript>` (raw text when scripts run) or inside
   * `<template>` (inert content). They are not in `metaPolicies`.
   */
  readonly ignoredMetaPolicies: ReadonlyArray<{ readonly content: string; readonly where: string }>;
  /** Text of inline scripts that run as JavaScript (classic or module), for import and syntax scans. */
  readonly inlineJs: readonly string[];
  /** `inlineJs` without classic `nomodule` scripts: what a browser with module support runs on load. */
  readonly inlineJsOnLoad: readonly string[];
  /**
   * True when a `<meta>` policy comes after a script, style or stylesheet link. A meta policy only
   * applies to what the parser meets after it, so anything earlier runs unrestricted.
   */
  readonly metaAfterContent: boolean;
}

// The JavaScript MIME type essences of the HTML standard. A <script> with one of these, an empty
// type or no type runs as a classic script.
const JS_MIME_TYPES = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript',
]);

/**
 * How the browser treats a `<script>` by its type: JavaScript, another type that still goes through
 * the inline CSP check (import maps, speculation rules), or a data block (JSON-LD, templates),
 * which CSP does not apply to.
 */
export function scriptKind(type: string | undefined): 'js' | 'module' | 'checked' | 'data' {
  const essence = (type ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (essence === '' || JS_MIME_TYPES.has(essence)) return 'js';
  if (essence === 'module') return 'module';
  if (essence === 'importmap' || essence === 'speculationrules') return 'checked';
  return 'data';
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes the entities that show up in attribute values: named basics and numeric references. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** Attributes of a start tag, names lowercased, values entity-decoded. A repeated name keeps the first, as in HTML. */
export function parseAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  // Skip the tag name, then read name[=value] pairs.
  const body = tag.replace(/^<[^\s/>]+/, '');
  for (const m of body.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = (m[1] ?? '').toLowerCase();
    if (!name || attrs.has(name)) continue;
    attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
}

/** The three hash sources a policy can use for this text. */
export function hashSources(text: string): InlineItem['hashes'] {
  const digest = (algorithm: string) => `'${algorithm}-${createHash(algorithm).update(text, 'utf8').digest('base64')}'`;
  return { sha256: digest('sha256'), sha384: digest('sha384'), sha512: digest('sha512') };
}

// Elements the parser keeps in <head>. Any other start tag (and <body>) begins the body.
const HEAD_ELEMENTS = new Set(['base', 'basefont', 'bgsound', 'link', 'meta', 'noframes', 'noscript', 'script', 'style', 'template', 'title']);

// One pass over the document, in order: comments, raw-text and text-only elements with their
// content, other start tags, end tags. The parser reads the content of <title>, <textarea>, <xmp>,
// <iframe>, <noembed>, <noframes> and <plaintext> as text, so a <meta> or <script> written inside
// one is not an element and must not be counted (only script and style content is used).
// The raw-text tag name must end at whitespace, "/" or ">", so a custom element such as
// <style-switcher> or <script-loader> is an ordinary tag (a \b would match before the "-").
const TOKENS = /<!--[\s\S]*?(?:-->|$)|<(script|style|title|textarea|xmp|iframe|noembed|noframes|plaintext)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(?:<\/\1\s*>|$)|<([a-zA-Z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>|<\/([a-zA-Z][\w:-]*)[^>]*>/gi;

export function parsePage(html: string): PageParts {
  const inline: InlineItem[] = [];
  const scriptSrcs: string[] = [];
  const nomoduleSrcs: string[] = [];
  const inlineJsOnLoad: string[] = [];
  const modulePreloads: string[] = [];
  const islandUrls: string[] = [];
  const metaPolicies: string[] = [];
  const ignoredMetaPolicies: Array<{ content: string; where: string }> = [];
  const inlineJs: string[] = [];
  // Where the tree builder is, reduced to what decides whether a <meta> lands in <head>: before or
  // in head, after </head> (a head element there still goes into head), or in the body. Text is not
  // tracked, so non-whitespace text before the first body tag does not end the head here.
  let where: 'head' | 'after-head' | 'body' = 'head';
  let noscript = 0;
  let template = 0;
  let contentSeen = false;
  let metaAfterContent = false;
  const add = (kind: InlineKind, text: string, label: string) => inline.push({ kind, text, label, hashes: hashSources(text) });

  // The HTML parser turns CRLF and lone CR into LF before tokenizing, so element content and
  // attribute values alike are hashed with LF. A CR written as &#13; is decoded later and stays.
  for (const m of html.replace(/\r\n?/g, '\n').matchAll(TOKENS)) {
    const whole = m[0];
    if (whole.startsWith('<!--')) continue;
    const endTag = m[5]?.toLowerCase();
    if (endTag !== undefined) {
      if (endTag === 'template') template = Math.max(0, template - 1);
      else if (endTag === 'noscript') noscript = Math.max(0, noscript - 1);
      else if (endTag === 'head' && where === 'head' && template === 0) where = 'after-head';
      continue;
    }
    const rawElement = m[1]?.toLowerCase();
    const tagName = rawElement ?? m[4]?.toLowerCase() ?? '';
    // Inside a template nothing joins the document, so the head does not end there.
    const metaPlace = template ? 'inside <template>' : noscript ? 'inside <noscript>' : where === 'body' ? 'outside <head>' : undefined;
    if (template === 0 && tagName !== 'html' && tagName !== 'head' && !HEAD_ELEMENTS.has(tagName)) where = 'body';
    if (tagName === 'template') template++;
    else if (tagName === 'noscript') noscript++;
    const attrs = parseAttributes(rawElement === undefined ? whole : `<${rawElement}${m[2] ?? ''}>`);

    for (const [name, value] of attrs) {
      if (/^on[a-z]+$/.test(name)) add('script-attr', value, `<${tagName} ${name}>`);
    }
    if (attrs.has('style')) add('style-attr', attrs.get('style') ?? '', `<${tagName} style>`);
    // <plaintext> has no end tag: everything after it is text.
    if (rawElement === 'plaintext') break;
    const isStylesheet = tagName === 'link' && (attrs.get('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet');
    if (rawElement === 'style' || isStylesheet || (rawElement === 'script' && scriptKind(attrs.get('type')) !== 'data')) contentSeen = true;
    if (rawElement === 'script') {
      const src = attrs.get('src');
      const kind = scriptKind(attrs.get('type'));
      // nomodule only applies to classic scripts; a module script with it still runs.
      const legacy = kind === 'js' && attrs.has('nomodule');
      if (src !== undefined) {
        if (legacy) nomoduleSrcs.push(src);
        else if (kind === 'js' || kind === 'module') scriptSrcs.push(src);
        continue;
      }
      if (kind === 'data') continue;
      const text = m[3] ?? '';
      // "Prepare the script element" stops before any CSP check when there is no src and the text
      // is empty, so an empty <script></script> needs no hash. Whitespace-only text is still checked.
      if (text === '') continue;
      add('script-elem', text, `<script${kind === 'module' ? ' type="module"' : kind === 'checked' ? ` type="${attrs.get('type')}"` : ''}>`);
      if (kind !== 'checked') {
        inlineJs.push(text);
        if (!legacy) inlineJsOnLoad.push(text);
      }
    } else if (rawElement === 'style') {
      add('style-elem', m[3] ?? '', '<style>');
    } else if (tagName === 'link') {
      const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
      const href = attrs.get('href');
      if (rel.includes('modulepreload') && href) modulePreloads.push(href);
    } else if (tagName === 'astro-island') {
      for (const name of ['component-url', 'renderer-url', 'before-hydration-url']) {
        const url = attrs.get(name);
        if (url) islandUrls.push(url);
      }
    } else if (tagName === 'meta' && (attrs.get('http-equiv') ?? '').toLowerCase() === 'content-security-policy') {
      const content = attrs.get('content') ?? '';
      if (metaPlace !== undefined) ignoredMetaPolicies.push({ content, where: metaPlace });
      else {
        metaPolicies.push(content);
        if (contentSeen) metaAfterContent = true;
      }
    }
  }
  return { inline, scriptSrcs, nomoduleSrcs, modulePreloads, islandUrls, metaPolicies, ignoredMetaPolicies, inlineJs, inlineJsOnLoad, metaAfterContent };
}
