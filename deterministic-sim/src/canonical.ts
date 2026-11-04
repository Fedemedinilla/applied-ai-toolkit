/**
 * Canonical JSON: one byte sequence per value, so a hash identifies the value and not the way it
 * was built. Object keys are sorted by UTF-16 code unit, as RFC 8785 (JCS) sorts them, with no
 * whitespace. Numbers use ECMAScript's own number-to-string (the one JCS adopts), so -0 is written
 * as 0. The subset is the one the core's records hold: null, booleans, strings, finite numbers,
 * arrays and plain objects.
 *
 * JSON.stringify alone is not canonical. It writes keys in insertion order, so { seed, inputs } and
 * { inputs, seed } give different text, and it drops undefined values and turns NaN into null
 * without a word, so two different values can share one text.
 */

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export class CanonicalJsonError extends Error {
  readonly path: string;
  constructor(path: string, problem: string) {
    super(`canonical JSON: ${problem} at ${path}`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function write(value: unknown, path: string, open: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(path, `non-finite number ${value}`);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(path, `unsupported type ${typeof value}`);
  }
  if (open.has(value)) throw new CanonicalJsonError(path, 'circular reference');
  open.add(value);
  let text: string;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new CanonicalJsonError(`${path}[${i}]`, 'array hole');
      parts.push(write(value[i], `${path}[${i}]`, open));
    }
    text = `[${parts.join(',')}]`;
  } else {
    if (!isPlainObject(value)) throw new CanonicalJsonError(path, 'not a plain object');
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child === undefined) throw new CanonicalJsonError(`${path}.${key}`, 'undefined value');
      parts.push(`${JSON.stringify(key)}:${write(child, `${path}.${key}`, open)}`);
    }
    text = `{${parts.join(',')}}`;
  }
  open.delete(value);
  return text;
}

/** The canonical text of `value`. Throws CanonicalJsonError, with the path, on anything outside the subset. */
export function canonicalJson(value: unknown): string {
  return write(value, '$', new Set());
}
