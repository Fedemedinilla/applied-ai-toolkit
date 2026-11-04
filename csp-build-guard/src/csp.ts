/**
 * A Content-Security-Policy parser that reads a header the way the browser does, and an exact
 * comparison against an expected policy. Follows CSP3 ("parse a serialized CSP list" and "parse a
 * serialized CSP") and Chromium where the two differ.
 */

/** One policy of a header, as the browser reads it. */
export interface Policy {
  /** Each directive by its lowercase name, with its sources as written. */
  readonly directives: ReadonlyMap<string, readonly string[]>;
  /**
   * Directives that appear more than once. The browser uses the first and ignores the rest, so a
   * second one that looks stricter misleads whoever reads the header. `directives` keeps the first,
   * unless the first was dropped (see `dropped`).
   */
  readonly repeated: readonly string[];
  /**
   * Directives with a character outside ASCII (a U+00A0 between two sources, a curly quote). The
   * browser drops them whole, so they are not in `directives`. As in Chromium, a dropped directive
   * still counts as the first of its name, so a later one with the same name is not used either.
   * CSP3 skips them before looking at the name, so there the later one would apply; both cases are
   * failures for the comparison.
   */
  readonly dropped: readonly string[];
}

// Separators are ASCII whitespace, as in the browser. A non-ASCII space (U+00A0, no-break) does not
// separate anything: it takes the whole directive out of the policy.
const ASCII_WHITESPACE = /[\t\n\f\r ]+/;
const NON_ASCII = /[^\u0000-\u007f]/;

/**
 * Reads a Content-Security-Policy header value: one policy per comma-separated part (which is how
 * `Headers.get` joins two headers), each read with parseSerializedCsp. An empty value holds no
 * policy.
 */
export function parseCsp(header: string): Policy[] {
  return header.split(',').flatMap((serialized) => parseSerializedCsp(serialized) ?? []);
}

/**
 * Reads one serialized policy, as CSP3 does for a `<meta>` content (where a comma is not a
 * separator): directives separated by ';', skipping empty ones and ones with non-ASCII characters.
 * With Chromium 141, a "script-src 'none'" with a U+00A0 and another source after it lets an inline
 * script run, and the console warns about invalid characters. Undefined when it holds nothing.
 */
export function parseSerializedCsp(serialized: string): Policy | undefined {
  const directives = new Map<string, string[]>();
  const repeated = new Set<string>();
  const dropped = new Set<string>();
  for (const part of serialized.split(';')) {
    const [name, ...sources] = part.split(ASCII_WHITESPACE).filter(Boolean);
    if (name === undefined) continue;
    const key = name.toLowerCase();
    if (directives.has(key) || dropped.has(key)) repeated.add(key);
    else if (NON_ASCII.test(part)) dropped.add(key);
    else directives.set(key, sources);
  }
  // A policy with only dropped directives is empty to the browser, but it is returned so the
  // comparison can say why it holds nothing.
  return directives.size || dropped.size ? { directives, repeated: [...repeated], dropped: [...dropped] } : undefined;
}

/** What one directive of the expected policy must hold. */
export interface ExpectedDirective {
  /** Its sources: all of them, and no others. */
  readonly sources: readonly string[];
  /**
   * Whether it may also hold hashes ('sha256-...', 'sha384-...', 'sha512-...'), which change with
   * the inline content of the build. Only hashes, no other source.
   */
  readonly hashes?: boolean;
}

/** The whole expected policy, by lowercase directive name. A directive not listed is a failure. */
export type ExpectedPolicy = Readonly<Record<string, ExpectedDirective>>;

/**
 * A hash source: the algorithm and a base64 or base64url digest, quoted. The algorithm is matched
 * case-insensitively, as the browser does.
 */
export const HASH_SOURCE = /^'(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})'$/i;

/**
 * A hash source in the form html.ts produces (lowercase algorithm, base64 digest), so two spellings
 * the browser treats alike compare equal. CSP3 turns '-' into '+' and '_' into '/' before comparing.
 * Undefined for a source that is not a hash.
 */
export function normalizeHash(source: string): string | undefined {
  const m = HASH_SOURCE.exec(source);
  if (m === null) return undefined;
  return `'${(m[1] ?? '').toLowerCase()}-${(m[2] ?? '').replace(/-/g, '+').replace(/_/g, '/')}'`;
}

/**
 * Every difference between a header and the expected policy, one line each (empty when they match).
 * Compares sets of sources, not text: order and whitespace do not count, and an extra source
 * (https:, *, a host, 'unsafe-inline'), a repeated directive or an unlisted one is a failure even
 * when the header holds everything expected. Sources compare case-sensitively, so another spelling
 * of the same source ('NONE') is reported, on the safe side.
 */
export function diffPolicy(header: string, expected: ExpectedPolicy): string[] {
  const [policy, ...others] = parseCsp(header);
  if (policy === undefined) return ['the policy is empty'];
  if (others.length) return [`the header holds ${others.length + 1} comma-separated policies, and one is expected`];
  return diffParsedPolicy(policy, expected);
}

/** diffPolicy for a policy already parsed, such as the content of one `<meta>`. */
export function diffParsedPolicy(policy: Policy | undefined, expected: ExpectedPolicy): string[] {
  if (policy === undefined) return ['the policy is empty'];

  const diffs = [
    ...policy.repeated.map((name) => `${name} is repeated: the browser uses the first and ignores the rest`),
    ...policy.dropped.map((name) => `${name} has non-ASCII characters: the browser drops it`),
  ];
  for (const [name, { sources, hashes = false }] of Object.entries(expected)) {
    const actual = policy.directives.get(name);
    if (actual === undefined) {
      diffs.push(`missing ${name}`);
      continue;
    }
    for (const source of sources) if (!actual.includes(source)) diffs.push(`${name}: missing ${source}`);
    for (const source of new Set(actual)) {
      if (!sources.includes(source) && !(hashes && HASH_SOURCE.test(source))) diffs.push(`${name}: unexpected ${source}`);
    }
  }
  for (const [name, sources] of policy.directives) {
    if (!Object.hasOwn(expected, name)) diffs.push(`unexpected directive ${[name, ...sources].join(' ')}`);
  }
  return diffs;
}

/**
 * The directive that governs a kind of element in a policy, following CSP3's fallback lists:
 * script-src-elem, then script-src, then default-src for `<script>` elements; the same with style.
 * Inline event handlers and style attributes use the -attr variants first. Undefined when the
 * policy has none of them, which means the browser does not restrict that kind at all.
 */
export function effectiveDirective(
  policy: Policy,
  kind: 'script-elem' | 'script-attr' | 'style-elem' | 'style-attr',
): { name: string; sources: readonly string[] } | undefined {
  const [type, where] = kind.split('-') as ['script' | 'style', 'elem' | 'attr'];
  for (const name of [`${type}-src-${where}`, `${type}-src`, 'default-src']) {
    const sources = policy.directives.get(name);
    if (sources !== undefined) return { name, sources };
  }
  return undefined;
}

/** Directives a policy delivered in a `<meta>` element does not support (CSP3, "The meta element"). */
export const IGNORED_IN_META = ['frame-ancestors', 'report-uri', 'sandbox'] as const;
