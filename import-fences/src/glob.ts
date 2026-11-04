/**
 * A small glob matcher for repository paths with forward slashes, relative to the root.
 * `**` spans directories (`a/**` matches everything under a, `**\/x.ts` matches x.ts at any depth),
 * `*` and `?` stay inside one segment, `{a,b}` is an alternation. No character classes, no negation:
 * a group says what it excludes with its own `exclude` list.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? '';
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          // "**/" is zero or more whole directories.
          i++;
          out += '(?:[^/]+/)*';
        } else if (out.endsWith('/') && i === glob.length - 1) {
          // A trailing "/**" also matches the directory itself, written without the slash.
          out = `${out.slice(0, -1)}(?:/.*)?`;
        } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      depth++;
      out += '(?:';
    } else if (c === '}' && depth > 0) {
      depth--;
      out += ')';
    } else if (c === ',' && depth > 0) out += '|';
    else out += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  if (depth !== 0) throw new Error(`unbalanced braces in glob ${JSON.stringify(glob)}`);
  return new RegExp(`^${out}$`);
}

/** Compiles a list of globs once into one predicate. An empty list matches nothing. */
export function globMatcher(globs: readonly string[]): (path: string) => boolean {
  const compiled = globs.map(globToRegExp);
  return (path) => compiled.some((re) => re.test(path));
}
