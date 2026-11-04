// Parses rendered HTML the way a browser would (jsdom's DOMParser) and lists everything that
// could run script or leave the allowlist. Used by the XSS battery and the property test, which
// both run in the jsdom environment.

const TAGS = new Set(['P', 'BR', 'UL', 'LI', 'STRONG', 'EM', 'CODE', 'PRE', 'A', 'DIV', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']);
const ATTRS: Readonly<Record<string, readonly string[]>> = {
  A: ['href', 'target', 'rel'],
  CODE: ['class'],
  PRE: ['class'],
  DIV: ['class'],
  TABLE: ['class'],
};

export interface Policy {
  readonly internalHosts: readonly string[];
  readonly externalHosts?: readonly string[] | '*';
}

/** Problems found in `html`; an empty list means the output is inert. */
export function problems(html: string, policy: Policy): string[] {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out: string[] = [];
  const hosts = (list: readonly string[]) => list.map((h) => h.toLowerCase());
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    if (!TAGS.has(el.tagName)) out.push(`tag <${el.tagName.toLowerCase()}>`);
    for (const attr of Array.from(el.attributes)) {
      if (!(ATTRS[el.tagName] ?? []).includes(attr.name)) out.push(`attribute ${attr.name} on <${el.tagName.toLowerCase()}>`);
    }
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      // Resolved against an origin that is not on any list, as a page on another site would.
      const url = new URL(href, 'https://page.invalid/dir/');
      if (/^mailto:/i.test(href)) continue;
      if (!['http:', 'https:'].includes(url.protocol)) out.push(`scheme ${url.protocol}`);
      const relative = href.startsWith('/') || href.startsWith('#');
      if (relative && url.host !== 'page.invalid') out.push(`relative href leaves the page: ${href}`);
      if (!relative) {
        const host = url.hostname.replace(/^www\./, '');
        const internal = hosts(policy.internalHosts).includes(host);
        const external = policy.externalHosts ?? '*';
        if (!internal && external !== '*' && !hosts(external).includes(host)) out.push(`host ${host} not allowed`);
        if (!internal && (el.getAttribute('target') !== '_blank' || el.getAttribute('rel') !== 'noopener noreferrer')) {
          out.push(`external link without target and rel: ${href}`);
        }
      }
    }
  }
  if (html.includes('\u0000')) out.push('placeholder left in the output');
  out.push(...nesting(html));
  return out;
}

const INLINE = new Set(['p', 'strong', 'em', 'a', 'code']);
const BLOCK = new Set(['p', 'pre', 'div', 'table', 'ul']);
const VOID = new Set(['br']);

/**
 * Checks the string itself, before a parser repairs it: every tag closes in order and no block
 * element opens inside a paragraph or inline element. Every `<` in the output starts a tag the
 * renderer wrote, because text is escaped.
 */
export function nesting(html: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    const [, close, name = ''] = m;
    if (VOID.has(name)) continue;
    if (close) {
      if (stack.pop() !== name) out.push(`</${name}> closes out of order`);
      continue;
    }
    const parent = stack[stack.length - 1];
    if (parent && INLINE.has(parent) && BLOCK.has(name)) out.push(`<${name}> inside <${parent}>`);
    stack.push(name);
  }
  if (stack.length) out.push(`unclosed ${stack.join(', ')}`);
  return out;
}
