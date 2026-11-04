import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { diffPolicy, effectiveDirective, type ExpectedPolicy, parseCsp } from '../src/csp.ts';

const SCRIPT_HASH = "'sha256-xIb/Pa7FUshAu4ihwjchYcQpyCI8eS8kt40GpOAYCz8='";
const STYLE_HASH = "'sha256-Awved+6tIA52DOzgnZnu9cMhqs/4qeX4K8G6yqdoLqk='";

/** A header shaped like the ones Astro builds: config directives joined with ';', then script-src and style-src. */
const HEADER =
  "default-src 'self';connect-src 'self' https://api.example.test wss://api.example.test;frame-ancestors 'none';" +
  `base-uri 'self';object-src 'none'; script-src 'self' ${SCRIPT_HASH}; style-src 'self' ${STYLE_HASH};`;

const EXPECTED: ExpectedPolicy = {
  'default-src': { sources: ["'self'"] },
  'connect-src': { sources: ["'self'", 'https://api.example.test', 'wss://api.example.test'] },
  'frame-ancestors': { sources: ["'none'"] },
  'base-uri': { sources: ["'self'"] },
  'object-src': { sources: ["'none'"] },
  'script-src': { sources: ["'self'"], hashes: true },
  'style-src': { sources: ["'self'"], hashes: true },
};

/** The header with one fragment replaced; fails if the fragment is not there. */
const withChange = (before: string, after: string) => {
  expect(HEADER).toContain(before);
  return HEADER.replace(before, after);
};

describe('parseCsp', () => {
  it('reads each directive with its sources, with or without a space after ;', () => {
    const [policy, ...others] = parseCsp(HEADER);
    expect(others).toEqual([]);
    expect(policy?.repeated).toEqual([]);
    expect(policy?.dropped).toEqual([]);
    expect(Object.fromEntries(policy?.directives ?? [])).toEqual({
      'default-src': ["'self'"],
      'connect-src': ["'self'", 'https://api.example.test', 'wss://api.example.test'],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'self'"],
      'object-src': ["'none'"],
      'script-src': ["'self'", SCRIPT_HASH],
      'style-src': ["'self'", STYLE_HASH],
    });
  });

  it('skips extra ASCII whitespace and empty directives', () => {
    const [policy] = parseCsp(" \t;;  default-src\t 'self'  \r\n;\f; script-src 'self' ;  ");
    expect(Object.fromEntries(policy?.directives ?? [])).toEqual({ 'default-src': ["'self'"], 'script-src': ["'self'"] });
  });

  it('drops a directive with a non-ASCII character whole, as the browser does, and records it', () => {
    const [policy] = parseCsp("script-src 'self' https:; object-src 'none'");
    expect(policy?.directives.has('script-src')).toBe(false);
    expect(policy?.directives.get('object-src')).toEqual(["'none'"]);
    expect(policy?.dropped).toEqual(['script-src']);
    expect(policy?.repeated).toEqual([]);
  });

  it('counts a dropped directive as the first of its name, as Chromium does', () => {
    const [policy] = parseCsp("script-src 'none' x; script-src 'none'");
    expect(policy?.directives.has('script-src')).toBe(false);
    expect(policy?.dropped).toEqual(['script-src']);
    expect(policy?.repeated).toEqual(['script-src']);
  });

  it('returns a policy made only of dropped directives, so the comparison can say why it is empty', () => {
    expect(parseCsp("default-src 'self'")).toEqual([{ directives: new Map(), repeated: [], dropped: ["default-src 'self'"] }]);
  });

  it('lowercases directive names and keeps sources as written', () => {
    const [policy] = parseCsp(`Script-SRC 'SELF' ${SCRIPT_HASH}`);
    expect([...(policy?.directives ?? [])]).toEqual([['script-src', ["'SELF'", SCRIPT_HASH]]]);
  });

  it('keeps the first of a repeated directive, the one the browser uses, and records it once', () => {
    const [policy] = parseCsp("script-src 'self' https:; SCRIPT-SRC 'self'; script-src 'none'; object-src 'none'");
    expect(policy?.directives.get('script-src')).toEqual(["'self'", 'https:']);
    expect(policy?.repeated).toEqual(['script-src']);
  });

  it('gives a directive without sources an empty list', () => {
    expect(parseCsp('upgrade-insecure-requests')[0]?.directives.get('upgrade-insecure-requests')).toEqual([]);
  });

  it('finds no policy in an empty value or one made of separators', () => {
    for (const header of ['', '   ', ';', ' ; ;\t', ',', ' , ; ']) expect(parseCsp(header), JSON.stringify(header)).toEqual([]);
  });

  it('reads two headers joined by Headers.get as two policies', () => {
    const headers = new Headers();
    headers.append('content-security-policy', "default-src 'self'");
    headers.append('content-security-policy', "script-src 'none'");
    const policies = parseCsp(headers.get('content-security-policy') ?? '');
    expect(policies.map(({ directives }) => [...directives.keys()])).toEqual([['default-src'], ['script-src']]);
  });
});

