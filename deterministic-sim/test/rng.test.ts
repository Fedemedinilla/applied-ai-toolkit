import { describe, expect, it } from 'vitest';
import { deriveState, stepRng, uniformInt, type U32Source } from '../src/index.ts';

function scripted(values: number[]): U32Source & { taken: () => number } {
  let i = 0;
  return {
    nextU32: () => {
      const v = values[i];
      if (v === undefined) throw new Error('script exhausted');
      i += 1;
      return v;
    },
    taken: () => i,
  };
}

describe('uniformInt (rejection sampling)', () => {
  it('rejects draws at or above the largest multiple of n and draws again', () => {
    // 2^32 % 6 = 4, so the four values 4294967292..4294967295 are rejected.
    const source = scripted([0xffffffff, 0xfffffffc, 4294967291]);
    expect(uniformInt(source, 6)).toBe(4294967291 % 6);
    expect(source.taken()).toBe(3);
  });

  it('accepts the largest value below the limit with a single draw', () => {
    const source = scripted([4294967291]);
    expect(uniformInt(source, 6)).toBe(5);
    expect(source.taken()).toBe(1);
  });

  it('for n just above 2^31, about half of all draws are rejected', () => {
    const n = 0x80000001;
    const limit = 0x100000000 - (0x100000000 % n);
    expect(limit).toBe(n);
    const source = scripted([n, n + 5, 7]);
    expect(uniformInt(source, n)).toBe(7);
  });

  it('takes no draw for n = 1 and refuses n outside [1, 2^32]', () => {
    const source = scripted([]);
    expect(uniformInt(source, 1)).toBe(0);
    for (const n of [0, -1, 2.5, 0x100000001, Number.NaN]) expect(() => uniformInt(source, n)).toThrow(RangeError);
  });

  it('is uniform on six faces: chi-square over 60,000 seeded draws is below the 0.1% critical value', () => {
    const rng = stepRng('chi-square', 0, ['dice']);
    const counts = [0, 0, 0, 0, 0, 0];
    const draws = 60_000;
    for (let i = 0; i < draws; i++) {
      const face = rng.int('dice', 6);
      counts[face] = (counts[face] as number) + 1;
    }
    const expected = draws / 6;
    const chi = counts.reduce((sum, c) => sum + ((c - expected) * (c - expected)) / expected, 0);
    // 20.52 is the 0.999 quantile of chi-square with 5 degrees of freedom.
    expect(chi).toBeLessThan(20.52);
  });
});

describe('named streams', () => {
  it('derive a state from SHA-256 of [seed, step, stream], so each triple has its own sequence', () => {
    const a = deriveState('s', 0, 'dice');
    expect(deriveState('s', 0, 'dice')).toEqual(a);
    expect(deriveState('s', 0, 'house')).not.toEqual(a);
    expect(deriveState('s', 1, 'dice')).not.toEqual(a);
    expect(deriveState('s', '0', 'dice')).not.toEqual(a);
  });

  it('separate seed and step unambiguously: "a/1" step 0 is not "a" step "1/0"', () => {
    // A string concatenation such as `${seed}/${step}` would give both the same generator.
    expect(deriveState('a/1', 0, 'dice')).not.toEqual(deriveState('a', '1/0', 'dice'));
  });

  it('are independent: draws from one stream do not move another', () => {
    const quiet = stepRng('seed', 3, ['dice', 'house']);
    const busy = stepRng('seed', 3, ['dice', 'house']);
    for (let i = 0; i < 50; i++) busy.int('dice', 6);
    expect([busy.int('house', 10), busy.int('house', 10)]).toEqual([quiet.int('house', 10), quiet.int('house', 10)]);
  });

  it('count raw draws, rejected ones included, and refuse an unknown stream', () => {
    const rng = stepRng('seed', 0, ['dice']);
    expect(rng.draws('dice')).toBe(0);
    rng.int('dice', 6);
    rng.u32('dice');
    expect(rng.draws('dice')).toBeGreaterThanOrEqual(2);
    expect(() => rng.int('other' as 'dice', 6)).toThrow(/unknown stream/u);
  });

  it('range, chancePermille and pickWeighted stay in range and validate their arguments', () => {
    const rng = stepRng('helpers', 0, ['x']);
    for (let i = 0; i < 500; i++) {
      const r = rng.range('x', -3, 3);
      expect(r >= -3 && r <= 3).toBe(true);
    }
    expect(rng.chancePermille('x', 0)).toBe(false);
    expect(rng.chancePermille('x', 1000)).toBe(true);
    expect(() => rng.chancePermille('x', 1001)).toThrow(RangeError);
    const picks = new Set<number>();
    for (let i = 0; i < 200; i++) picks.add(rng.pickWeighted('x', [0, 3, 0, 1]));
    expect([...picks].sort()).toEqual([1, 3]);
    expect(() => rng.pickWeighted('x', [0, 0])).toThrow(/zero/u);
    expect(() => rng.pickWeighted('x', [1, -1])).toThrow(RangeError);
    expect(() => rng.range('x', 2, 1)).toThrow(RangeError);
  });

  it('chancePermille takes one draw whatever p is, so p cannot shift later draws', () => {
    const a = stepRng('p', 0, ['x']);
    const b = stepRng('p', 0, ['x']);
    a.chancePermille('x', 0);
    b.chancePermille('x', 999);
    expect(a.u32('x')).toBe(b.u32('x'));
  });
});
