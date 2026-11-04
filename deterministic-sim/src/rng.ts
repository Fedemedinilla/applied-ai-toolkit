/**
 * Named random streams for one reducer step. Each stream is its own xoshiro128** generator, seeded
 * from SHA-256 of the canonical JSON of [seed, step, stream name]. Streams never share draws: a rule
 * that takes one more draw from "dice" cannot shift what "house" returns, in this step or any other.
 */

import { canonicalJson } from './canonical.ts';
import { sha256, utf8 } from './sha256.ts';
import { Xoshiro128ss, type U32Source, type XoshiroState } from './xoshiro.ts';

const TWO_32 = 0x100000000;

/** A step is an input index, or a label such as "start" for the draws made before any input. */
export type StepKey = number | string;

/** The generator state for one stream of one step: the first 16 bytes of the digest, as four words. */
export function deriveState(seed: string, step: StepKey, stream: string): XoshiroState {
  const digest = sha256(utf8(canonicalJson([seed, step, stream])));
  const view = new DataView(digest.buffer);
  const state: XoshiroState = [view.getUint32(0), view.getUint32(4), view.getUint32(8), view.getUint32(12)];
  // The all-zero state would need a 2^-128 digest prefix; the generator itself refuses it.
  return state;
}

/**
 * A uniform integer in [0, n), with no modulo bias. x % n alone favours the low residues whenever
 * 2^32 is not a multiple of n, so draws at or above the largest multiple of n are rejected and
 * redrawn. For n = 6 that rejects 4 values out of 2^32; for n just above 2^31 it rejects nearly half.
 */
export function uniformInt(source: U32Source, n: number): number {
  if (!Number.isInteger(n) || n <= 0 || n > TWO_32) {
    throw new RangeError(`uniformInt: n must be an integer in [1, 2^32], got ${n}`);
  }
  if (n === 1) return 0;
  const limit = TWO_32 - (TWO_32 % n);
  let x = source.nextU32();
  while (x >= limit) x = source.nextU32();
  return x % n;
}

interface Stream {
  readonly generator: Xoshiro128ss;
  draws: number;
}

export class StepRng<S extends string> {
  private readonly seed: string;
  private readonly step: StepKey;
  private readonly allowed: ReadonlySet<string>;
  private readonly streams = new Map<S, Stream>();

  constructor(seed: string, step: StepKey, streams: readonly S[]) {
    this.seed = seed;
    this.step = step;
    this.allowed = new Set(streams);
  }

  /** A stream's generator is created on its first draw, so an unused stream costs no hash. */
  private source(name: S): U32Source {
    if (!this.allowed.has(name)) throw new RangeError(`unknown stream "${name}"`);
    let stream = this.streams.get(name);
    if (!stream) {
      stream = { generator: new Xoshiro128ss(deriveState(this.seed, this.step, name)), draws: 0 };
      this.streams.set(name, stream);
    }
    const open = stream;
    return {
      nextU32: () => {
        open.draws += 1;
        return open.generator.nextU32();
      },
    };
  }

  /** Raw 32-bit draws taken from a stream so far, rejected ones included. A stream never opened has taken none. */
  draws(name: S): number {
    const stream = this.streams.get(name);
    return stream ? stream.draws : 0;
  }

  u32(stream: S): number {
    return this.source(stream).nextU32();
  }

  /** Uniform in [0, n). */
  int(stream: S, n: number): number {
    return uniformInt(this.source(stream), n);
  }

  /** Uniform in [lo, hi], both included. */
  range(stream: S, lo: number, hi: number): number {
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) {
      throw new RangeError(`range: need integers with lo <= hi, got ${lo} and ${hi}`);
    }
    return lo + this.int(stream, hi - lo + 1);
  }

  /** True with probability p / 1000. Always takes one draw, so p never changes what later draws see. */
  chancePermille(stream: S, p: number): boolean {
    if (!Number.isInteger(p) || p < 0 || p > 1000) throw new RangeError(`chancePermille: p must be 0..1000, got ${p}`);
    return this.int(stream, 1000) < p;
  }

  /** The index of a weight, chosen with probability weight / total. Weights are non-negative integers. */
  pickWeighted(stream: S, weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) {
      if (!Number.isSafeInteger(w) || w < 0) throw new RangeError(`pickWeighted: weights must be non-negative integers, got ${w}`);
      total += w;
    }
    if (total === 0) throw new RangeError('pickWeighted: the weights sum to zero');
    let r = this.int(stream, total);
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i] as number;
      if (r < w) return i;
      r -= w;
    }
    throw new Error('pickWeighted: unreachable');
  }
}

/** The streams of one reducer step: the step's RNG depends only on the seed and the step index. */
export function stepRng<S extends string>(seed: string, step: StepKey, streams: readonly S[]): StepRng<S> {
  return new StepRng(seed, step, streams);
}
