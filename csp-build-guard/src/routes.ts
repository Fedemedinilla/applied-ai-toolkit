/**
 * Which response headers a host sends for a page, read from the deploy configuration in the same
 * way for every check: vercel.json `headers`, a Vercel Build Output `config.json`, or a Netlify
 * `_headers` file. Each reader returns every rule whose pattern matches the page, so a caller can
 * tell one matching rule from two.
 */

export interface HeaderRule {
  /** Where the rule came from, for reports: the file and the rule's pattern. */
  readonly origin: string;
  readonly matches: (urlPath: string) => boolean;
  /** Header names lowercased, values as written. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

/**
 * Converts a vercel.json `source` (path-to-regexp syntax) into a RegExp. Supports the subset that
 * shows up in vercel.json files: literal segments, `(regex)` groups, and `:name` parameters with an
 * optional `(regex)` and a `?`, `*` or `+` modifier. Matching is whole-path, case-insensitive, with
 * an optional trailing slash, which are path-to-regexp's defaults. Anything else throws, so a rule
 * the guard cannot read is a configuration error instead of a rule that silently never matches.
 */
export function vercelSourceToRegExp(source: string): RegExp {
  if (!source.startsWith('/')) throw new Error(`vercel.json source must start with "/": ${source}`);
  let out = '';
  let i = 0;
  const readGroup = (): string => {
    // From an opening "(" to its matching ")", copied as a regex group.
    let depth = 0;
    const start = i;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '\\') i++;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) {
        i++;
        return source.slice(start + 1, i - 1);
      }
    }
    throw new Error(`unbalanced parentheses in vercel.json source ${source}`);
  };
  while (i < source.length) {
    const c = source[i] ?? '';
    const prefix = c === '/' && source[i + 1] === ':' ? '/' : '';
    if (prefix) i++;
    if (source[i] === ':') {
      const name = /^:([A-Za-z_]\w*)/.exec(source.slice(i));
      if (!name) throw new Error(`invalid parameter in vercel.json source ${source}`);
      i += name[0].length;
      const pattern = source[i] === '(' ? readGroup() : '[^/]+?';
      const modifier = /[?*+]/.test(source[i] ?? '') ? source[i++] : '';
      const p = prefix ? '\\/' : '';
      if (modifier === '') out += `${p}(?:${pattern})`;
      else if (modifier === '?') out += `(?:${p}(?:${pattern}))?`;
      else if (modifier === '*') out += `(?:${p}(?:${pattern})(?:\\/(?:${pattern}))*)?`;
      else out += `${p}(?:${pattern})(?:\\/(?:${pattern}))*`;
    } else if (c === '(') {
      out += `(?:${readGroup()})`;
    } else if (c === '*' || c === '?' || c === '+' || c === '{' || c === '}') {
      throw new Error(`unsupported "${c}" in vercel.json source ${source}`);
    } else {
      out += c.replace(/[.^$|[\]\\/]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${out}\\/?$`, 'i');
}

interface VercelJson {
  headers?: Array<{ source?: unknown; headers?: Array<{ key?: unknown; value?: unknown }>; has?: unknown; missing?: unknown }>;
}

/** The `headers` rules of a vercel.json file. */
export function vercelJsonRules(json: unknown, file: string): HeaderRule[] {
  const rules = (json as VercelJson | null)?.headers ?? [];
  if (!Array.isArray(rules)) throw new Error(`${file}: "headers" must be an array`);
  return rules.map((rule, index) => {
    if (typeof rule.source !== 'string') throw new Error(`${file}: headers[${index}].source must be a string`);
    if (rule.has !== undefined || rule.missing !== undefined) {
      throw new Error(`${file}: headers[${index}] (${rule.source}) has "has" or "missing" conditions, which this guard does not evaluate`);
    }
    const re = vercelSourceToRegExp(rule.source);
    return {
      origin: `${file} headers[${index}] ${rule.source}`,
      matches: (path) => re.test(path),
      headers: (rule.headers ?? []).map(({ key, value }) => [String(key).toLowerCase(), String(value)] as const),
    };
  });
}

interface BuildOutputConfig {
  routes?: Array<{ src?: unknown; headers?: Record<string, unknown>; handle?: unknown; has?: unknown; missing?: unknown }>;
}

/**
 * The routes with `headers` of a Vercel Build Output `config.json` (version 3). `src` is a regular
 * expression; it is anchored at both ends here when it is not already, and matched
 * case-insensitively, which can only make more rules match.
 */
export function buildOutputRules(json: unknown, file: string): HeaderRule[] {
  const routes = (json as BuildOutputConfig | null)?.routes ?? [];
  if (!Array.isArray(routes)) throw new Error(`${file}: "routes" must be an array`);
  const rules: HeaderRule[] = [];
  routes.forEach((route, index) => {
    if (route.handle !== undefined || route.headers === undefined) return;
    if (typeof route.src !== 'string') throw new Error(`${file}: routes[${index}].src must be a string`);
    if (route.has !== undefined || route.missing !== undefined) {
      throw new Error(`${file}: routes[${index}] (${route.src}) has "has" or "missing" conditions, which this guard does not evaluate`);
    }
    const anchored = `${route.src.startsWith('^') ? '' : '^'}${route.src}${route.src.endsWith('$') ? '' : '$'}`;
    const re = new RegExp(anchored, 'i');
    rules.push({
      origin: `${file} routes[${index}] ${route.src}`,
      matches: (path) => re.test(path),
      headers: Object.entries(route.headers).map(([key, value]) => [key.toLowerCase(), String(value)] as const),
    });
  });
  return rules;
}

/**
 * The rules of a Netlify `_headers` file: a path pattern on its own line, then indented
 * `Name: value` lines. `*` matches any rest of the path and `:placeholder` one segment. Lines
 * starting with `#` are comments.
 */
export function netlifyHeadersRules(text: string, file: string): HeaderRule[] {
  const rules: Array<{ origin: string; matches: (p: string) => boolean; headers: Array<readonly [string, string]> }> = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      const re = new RegExp(
        `^${pattern
          .split(/(\*|:[A-Za-z_]\w*)/)
          .map((part) => (part === '*' ? '.*' : part.startsWith(':') ? '[^/]+' : part.replace(/[.+?^$(){}|[\]\\/]/g, '\\$&')))
          .join('')}$`,
      );
      rules.push({ origin: `${file}:${index + 1} ${pattern}`, matches: (p) => re.test(p), headers: [] });
      return;
    }
    const current = rules.at(-1);
    const header = /^\s+([^:\s]+)\s*:\s*(.*)$/.exec(line);
    if (!current || !header) throw new Error(`${file}:${index + 1}: expected a path line or an indented "Name: value" line`);
    current.headers.push([(header[1] ?? '').toLowerCase(), (header[2] ?? '').trim()]);
  });
  return rules;
}

/** The values of one header from every rule that matches any of the page's URL forms. */
export function headerValues(rules: readonly HeaderRule[], urlPaths: readonly string[], name: string): Array<{ origin: string; value: string }> {
  const found: Array<{ origin: string; value: string }> = [];
  for (const rule of rules) {
    if (!urlPaths.some((p) => rule.matches(p))) continue;
    for (const [key, value] of rule.headers) if (key === name) found.push({ origin: rule.origin, value });
  }
  return found;
}
