// Blanks the parts of a JavaScript snippet that are not code: strings,
// comments and regex literals. The ${...} parts of a template literal are
// kept, because they are code. The coverage checks run their identifier
// regexes on the result, so a "//" inside a URL string or a quote inside
// /'/ no longer hides the code that follows.
//
// This is a scanner, not a parser. A "/" starts a regex literal when the
// last code character is an operator or an opening bracket, or the last word
// is a keyword such as `return`; otherwise it is a division. That is enough
// for the templates in this folder.

const REGEX_AFTER_CHAR = '(,=:[!&|?{};+-*%<>~^';
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

function regexAllowed(code: string): boolean {
  const before = code.trimEnd();
  const last = before.at(-1);
  if (last === undefined || REGEX_AFTER_CHAR.includes(last)) return true;
  const word = /[A-Za-z_$][\w$]*$/.exec(before)?.[0];
  return word !== undefined && REGEX_AFTER_WORD.has(word);
}

/** Index after a '...' or "..." string that starts at `start`. */
function skipQuoted(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') i += 2;
    else if (c === quote) return i + 1;
    else if (c === '\n') return i;
    else i++;
  }
  return i;
}

/** Index after a regex literal that starts at `start`, flags included. */
function skipRegex(src: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '\n') return i;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i++;
      while (i < src.length && /[a-z]/.test(src[i] ?? '')) i++;
      return i;
    }
    i++;
  }
  return i;
}

function scan(src: string, start: number, inTemplateExpression: boolean): { code: string; end: number } {
  let code = '';
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i] ?? '';
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
      code += ' ';
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      code += ' ';
    } else if (c === "'" || c === '"') {
      i = skipQuoted(src, i);
      code += "''";
    } else if (c === '`') {
      i++;
      code += ' ';
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') {
          i += 2;
        } else if (src[i] === '$' && src[i + 1] === '{') {
          const inner = scan(src, i + 2, true);
          code += ` ${inner.code} `;
          i = inner.end + 1;
        } else {
          i++;
        }
      }
      i++;
      code += "''";
    } else if (c === '/' && regexAllowed(code)) {
      i = skipRegex(src, i);
      code += "''";
    } else {
      if (inTemplateExpression && c === '{') depth++;
      if (inTemplateExpression && c === '}') {
        if (depth === 0) return { code, end: i };
        depth--;
      }
      code += c;
      i++;
    }
  }
  return { code, end: i };
}

/** `source` with strings, comments and regex literals blanked, and template `${...}` parts kept. */
export function codeOnly(source: string): string {
  return scan(source, 0, false).code;
}
