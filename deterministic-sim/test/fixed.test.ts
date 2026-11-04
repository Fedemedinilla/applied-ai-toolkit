import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyPermille, clamp, divRound, lookup, mulDiv, type Rounding } from '../src/index.ts';

/** Reference rounding on exact rationals, written independently of fixed.ts. */
function reference(n: bigint, d: bigint, mode: Rounding): bigint {
  const floor = (n - (((n % d) + d) % d)) / d;
  const r = n - floor * d; // 0 <= r < d
  const twice = 2n * r;
  switch (mode) {
    case 'floor':
      return floor;
    case 'ceil':
      return r === 0n ? floor : floor + 1n;
    case 'trunc':
      return r === 0n || n >= 0n ? floor : floor + 1n;
    case 'half-up':
      return twice >= d ? floor + 1n : floor;
    case 'half-even':
      if (twice > d) return floor + 1n;
      if (twice < d) return floor;
      return floor % 2n === 0n ? floor : floor + 1n;
  }
}

const MODES: Rounding[] = ['floor', 'ceil', 'trunc', 'half-up', 'half-even'];

describe('divRound', () => {
  it('rounds the documented examples', () => {
    expect(MODES.map((m) => divRound(5, 2, m))).toEqual([2, 3, 2, 3, 2]);
    expect(MODES.map((m) => divRound(-5, 2, m))).toEqual([-3, -2, -2, -2, -2]);
    expect(MODES.map((m) => divRound(7, 2, m))).toEqual([3, 4, 3, 4, 4]);
    expect(MODES.map((m) => divRound(-7, 3, m))).toEqual([-3, -2, -2, -2, -2]);
    expect(MODES.map((m) => divRound(6, 3, m))).toEqual([2, 2, 2, 2, 2]);
  });

  it('agrees with an exact reference for every safe numerator and divisor (property)', () => {
    fc.assert(
      fc.property(
        fc.maxSafeInteger(),
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        fc.constantFrom(...MODES),
        (n, d, mode) => BigInt(divRound(n, d, mode)) === reference(BigInt(n), BigInt(d), mode),
      ),
      { numRuns: 2000 },
    );
  });

  it('refuses unsafe or fractional operands and a non-positive divisor', () => {
    expect(() => divRound(1.5, 2, 'floor')).toThrow(RangeError);
    expect(() => divRound(Number.MAX_SAFE_INTEGER + 1, 2, 'floor')).toThrow(RangeError);
    expect(() => divRound(1, 0, 'floor')).toThrow(/positive/u);
    expect(() => divRound(1, -2, 'floor')).toThrow(/positive/u);
  });
});

describe('mulDiv and applyPermille: one rounding at the end', () => {
  it('computes the product exactly where floats do not', () => {
    // 3 x 107 x 28059810762433 is 2^53 + 1, which a double cannot hold: it becomes 2^53, and the
    // float version of the formula comes out one too low.
    const factors = [3, 107, 28059810762433];
    expect(Math.floor((3 * 107 * 28059810762433) / 3)).toBe(3002399751580330);
    expect(mulDiv(factors, 3, 'floor')).toBe(3002399751580331);
  });

  it('computes the product exactly even far beyond 2^53', () => {
    // 3e6 x 3e6 x 3e6 = 2.7e19, far past 2^53; divided back it is exact.
    expect(mulDiv([3_000_000, 3_000_000, 3_000_000], 9_000_000_000_000, 'floor')).toBe(3_000_000);
    expect(() => mulDiv([Number.MAX_SAFE_INTEGER, 4], 1, 'floor')).toThrow(/safe integer range/u);
  });

  it('keeps the point that chained flooring loses', () => {
    // A roll of 11 with a pair (x1.25), streak 1 (x1.1) and a cold house (x0.8): 11 x 1.1 x 1.25 x 0.8 = 12.1.
    const chained = Math.floor((Math.floor((Math.floor((11 * 1250) / 1000) * 1100) / 1000) * 800) / 1000);
    expect(chained).toBe(11);
    expect(applyPermille(11, [1250, 1100, 800], 'floor')).toBe(12);
  });

  it('never rounds lower than chained flooring (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), fc.array(fc.integer({ min: 0, max: 5000 }), { maxLength: 4 }), (v, ps) => {
        let chained = v;
        for (const p of ps) chained = Math.floor((chained * p) / 1000);
        return applyPermille(v, ps, 'floor') >= chained;
      }),
    );
  });

  it('refuses more multipliers than a safe divisor allows', () => {
    expect(applyPermille(7, [1000, 1000, 1000, 1000, 1000], 'floor')).toBe(7);
    expect(() => applyPermille(7, [1000, 1000, 1000, 1000, 1000, 1000], 'floor')).toThrow(/too many/u);
  });
});

describe('clamp and lookup', () => {
  it('clamp bounds a value and refuses an empty interval', () => {
    expect([clamp(-1, 0, 5), clamp(3, 0, 5), clamp(9, 0, 5)]).toEqual([0, 3, 5]);
    expect(() => clamp(1, 5, 0)).toThrow(RangeError);
  });

  it('lookup throws on a missing entry instead of supplying a number', () => {
    const table = [10, 20, 30];
    expect(lookup(table, 2, 'gain table')).toBe(30);
    expect(() => lookup(table, 3, 'gain table')).toThrow(/gain table: no entry at index 3 \(the table has 3\)/u);
    expect(() => lookup(table, -1, 'gain table')).toThrow(RangeError);
    expect(() => lookup(table, 0.5, 'gain table')).toThrow(RangeError);
  });
});
