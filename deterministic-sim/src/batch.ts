/**
 * Plays many runs with one policy and reports distributions. Pure, like the reducer: the report is
 * a function of the seed prefix, the run count, the policy and the ruleset, so two machines that
 * run the same batch get the same report hash. Every figure is an integer.
 */

import { canonicalJson } from './canonical.ts';
import { divRound } from './fixed.ts';
import { sha256Hex } from './sha256.ts';
import { advance, start } from './tournament/advance.ts';
import type { Policy } from './tournament/policy.ts';
import { CURRENT_RULESET, rulesFor } from './tournament/rulesets.ts';
import type { State } from './tournament/types.ts';

export interface Histogram {
  /** The lower edge of the first bin. Bin i holds values in [start + i x width, start + (i + 1) x width). */
  readonly start: number;
  readonly width: number;
  readonly counts: readonly number[];
}

export interface Distribution {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  /** The mean x 100, rounded half to even: 12345 means 123.45. */
  readonly mean100: number;
  /** Nearest-rank percentiles: the smallest value with at least p% of the values at or below it. */
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  readonly histogram: Histogram;
}

export interface BatchOptions {
  readonly runs: number;
  readonly seedPrefix: string;
  readonly policy: Policy;
  readonly rulesetVersion?: string;
  /** Histogram bin width for the score. */
  readonly scoreBinWidth?: number;
}

export interface BatchReport {
  readonly rulesetVersion: string;
  readonly seedPrefix: string;
  readonly policy: string;
  readonly runs: number;
  readonly score: Distribution;
  readonly busts: Distribution;
  readonly chipsLeft: Distribution;
}

export const MAX_RUNS = 100_000;
const DEFAULT_SCORE_BIN = 20;

/** The seed of run i of a batch. */
export function batchSeed(prefix: string, index: number): string {
  return `${prefix}-${index}`;
}

/** Plays one run to the end with `policy`. */
export function playOut(seed: string, policy: Policy, rulesetVersion: string = CURRENT_RULESET): State {
  let state = start(seed, rulesetVersion);
  const rounds = rulesFor(rulesetVersion).rounds;
  for (let i = 0; i < rounds && state.status === 'active'; i++) state = advance(state, policy.choose(state));
  if (state.status !== 'ended') throw new Error(`run ${seed} did not end after ${rounds} inputs`);
  return state;
}

function percentile(sorted: readonly number[], p: number): number {
  const rank = divRound(p * sorted.length, 100, 'ceil');
  const value = sorted[Math.max(rank, 1) - 1];
  if (value === undefined) throw new RangeError('percentile of an empty list');
  return value;
}

/** Summary and histogram of a list of integers. */
export function distribution(values: readonly number[], binWidth: number): Distribution {
  if (values.length === 0) throw new RangeError('distribution: no values');
  if (!Number.isSafeInteger(binWidth) || binWidth < 1) throw new RangeError(`distribution: bin width must be a positive integer, got ${binWidth}`);
  let sum = 0;
  for (const v of values) {
    if (!Number.isSafeInteger(v)) throw new RangeError(`distribution: ${v} is not an integer`);
    sum += v;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0] as number;
  const max = sorted[sorted.length - 1] as number;
  const first = divRound(min, binWidth, 'floor') * binWidth;
  const counts = new Array<number>(divRound(max - first, binWidth, 'floor') + 1).fill(0);
  for (const v of sorted) {
    const bin = divRound(v - first, binWidth, 'floor');
    counts[bin] = (counts[bin] as number) + 1;
  }
  return {
    count: values.length,
    min,
    max,
    mean100: divRound(sum * 100, values.length, 'half-even'),
    p10: percentile(sorted, 10),
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    histogram: { start: first, width: binWidth, counts },
  };
}

/** The report for a list of finished runs. The worker in apps/replay-lab plays the runs itself and calls this. */
export function summarize(finals: readonly State[], options: Omit<BatchOptions, 'runs'>): BatchReport {
  return {
    rulesetVersion: options.rulesetVersion ?? CURRENT_RULESET,
    seedPrefix: options.seedPrefix,
    policy: options.policy.name,
    runs: finals.length,
    score: distribution(
      finals.map((s) => s.score),
      options.scoreBinWidth ?? DEFAULT_SCORE_BIN,
    ),
    busts: distribution(
      finals.map((s) => s.busts),
      1,
    ),
    chipsLeft: distribution(
      finals.map((s) => s.chips),
      1,
    ),
  };
}

export function runBatch(options: BatchOptions): BatchReport {
  const { runs } = options;
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) throw new RangeError(`runs must be an integer from 1 to ${MAX_RUNS}`);
  const finals: State[] = [];
  for (let i = 0; i < runs; i++) finals.push(playOut(batchSeed(options.seedPrefix, i), options.policy, options.rulesetVersion));
  return summarize(finals, options);
}

/** SHA-256 of the canonical JSON of a report. Equal hashes, equal reports. */
export function reportHash(report: BatchReport): string {
  return sha256Hex(canonicalJson(report));
}
