/**
 * The benchmark result file and its comparison with the committed baseline.
 *
 * A bench is stored as a ratio: its median time divided by the median time of the calibration
 * loop (calibration.ts) measured in the same process right before it. Two machines of different
 * speed give different milliseconds and, to a first approximation, the same ratio, so a baseline
 * committed from one machine can be checked on another. README.md in this folder says where that
 * approximation stops holding.
 */
import { z } from 'zod';
import { CALIBRATION_VERSION } from './calibration.ts';

export const RESULT_SCHEMA = 1;
/** A bench fails the comparison when its ratio is more than this fraction above the baseline's. */
export const DEFAULT_TOLERANCE = 0.5;

const positive = z.number().positive();

const BenchEntry = z.strictObject({
  /** Median time of one iteration, in milliseconds. */
  medianMs: positive,
  meanMs: positive,
  /** Relative margin of error of the mean, in percent, as tinybench reports it. */
  rmePercent: z.number().nonnegative(),
  samples: z.int().positive(),
  /** Median time of one calibration round in the same process, in milliseconds. */
  calibrationMs: positive,
  /** medianMs / calibrationMs. The only field the comparison reads. */
  ratio: positive,
});
export type BenchEntry = z.infer<typeof BenchEntry>;

export const BenchResult = z.strictObject({
  schema: z.literal(RESULT_SCHEMA),
  calibrationVersion: z.int().positive(),
  /** When the run was collected, ISO 8601. */
  date: z.string().min(1),
  /** For the reader. The comparison ignores it. */
  machine: z.strictObject({ node: z.string(), platform: z.string(), arch: z.string(), cpu: z.string(), cores: z.int().nonnegative() }),
  benches: z.record(z.string().min(1), BenchEntry),
});
export type BenchResult = z.infer<typeof BenchResult>;

/** What `vitest bench` writes for one bench through `writeResult`: the fields read here. */
export const RawBench = z.object({
  latency: z.object({ p50: positive, mean: positive, rme: z.number().nonnegative(), samplesCount: z.int().positive() }),
});
export type RawBench = z.infer<typeof RawBench>;

export const RawCalibration = z.object({ version: z.int().positive(), medianMs: positive });
export type RawCalibration = z.infer<typeof RawCalibration>;

/** One folder of reports/bench/raw: the calibration of that bench file's process and its benches. */
export interface RawFolder {
  readonly folder: string;
  readonly calibration: RawCalibration;
  readonly benches: Readonly<Record<string, RawBench>>;
}

const round = (n: number, decimals: number): number => Number(n.toFixed(decimals));

export function buildResult(folders: readonly RawFolder[], machine: BenchResult['machine'], date: string): BenchResult {
  const benches: Record<string, BenchEntry> = {};
  for (const { folder, calibration, benches: raw } of [...folders].sort((a, b) => a.folder.localeCompare(b.folder))) {
    if (calibration.version !== CALIBRATION_VERSION) {
      throw new Error(`${folder}: calibration version ${calibration.version}, this code measures version ${CALIBRATION_VERSION}`);
    }
    for (const name of Object.keys(raw).sort()) {
      const latency = raw[name]?.latency;
      if (latency === undefined) continue;
      benches[`${folder}/${name}`] = {
        medianMs: round(latency.p50, 4),
        meanMs: round(latency.mean, 4),
        rmePercent: round(latency.rme, 2),
        samples: latency.samplesCount,
        calibrationMs: round(calibration.medianMs, 4),
        ratio: round(latency.p50 / calibration.medianMs, 4),
      };
    }
  }
  if (Object.keys(benches).length === 0) throw new Error('no bench results to collect');
  return { schema: RESULT_SCHEMA, calibrationVersion: CALIBRATION_VERSION, date, machine, benches };
}

export type Status = 'ok' | 'regression' | 'faster' | 'missing' | 'new';

