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
    // Only the syntax characters are escaped: under the u flag an escape such as \- outside a
    // class is a SyntaxError, and a hyphen outside a class is already literal.
    else re += c.replace(/[\\^$.*+?()[\]{}|/]/u, '\\$&');
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
  // Paths are matched without a leading ./ and without a trailing slash, so these forms never match.
  if (glob.startsWith('./')) return 'starts with ./; write the path without ./, as docs/**';
  if (glob.endsWith('/')) return 'ends with a slash; add ** to match a folder, as docs/**';
  // A pattern that loads must also compile, so a bad one is a config error and not a crash later.
  try {
    globToRegExp(glob);
  } catch (error) {
    return `cannot be compiled: ${(error as Error).message}`;
  }
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
