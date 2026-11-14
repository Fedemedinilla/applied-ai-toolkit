// The globs of the config file's `ignore` and `overrides[].files`. A pattern is matched against
// the whole path of a file relative to the folder of the config file, with forward slashes.
//
//   *    any run of characters inside one path segment, the empty run included
//   ?    one character that is not a slash
//   **   any run of characters, slashes included; a leading or inner ** followed by a slash
//        also matches no folder at all, so docs/**/a.md matches docs/a.md
//
// Nothing else is special: no braces, no character classes, no negation. A pattern without a
// slash matches at the top folder only ("README.md" is not "docs/README.md"); **/README.md
// matches it in every folder.

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? '';
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/' && (i === 0 || glob[i - 1] === '/')) {
        re += '(?:[^/]+/)*';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[\\^$.*+?()[\]{}|/-]/u, '\\$&');
  }
  return new RegExp(`^${re}$`, 'u');
}

/** Why a glob cannot be used, or undefined when it can. */
export function globProblem(glob: string): string | undefined {
  if (glob === '') return 'must not be empty';
  if (glob.includes('\\')) return 'uses a backslash; write paths with forward slashes';
  if (glob.startsWith('/')) return 'is absolute; a pattern is relative to the folder of the config file';
  if (glob.split('/').includes('..')) return 'has a .. segment; a pattern cannot leave the folder of the config file';
  if (glob.startsWith('!')) return 'starts with !; negation is not supported';
  return undefined;
}

const cache = new Map<string, RegExp>();

/** True when `path` (relative, forward slashes) matches any of the globs. */
export function matchesAny(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => {
    let re = cache.get(glob);
    if (!re) {
      re = globToRegExp(glob);
      cache.set(glob, re);
    }
    return re.test(path);
  });
}