export interface Row {
  readonly name: string;
  readonly status: Status;
  /** Null for a bench the baseline does not have. */
  readonly baselineRatio: number | null;
  /** Null for a bench the result does not have. */
  readonly ratio: number | null;
  /** ratio / baselineRatio - 1: 0.2 is 20% slower than the baseline. Null without both. */
  readonly change: number | null;
}

export interface Comparison {
  readonly tolerance: number;
  readonly rows: readonly Row[];
  /** False when a bench regressed beyond the tolerance or a baseline bench was not run. */
  readonly ok: boolean;
}

/**
 * Compares by ratio. A bench passes while its ratio is at most baseline x (1 + tolerance); exactly
 * at the limit passes. 'faster' (below baseline x (1 - tolerance)) and 'new' do not fail: they say
 * the baseline is out of date. 'missing' fails, so deleting a bench cannot hide a regression.
 */
export function compare(result: BenchResult, baseline: BenchResult, tolerance: number = DEFAULT_TOLERANCE): Comparison {
  if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error(`tolerance must be a positive number, got ${tolerance}`);
  if (result.calibrationVersion !== baseline.calibrationVersion) {
    throw new Error(
      `the result was measured with calibration version ${result.calibrationVersion} and the baseline with ${baseline.calibrationVersion}: their ratios are not comparable; record a new baseline`,
    );
  }
  const names = [...new Set([...Object.keys(baseline.benches), ...Object.keys(result.benches)])].sort();
  const rows = names.map((name): Row => {
    const base = baseline.benches[name]?.ratio ?? null;
    const now = result.benches[name]?.ratio ?? null;
    if (base === null) return { name, status: 'new', baselineRatio: null, ratio: now, change: null };
    if (now === null) return { name, status: 'missing', baselineRatio: base, ratio: null, change: null };
    const status: Status = now > base * (1 + tolerance) ? 'regression' : now < base * (1 - tolerance) ? 'faster' : 'ok';
    return { name, status, baselineRatio: base, ratio: now, change: now / base - 1 };
  });
  return { tolerance, rows, ok: rows.every((r) => r.status !== 'regression' && r.status !== 'missing') };
}

const NOTE: Readonly<Record<Status, string>> = {
  ok: '',
  regression: 'slower than the baseline beyond the tolerance',
  faster: 'faster than the baseline beyond the tolerance: record a new baseline',
  missing: 'in the baseline, not in this run',
  new: 'not in the baseline: record a new baseline',
};

const percent = (fraction: number): string => `${fraction >= 0 ? '+' : ''}${(fraction * 100).toFixed(1)}%`;

/** The comparison as lines of text, one per bench and a verdict at the end. */
export function formatComparison(comparison: Comparison): string {
  const width = Math.max(...comparison.rows.map((r) => r.name.length), 5);
  const lines = comparison.rows.map((r) =>
    [
      r.name.padEnd(width),
      (r.baselineRatio?.toFixed(4) ?? '-').padStart(10),
      (r.ratio?.toFixed(4) ?? '-').padStart(10),
      (r.change === null ? '-' : percent(r.change)).padStart(9),
      ` ${r.status}${NOTE[r.status] ? `: ${NOTE[r.status]}` : ''}`,
    ].join(' '),
  );
  const header = ['bench'.padEnd(width), 'baseline'.padStart(10), 'now'.padStart(10), 'change'.padStart(9), ' status'].join(' ');
  const failed = comparison.rows.filter((r) => r.status === 'regression' || r.status === 'missing').length;
  const verdict = comparison.ok
    ? `OK: no bench is more than ${percent(comparison.tolerance)} above its baseline ratio.`
    : `FAILED: ${failed} of ${comparison.rows.length} benches regressed beyond ${percent(comparison.tolerance)} or did not run.`;
  return [header, ...lines, '', 'Ratios are bench median / calibration median of the same process.', verdict].join('\n');
}
