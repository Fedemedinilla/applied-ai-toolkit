/**
 * In JavaScript, \b only knows ASCII word characters, even with the u flag, so
 * /é\b/u never matches "Lideré la". These lookarounds are word boundaries that
 * understand accented letters. Section 13.2 of the report defines them the same way.
 */
export const B = String.raw`(?<![\p{L}\p{N}])`;
export const E = String.raw`(?![\p{L}\p{N}])`;

/** A case-insensitive list of words or phrases, each bounded on both sides. */
export function wordList(alternatives: readonly string[]): string {
  return `${B}(?:${alternatives.join('|')})${E}`;
}

const cache = new Map<string, RegExp>();

/** Compiles once per source and flags. Callers must reset lastIndex or use matchAll. */
export function compile(source: string, flags: string): RegExp {
  const key = `${flags}/${source}`;
  let re = cache.get(key);
  if (!re) {
    re = new RegExp(source, flags);
    cache.set(key, re);
  }
  return re;
}
