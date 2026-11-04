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
  /** The text the browser hashes: element content with CRLF normalized, or the attribute value. */
  readonly text: string;
  /** A short label for reports: the element, or the element and attribute name. */
  readonly label: string;
  /** Hash sources for this text, one per algorithm, quoted as they appear in a policy. */
  readonly hashes: { readonly sha256: string; readonly sha384: string; readonly sha512: string };
}

export interface PageParts {
  readonly inline: readonly InlineItem[];
  /** `src` of external scripts, in document order. */
  readonly scriptSrcs: readonly string[];
  /** `href` of `<link rel="modulepreload">`. */
  readonly modulePreloads: readonly string[];
  /** `component-url`, `renderer-url` and `before-hydration-url` of `<astro-island>` elements. */
  readonly islandUrls: readonly string[];
  /** Content of each `<meta http-equiv="Content-Security-Policy">`, entities decoded. */
  readonly metaPolicies: readonly string[];
  /** Text of inline scripts that run as JavaScript (classic or module), for import and syntax scans. */
  readonly inlineJs: readonly string[];
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

// One pass over the document, in order: comments, raw-text elements with their content, other start tags.
const TOKENS = /<!--[\s\S]*?(?:-->|$)|<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(?:<\/\1\s*>|$)|<([a-zA-Z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

export function parsePage(html: string): PageParts {
  const inline: InlineItem[] = [];
  const scriptSrcs: string[] = [];
  const modulePreloads: string[] = [];
  const islandUrls: string[] = [];
  const metaPolicies: string[] = [];
  const inlineJs: string[] = [];
  let contentSeen = false;
  let metaAfterContent = false;
  const add = (kind: InlineKind, text: string, label: string) => inline.push({ kind, text, label, hashes: hashSources(text) });

  for (const m of html.matchAll(TOKENS)) {
    const whole = m[0];
    if (whole.startsWith('<!--')) continue;
    const rawElement = m[1]?.toLowerCase();
    const tagName = rawElement ?? m[4]?.toLowerCase() ?? '';
    const attrs = parseAttributes(rawElement === undefined ? whole : `<${rawElement}${m[2] ?? ''}>`);

    for (const [name, value] of attrs) {
      if (/^on[a-z]+$/.test(name)) add('script-attr', value, `<${tagName} ${name}>`);
    }
    if (attrs.has('style')) add('style-attr', attrs.get('style') ?? '', `<${tagName} style>`);
    const isStylesheet = tagName === 'link' && (attrs.get('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet');
    if (rawElement === 'style' || isStylesheet || (rawElement === 'script' && scriptKind(attrs.get('type')) !== 'data')) contentSeen = true;
    if (rawElement === 'script') {
      const src = attrs.get('src');
      const kind = scriptKind(attrs.get('type'));
      if (src !== undefined) {
        if (kind === 'js' || kind === 'module') scriptSrcs.push(src);
        continue;
      }
      if (kind === 'data') continue;
      // The HTML parser turns CRLF and lone CR into LF before the browser hashes the text.
      const text = (m[3] ?? '').replace(/\r\n?/g, '\n');
      // "Prepare the script element" stops before any CSP check when there is no src and the text
      // is empty, so an empty <script></script> needs no hash. Whitespace-only text is still checked.
      if (text === '') continue;
      add('script-elem', text, `<script${kind === 'module' ? ' type="module"' : kind === 'checked' ? ` type="${attrs.get('type')}"` : ''}>`);
      if (kind !== 'checked') inlineJs.push(text);
    } else if (rawElement === 'style') {
      add('style-elem', (m[3] ?? '').replace(/\r\n?/g, '\n'), '<style>');
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
      metaPolicies.push(attrs.get('content') ?? '');
      if (contentSeen) metaAfterContent = true;
    }
  }
  return { inline, scriptSrcs, modulePreloads, islandUrls, metaPolicies, inlineJs, metaAfterContent };
}
