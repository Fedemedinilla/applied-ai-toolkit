/**
 * A small glob matcher for paths relative to the build root, with forward slashes: `**` spans
 * directories, `*` and `?` stay inside one segment, `{a,b}` is an alternation. No character classes
 * and no negation. Dotfiles match like any other name.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? '';
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        // "**/" matches zero or more whole directories; a trailing "**" matches the rest.
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:[^/]*/)*';
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

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
