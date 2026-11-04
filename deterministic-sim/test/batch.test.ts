import { describe, expect, it } from 'vitest';
import {
  batchSeed,
  distribution,
  fixedDicePolicy,
  playOut,
  REFERENCE_POLICY,
  reportHash,
  runBatch,
  summarize,
} from '../src/index.ts';

describe('distribution', () => {
  it('reports integer summaries: mean x 100 rounded half to even, nearest-rank percentiles', () => {
    const d = distribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    expect(d).toEqual({
      count: 10,
      min: 1,
      max: 10,
      mean100: 550,
      p10: 1,
      p50: 5,
      p90: 9,
      histogram: { start: 0, width: 5, counts: [4, 5, 1] },
    });
    expect(distribution([1, 2], 1).mean100).toBe(150);
    expect(distribution([0, 0, 1], 1).mean100).toBe(33);
    expect(distribution([7], 3)).toMatchObject({ p10: 7, p50: 7, p90: 7, histogram: { start: 6, counts: [1] } });
  });

  it('bins negative values from a floored start', () => {
    expect(distribution([-5, -1, 0, 4], 3).histogram).toEqual({ start: -6, width: 3, counts: [1, 1, 1, 1] });
  });

  it('refuses no values, fractions and a bad bin width', () => {
    expect(() => distribution([], 1)).toThrow(RangeError);
    expect(() => distribution([1.5], 1)).toThrow(RangeError);
    expect(() => distribution([1], 0)).toThrow(RangeError);
  });
});

describe('runBatch', () => {
  it('is a function of its options: the same batch gives the same report hash', () => {
    const options = { runs: 200, seedPrefix: 'det', policy: REFERENCE_POLICY };
    expect(reportHash(runBatch(options))).toBe(reportHash(runBatch(options)));
    expect(reportHash(runBatch({ ...options, seedPrefix: 'other' }))).not.toBe(reportHash(runBatch(options)));
  });

  it('counts every run once in each histogram', () => {
    const report = runBatch({ runs: 300, seedPrefix: 'count', policy: fixedDicePolicy(4) });
    for (const d of [report.score, report.busts, report.chipsLeft]) {
      expect(d.count).toBe(300);
      expect(d.histogram.counts.reduce((a, b) => a + b, 0)).toBe(300);
    }
    expect(report).toMatchObject({ runs: 300, policy: 'roll-4', rulesetVersion: 'dice-1', seedPrefix: 'count' });
  });

  it('summarize over the runs of playOut is runBatch', () => {
    const finals = Array.from({ length: 50 }, (_, i) => playOut(batchSeed('same', i), REFERENCE_POLICY));
    expect(summarize(finals, { seedPrefix: 'same', policy: REFERENCE_POLICY })).toEqual(
      runBatch({ runs: 50, seedPrefix: 'same', policy: REFERENCE_POLICY }),
    );
  });

  it('a one-die policy never busts; more dice spread the score wider', () => {
    const one = runBatch({ runs: 300, seedPrefix: 'spread', policy: fixedDicePolicy(1) });
    const five = runBatch({ runs: 300, seedPrefix: 'spread', policy: fixedDicePolicy(5) });
    expect(one.busts.max).toBe(0);
    expect(five.score.p90 - five.score.p10).toBeGreaterThan(one.score.p90 - one.score.p10);
  });

  it('playOut ends every run in 20 inputs, and runBatch bounds the run count', () => {
    expect(playOut('x', REFERENCE_POLICY)).toMatchObject({ status: 'ended', round: 20 });
    expect(() => runBatch({ runs: 0, seedPrefix: 'p', policy: REFERENCE_POLICY })).toThrow(RangeError);
    expect(() => runBatch({ runs: 100_001, seedPrefix: 'p', policy: REFERENCE_POLICY })).toThrow(RangeError);
    expect(() => fixedDicePolicy(0)).toThrow(RangeError);
  });
});
