/**
 * The calibration loop: a fixed piece of CPU work, timed in each benchmark file's own process
 * right before its benches. The comparison divides every bench time by it, so the committed
 * baseline holds ratios and not milliseconds (see README.md in this folder).
 *
 * The work is of the kind the benched libraries do: building strings, Unicode normalization, a
 * global regex with matchAll, a Map keyed by string, split and join. It allocates, so the garbage
 * collector takes part, as it does in the benches. It must never change: a different loop makes
 * every committed ratio meaningless, and CALIBRATION_VERSION is there to say so.
 */
export const CALIBRATION_VERSION = 1;

const ROUNDS = 101;
const WARMUP_ROUNDS = 40;
const LINES = 1500;

/** One round. Returns a checksum so the work cannot be optimized away, and so a test can pin it. */
export function calibrationRound(): number {
  const seen = new Map<string, number>();
  let sum = 0;
  for (let i = 0; i < LINES; i += 1) {
    const line = `Ítem ${i}: vendí ${i % 13} docenas a $${(i * 37) % 1000}.${String(i % 100).padStart(2, '0')} y cobré ${i % 7} más`;
    const folded = line.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (const match of folded.matchAll(/\$?\d+(?:[.,]\d+)?|\p{L}+/gu)) {
      seen.set(match[0], (seen.get(match[0]) ?? 0) + 1);
      sum += match.index;
    }
    sum += folded.split(' ').join('-').length;
  }
  return sum + seen.size;
}

export interface Calibration {
  readonly version: number;
  /** Median time of one round, in milliseconds. */
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly rounds: number;
}

export function median(sorted: readonly number[]): number {
  if (sorted.length === 0) throw new Error('median of no samples');
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

/** Warms up, then times ROUNDS rounds one by one and keeps the median: one slow round does not move it. */
export function calibrate(now: () => number = () => performance.now()): Calibration {
  for (let i = 0; i < WARMUP_ROUNDS; i += 1) calibrationRound();
  const samples: number[] = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    const start = now();
    calibrationRound();
    samples.push(now() - start);
  }
  samples.sort((a, b) => a - b);
  return { version: CALIBRATION_VERSION, medianMs: median(samples), minMs: samples[0] ?? 0, maxMs: samples[samples.length - 1] ?? 0, rounds: ROUNDS };
}
