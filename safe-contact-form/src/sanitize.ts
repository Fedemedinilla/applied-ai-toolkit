/**
 * Text helpers for the two emails. The notice to the site owner carries the message whole; the
 * acknowledgment goes to an address the visitor typed, so what it quotes is cut and has every
 * link removed (see quote()).
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** A subject or a name is one line: a newline inside would split a header or leave text hanging. */
export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Paragraphs and line breaks of a plain-text message, kept in the HTML part. */
export function paragraphs(s: string): string {
  return s
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * A whole HTML document, not a fragment. An HTML part with no <html> tag is a standard spam
 * signal (SpamAssassin's HTML_MIME_NO_HTML_TAG).
 */
export function htmlDocument(body: string, lang: string, title: string): string {
  return (
    `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(title)}</title></head>` +
    '<body style="margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a">' +
    `${body}</body></html>`
  );
}

/**
 * A bare domain with any TLD: labels of letters, digits, `_` or `-` joined by dots, ending in a TLD
 * of two or more letters in any script or a punycode one, plus whatever follows up to whitespace.
 * The edges are lookarounds because `\b` only knows ASCII letters and would miss `пример.рф`. No
 * dot in the lookbehind, so a domain right after an ellipsis still starts a match. The cost is a
 * few false positives in the quote ("gracias.Saludos", "EE.UU."), which is the cheaper mistake.
 */
const DOMAIN = /(?<![\p{L}\p{N}_-])[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.(?:\p{L}{2,}|xn--[a-z0-9-]+)(?![\p{L}\p{N}_-])\S*/giu;

/** Removes Markdown links, URLs, `www.` hosts and bare domains, writing `placeholder` instead. */
export function stripLinks(s: string, placeholder: string): string {
  return s
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, placeholder)
    .replace(/\bwww\.\S+/gi, placeholder)
    .replace(DOMAIN, placeholder);
}

/**
 * The quote of the message in the acknowledgment: no links, at most `max` characters. Filtered
 * again after the cut, because a cut can turn text the pattern skipped ("x.example-y" with the
 * "-y" past the limit) into a clean, clickable domain.
 */
export function quote(message: string, max: number, placeholder: string): string {
  const clean = stripLinks(message, placeholder).trim();
  const cut = clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
  return stripLinks(cut, placeholder);
}

/**
 * The name, as a greeting and nothing more: one line, short, filtered after the cut. Links are
 * removed with no placeholder ("Hi [link]," reads as a template bug), so a name that was only a
 * link comes back as `fallback`.
 */
export function greeting(name: string, max: number, fallback: string): string {
  const n = oneLine(stripLinks(oneLine(stripLinks(name, '')).slice(0, max), ''));
  return n || fallback;
}
