/**
 * Integer arithmetic with one declared rounding. The rules work in integers, and multipliers are
 * per-mille (1000 is x1.0). A formula that multiplies several factors goes through mulDiv once:
 * the product is exact (BigInt), and the only rounding is the final division. Rounding each factor
 * on the way (floor(floor(a * b / 1000) * c / 1000)) loses up to one unit per step, always in the
 * same direction; test/fixed.test.ts shows a case where it loses a point.
 */

export const PERMILLE = 1000;

/**
 * How a quotient is rounded.
 * - `floor`: toward negative infinity.
 * - `ceil`: toward positive infinity.
 * - `trunc`: toward zero.
 * - `half-up`: to the nearest integer, a tie toward positive infinity (2.5 -> 3, -2.5 -> -2).
 * - `half-even`: to the nearest integer, a tie to the even one (2.5 -> 2, 3.5 -> 4).
 */
export type Rounding = 'floor' | 'ceil' | 'trunc' | 'half-up' | 'half-even';

function requireSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${what} must be a safe integer, got ${value}`);
}

function roundQuotient(n: bigint, d: bigint, mode: Rounding): bigint {
  // BigInt division truncates toward zero; move to floor so the remainder is in [0, d).
  let q = n / d;
  let r = n % d;
  if (r < 0n) {
    q -= 1n;
    r += d;
  }
  if (r === 0n) return q;
  switch (mode) {
    case 'floor':
      return q;
    case 'ceil':
      return q + 1n;
    case 'trunc':
      return n < 0n ? q + 1n : q;
    case 'half-up':
      return r >= d - r ? q + 1n : q;
    case 'half-even': {
      if (r > d - r) return q + 1n;
      if (r < d - r) return q;
      return q % 2n === 0n ? q : q + 1n;
    }
  }
}

function toSafeNumber(value: bigint, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} is outside the safe integer range`);
  return n;
}

/** n / d with the given rounding. Both safe integers, d positive. Exact for every such pair. */
export function divRound(n: number, d: number, mode: Rounding): number {
  requireSafeInteger(n, 'divRound numerator');
  requireSafeInteger(d, 'divRound divisor');
  if (d <= 0) throw new RangeError(`divRound divisor must be positive, got ${d}`);
  return toSafeNumber(roundQuotient(BigInt(n), BigInt(d), mode), 'divRound result');
}

/**
 * (f1 x f2 x ... x fn) / divisor with one rounding at the end. The product may exceed 2^53; it is
 * computed exactly, and only the result has to be a safe integer.
 */
export function mulDiv(factors: readonly number[], divisor: number, mode: Rounding): number {
  requireSafeInteger(divisor, 'mulDiv divisor');
  if (divisor <= 0) throw new RangeError(`mulDiv divisor must be positive, got ${divisor}`);
  let product = 1n;
  for (const f of factors) {
    requireSafeInteger(f, 'mulDiv factor');
    product *= BigInt(f);
  }
  return toSafeNumber(roundQuotient(product, BigInt(divisor), mode), 'mulDiv result');
}

/** value x p1/1000 x p2/1000 x ... with one rounding at the end. */
export function applyPermille(value: number, permilles: readonly number[], mode: Rounding): number {
  let divisor = 1;
  for (let i = 0; i < permilles.length; i++) divisor *= PERMILLE;
  // 1000^5 is 1e15, still a safe integer; more factors would not be.
  if (!Number.isSafeInteger(divisor)) throw new RangeError('applyPermille: too many multipliers');
  return mulDiv([value, ...permilles], divisor, mode);
}

export function clamp(value: number, lo: number, hi: number): number {
  if (lo > hi) throw new RangeError(`clamp: lo ${lo} > hi ${hi}`);
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * table[index], or a RangeError naming the table. Use this instead of `table[i] ?? 8`: a fallback
 * number reads like a rule, and a missing entry in a ruleset is a bug that should stop the run.
 */
export function lookup<T>(table: readonly T[], index: number, what: string): T {
  if (!Number.isInteger(index) || index < 0 || index >= table.length) {
    throw new RangeError(`${what}: no entry at index ${index} (the table has ${table.length})`);
  }
  return table[index] as T;
}
