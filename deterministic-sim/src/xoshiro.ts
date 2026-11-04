/**
 * xoshiro128** 1.1 (Blackman and Vigna, "Scrambled Linear Pseudorandom Number Generators", 2018).
 * Four 32-bit words of state, a period of 2^128 - 1, and only shifts, xors, rotations and
 * Math.imul, so every JavaScript engine produces the same sequence. test/xoshiro.test.ts checks the
 * first outputs against the authors' C reference.
 */

export type XoshiroState = readonly [number, number, number, number];

/** Anything that yields uniform unsigned 32-bit integers. The sampling helpers in rng.ts take this. */
export interface U32Source {
  nextU32(): number;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export class Xoshiro128ss implements U32Source {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(state: XoshiroState) {
    for (const word of state) {
      if (!Number.isInteger(word) || word < 0 || word > 0xffffffff) {
        throw new RangeError(`xoshiro128**: state words must be unsigned 32-bit integers, got ${word}`);
      }
    }
    if (state[0] === 0 && state[1] === 0 && state[2] === 0 && state[3] === 0) {
      // The all-zero state is a fixed point: the generator would return 0 forever.
      throw new RangeError('xoshiro128**: the state must not be all zero');
    }
    [this.s0, this.s1, this.s2, this.s3] = state;
  }

  /** The next unsigned 32-bit integer, uniform in [0, 2^32). */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  state(): XoshiroState {
    return [this.s0, this.s1, this.s2, this.s3];
  }
}