describe('diffPolicy', () => {
  it('finds no difference in a matching header', () => {
    expect(diffPolicy(HEADER, EXPECTED)).toEqual([]);
  });

  it('ignores order, whitespace and the case of directive names', () => {
    const shuffled = `  STYLE-SRC ${STYLE_HASH}   'self'; script-src ${SCRIPT_HASH} 'self';object-src 'none'; base-uri 'self';
      frame-ancestors 'none'; connect-src wss://api.example.test 'self' https://api.example.test; Default-Src 'self'`;
    expect(diffPolicy(shuffled, EXPECTED)).toEqual([]);
  });

  it('accepts any number of hashes, of any CSP algorithm, where hashes are allowed', () => {
    const more = ['sha384', 'sha512'].map((a) => `'${a}-${createHash(a).update('<script>').digest('base64')}'`);
    expect(diffPolicy(withChange(SCRIPT_HASH, [SCRIPT_HASH, ...more].join(' ')), EXPECTED)).toEqual([]);
    expect(diffPolicy(withChange(` ${STYLE_HASH}`, ''), EXPECTED)).toEqual([]);
  });

  it.each(['https:', '*', 'https://cdn.example.test', 'http:', 'data:'])('reports an extra source in connect-src: %s', (source) => {
    const header = withChange('wss://api.example.test;', `wss://api.example.test ${source};`);
    expect(diffPolicy(header, EXPECTED)).toEqual([`connect-src: unexpected ${source}`]);
  });

  // An algorithm CSP does not know is not a hash, and an unquoted one is read as a host.
  const notHashes = ["'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'", "'nonce-abc123'", 'https:', "'sha1-xIb/Pa7FUshAu4ihwjc='", SCRIPT_HASH.slice(1, -1)];
  it.each(notHashes)("allows only hashes besides 'self' in script-src and style-src: %s fails", (source) => {
    expect(diffPolicy(withChange("script-src 'self'", `script-src 'self' ${source}`), EXPECTED)).toEqual([`script-src: unexpected ${source}`]);
    expect(diffPolicy(withChange("style-src 'self'", `style-src 'self' ${source}`), EXPECTED)).toEqual([`style-src: unexpected ${source}`]);
  });

  it('reports a hash in a directive that does not allow hashes', () => {
    expect(diffPolicy(withChange("default-src 'self'", `default-src 'self' ${SCRIPT_HASH}`), EXPECTED)).toEqual([`default-src: unexpected ${SCRIPT_HASH}`]);
  });

  it('reports a missing or changed source, and compares sources case-sensitively', () => {
    expect(diffPolicy(withChange(' wss://api.example.test', ''), EXPECTED)).toEqual(['connect-src: missing wss://api.example.test']);
    expect(diffPolicy(withChange("frame-ancestors 'none'", "frame-ancestors 'self'"), EXPECTED)).toEqual([
      "frame-ancestors: missing 'none'",
      "frame-ancestors: unexpected 'self'",
    ]);
    expect(diffPolicy(withChange("object-src 'none'", "object-src 'NONE'"), EXPECTED)).toEqual(["object-src: missing 'none'", "object-src: unexpected 'NONE'"]);
  });

  it('reports a missing directive', () => {
    expect(diffPolicy(withChange("frame-ancestors 'none';", ''), EXPECTED)).toEqual(['missing frame-ancestors']);
  });

  it('reports an unlisted directive even when everything expected is there', () => {
    for (const [directive, diff] of [
      ['form-action https:', 'unexpected directive form-action https:'],
      [`script-src-elem 'self' https: ${SCRIPT_HASH}`, `unexpected directive script-src-elem 'self' https: ${SCRIPT_HASH}`],
      ['upgrade-insecure-requests', 'unexpected directive upgrade-insecure-requests'],
      // A name that exists on Object.prototype is not an expected directive.
      ['constructor x', 'unexpected directive constructor x'],
    ] as const) {
      expect(diffPolicy(`${HEADER} ${directive};`, EXPECTED), directive).toEqual([diff]);
    }
  });

  it('reports a directive with non-ASCII characters, which the browser then lacks', () => {
    expect(diffPolicy(withChange("script-src 'self'", "script-src 'self' https:"), EXPECTED)).toEqual([
      'script-src has non-ASCII characters: the browser drops it',
      'missing script-src',
    ]);
  });

  it('reports a repeated directive even when the second one is stricter', () => {
    expect(diffPolicy(withChange("script-src 'self'", "script-src 'self' https:; script-src 'self'"), EXPECTED)).toEqual([
      'script-src is repeated: the browser uses the first and ignores the rest',
      'script-src: unexpected https:',
    ]);
  });

  it('does not count a repeated source twice', () => {
    expect(diffPolicy(withChange("base-uri 'self'", "base-uri 'self' 'self'"), EXPECTED)).toEqual([]);
    expect(diffPolicy(withChange("base-uri 'self'", "base-uri 'self' * *"), EXPECTED)).toEqual(['base-uri: unexpected *']);
  });

  it('reports an empty policy and two comma-separated policies', () => {
    expect(diffPolicy(' ; ', EXPECTED)).toEqual(['the policy is empty']);
    expect(diffPolicy(`${HEADER}, default-src 'none'`, EXPECTED)).toEqual(['the header holds 2 comma-separated policies, and one is expected']);
  });
});

describe('effectiveDirective', () => {
  const policy = (header: string) => {
    const [p] = parseCsp(header);
    if (p === undefined) throw new Error('no policy');
    return p;
  };

  it('follows the CSP3 fallback lists for elements and attributes', () => {
    const p = policy("default-src 'self'; script-src 'none'; script-src-attr 'unsafe-hashes'; style-src-elem 'self'");
    expect(effectiveDirective(p, 'script-elem')?.name).toBe('script-src');
    expect(effectiveDirective(p, 'script-attr')?.name).toBe('script-src-attr');
    expect(effectiveDirective(p, 'style-elem')?.name).toBe('style-src-elem');
    expect(effectiveDirective(p, 'style-attr')?.name).toBe('default-src');
  });

  it('returns undefined when nothing restricts that kind of content', () => {
    expect(effectiveDirective(policy("img-src 'self'"), 'script-elem')).toBeUndefined();
  });
});
