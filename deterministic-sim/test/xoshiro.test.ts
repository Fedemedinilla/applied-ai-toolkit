import { describe, expect, it } from 'vitest';
import { Xoshiro128ss } from '../src/index.ts';

// First eight outputs of the authors' C reference (xoshiro128starstar.c), compiled with gcc and run
// on these two states.
const VECTORS: Array<{ state: [number, number, number, number]; outputs: number[] }> = [
  { state: [1, 2, 3, 4], outputs: [11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849] },
  {
    state: [0x9e3779b9, 0x243f6a88, 0xb7e15162, 0xdeadbeef],
    outputs: [2463954730, 5524658, 74256371, 1905451993, 3123413897, 314453775, 1263677054, 1531511215],
  },
];

describe('xoshiro128**', () => {
  it.each(VECTORS)('matches the C reference from state $state', ({ state, outputs }) => {
    const gen = new Xoshiro128ss(state);
    expect(outputs.map(() => gen.nextU32())).toEqual(outputs);
  });

  it('returns unsigned 32-bit integers', () => {
    const gen = new Xoshiro128ss([0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]);
    for (let i = 0; i < 1000; i++) {
      const x = gen.nextU32();
      expect(Number.isInteger(x) && x >= 0 && x <= 0xffffffff).toBe(true);
    }
  });

  it('exposes its state, and a generator built from it continues the same sequence', () => {
    const a = new Xoshiro128ss([5, 6, 7, 8]);
    a.nextU32();
    a.nextU32();
    const b = new Xoshiro128ss(a.state());
    expect([b.nextU32(), b.nextU32()]).toEqual([a.nextU32(), a.nextU32()]);
  });

  it('refuses the all-zero state and words outside 32 bits', () => {
    expect(() => new Xoshiro128ss([0, 0, 0, 0])).toThrow(/all zero/u);
    expect(() => new Xoshiro128ss([1, 2, 3, 0x100000000])).toThrow(RangeError);
    expect(() => new Xoshiro128ss([1, 2, -1, 4])).toThrow(RangeError);
    expect(() => new Xoshiro128ss([1, 2, 3.5, 4])).toThrow(RangeError);
  });
});
