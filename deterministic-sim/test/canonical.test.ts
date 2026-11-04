import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson } from '../src/index.ts';

/**
 * The same object with its keys inserted in reverse order, all the way down. defineProperty, not
 * assignment, so a "__proto__" key (fast-check generates it) stays an own key instead of setting the
 * prototype.
 */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).reverse()) {
      Object.defineProperty(out, key, { value: reversed((value as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

describe('canonicalJson', () => {
  it('sorts keys at every level and writes no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [true, null], c: 'x' } })).toBe('{"a":{"c":"x","d":[true,null]},"b":1}');
  });

  it('sorts by UTF-16 code unit, as RFC 8785 does', () => {
    // U+E000 sorts before U+1F600 (high surrogate D83D) by code point, but after it by code unit.
    expect(canonicalJson({ '\u{1f600}': 1, '': 2, a: 3, B: 4 })).toBe('{"B":4,"a":3,"\u{1f600}":1,"":2}');
  });

  it('gives the same text whatever the key order (property)', () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => canonicalJson(reversed(value)) === canonicalJson(value)), { numRuns: 300 });
  });

  it('keeps a "__proto__" key as data, in either key order', () => {
    const value: unknown = JSON.parse('{"__proto__":{"a":1},"b":2}');
    expect(canonicalJson(value)).toBe('{"__proto__":{"a":1},"b":2}');
    expect(canonicalJson(reversed(value))).toBe('{"__proto__":{"a":1},"b":2}');
  });

  it('round-trips through JSON.parse to the same text (property)', () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => canonicalJson(JSON.parse(canonicalJson(value))) === canonicalJson(value)), {
      numRuns: 300,
    });
  });

  it('writes -0 as 0 and keeps ECMAScript number formatting', () => {
    expect(canonicalJson([-0, 1e21, 0.1, 5e-7])).toBe('[0,1e+21,0.1,5e-7]');
  });

  it('refuses what JSON.stringify would silently change, naming the path', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ a: undefined }, /undefined value at \$\.a/u],
      [{ a: [1, Number.NaN] }, /non-finite number NaN at \$\.a\[1\]/u],
      [[Number.POSITIVE_INFINITY], /non-finite/u],
      [{ d: new Date(0) }, /not a plain object at \$\.d/u],
      [{ f: () => 1 }, /unsupported type function/u],
      [{ n: 1n }, /unsupported type bigint/u],
      [new Array(2), /array hole/u],
      [new Map(), /not a plain object/u],
    ];
    for (const [value, message] of cases) {
      expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
      expect(() => canonicalJson(value)).toThrow(message);
    }
  });

  it('refuses a cycle but accepts the same object twice in a tree', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    expect(() => canonicalJson(loop)).toThrow(/circular/u);
  });

  it('shows why JSON.stringify is not enough: key order changes its text', () => {
    const a = { seed: 's', inputs: [] };
    const b = { inputs: [], seed: 's' };
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});
