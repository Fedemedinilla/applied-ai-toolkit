/**
 * The checks that keep real people's data out of the fixtures: every address under a reserved
 * domain, every phone number zero-filled, no web host outside the reserved names, and none of the
 * repository owner's identifiers. Kept apart from its test so the test can try it on bad input.
 */

export interface Finding {
  readonly file: string;
  readonly kind: 'email' | 'phone' | 'host' | 'owner' | 'marker';
  readonly match: string;
}

/** Reserved for documentation and tests: RFC 2606 names and the example.* second-level domains. */
const reservedHost = (host: string): boolean => /\.(example|test)$/i.test(host) || /^example\.(com|net|org)$/i.test(host);

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const URL_HOST = /\bhttps?:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)/g;
/**
 * A host written without a scheme, as CVs write LinkedIn and GitHub handles. Only common top-level
 * domains count, so a file name (cv.md) or a tool (Node.js) is not a host. Not after @, a dot or a
 * slash, so the domain of an address or a URL is not reported twice.
 */
const BARE_HOST = /(?<![@\w./-])(?:[a-z0-9-]+\.)+(?:com|net|org|dev|io|me|app|ai|co|ar|uk|es|info|xyz|site|tech|blog|page)\b(?!@)/gi;
/** A run of digits, with or without separators, long enough to be a phone number and not a year range. */
const PHONE = /\+?\d[\d ().-]{7,}\d/g;
/** The owner's surname and handles. Assembled from parts so this list is not itself a match. */
const OWNER = new RegExp(['medi' + 'nilla', 'fg' + 'med'].join('|'), 'i');

export interface CheckOptions {
  /** Real hosts are allowed, as in a sources list that links to the works it cites. */
  readonly realHosts?: boolean;
  /** The file must open with the comment that marks it as fiction. */
  readonly needsMarker?: boolean;
}

export function checkFictional(file: string, text: string, options: CheckOptions = {}): Finding[] {
  const found: Finding[] = [];
  for (const m of text.matchAll(EMAIL)) if (!reservedHost(m[1] ?? '')) found.push({ file, kind: 'email', match: m[0] });
  if (options.realHosts !== true) {
    for (const m of text.matchAll(URL_HOST)) if (!reservedHost(m[1] ?? '')) found.push({ file, kind: 'host', match: m[0] });
    for (const m of text.matchAll(BARE_HOST)) if (!reservedHost(m[0])) found.push({ file, kind: 'host', match: m[0] });
  }
  for (const m of text.matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 9 && !/0{8}$/.test(digits)) found.push({ file, kind: 'phone', match: m[0] });
  }
  const owner = OWNER.exec(text);
  if (owner !== null) found.push({ file, kind: 'owner', match: owner[0] });
  if (options.needsMarker === true && !text.startsWith('<!-- Fictional')) found.push({ file, kind: 'marker', match: text.slice(0, 40) });
  return found;
}
