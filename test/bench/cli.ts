// The benchmark results on disk: clean, collect and compare.
//
//   node test/bench/cli.ts clean                        # empties reports/bench/raw before a run
//   node test/bench/cli.ts collect [--out <file>]       # raw files -> reports/bench/result.json
//   node test/bench/cli.ts compare [--result <file>] [--baseline <file>] [--tolerance 0.5]
//
// `npm run bench` runs clean, the benches and collect. `npm run bench:compare` runs compare, and
// `npm run bench:baseline` collects the last run into test/bench/baseline.json.
//
// Exit codes of compare: 0 when no bench regressed, 1 when one regressed beyond the tolerance or a
// baseline bench did not run, 2 when the arguments or a file cannot be read.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { BenchResult, buildResult, compare, DEFAULT_TOLERANCE, formatComparison, RawBench, RawCalibration, type RawFolder } from './compare.ts';

const RAW_DIR = 'reports/bench/raw';
const RESULT_FILE = 'reports/bench/result.json';
const BASELINE_FILE = 'test/bench/baseline.json';

class UsageError extends Error {}

function options(args: readonly string[], allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? '';
    const value = args[i + 1];
    if (!flag.startsWith('--') || !allowed.includes(flag.slice(2))) throw new UsageError(`unknown option ${flag}`);
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    out[flag.slice(2)] = value;
  }
  return out;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readResult(file: string): BenchResult {
  const parsed = BenchResult.safeParse(readJson(file));
  if (!parsed.success) throw new UsageError(`${file} is not a bench result: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`).join(', ')}`);
  return parsed.data;
}

function rawFolders(dir: string): RawFolder[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new UsageError(`${dir} does not exist: run the benches first (npm run bench)`);
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const folder = join(dir, e.name);
      const files = readdirSync(folder).filter((f) => f.endsWith('.json') && f !== 'calibration.json');
      const calibration = RawCalibration.safeParse(readJson(join(folder, 'calibration.json')));
      if (!calibration.success) throw new UsageError(`${join(folder, 'calibration.json')} is not a calibration result`);
      const benches: Record<string, RawBench> = {};
      for (const file of files) {
        const bench = RawBench.safeParse(readJson(join(folder, file)));
        if (!bench.success) throw new UsageError(`${join(folder, file)} is not a bench result of vitest bench`);
        benches[basename(file, '.json')] = bench.data;
      }
      return { folder: e.name, calibration: calibration.data, benches };
    });
}

function collect(args: readonly string[]): number {
  const { out = RESULT_FILE } = options(args, ['out']);
  const cpu = cpus();
  const machine = { node: process.versions.node, platform: process.platform, arch: process.arch, cpu: cpu[0]?.model.trim() ?? 'unknown', cores: cpu.length };
  const result = buildResult(rawFolders(RAW_DIR), machine, new Date().toISOString());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${out}: ${Object.keys(result.benches).length} benches`);
  for (const [name, b] of Object.entries(result.benches)) {
    console.log(`  ${name}: ${b.medianMs} ms median (±${b.rmePercent}% on the mean, ${b.samples} samples), ratio ${b.ratio}`);
  }
  return 0;
}

function runCompare(args: readonly string[]): number {
  const { result = RESULT_FILE, baseline = BASELINE_FILE, tolerance } = options(args, ['result', 'baseline', 'tolerance']);
  const limit = tolerance === undefined ? DEFAULT_TOLERANCE : Number(tolerance);
  if (!Number.isFinite(limit) || limit <= 0) throw new UsageError(`--tolerance must be a positive number such as 0.5, got ${tolerance}`);
  let comparison;
  try {
    comparison = compare(readResult(result), readResult(baseline), limit);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  console.log(formatComparison(comparison));
  return comparison.ok ? 0 : 1;
}

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  try {
    if (command === 'clean') {
      options(rest, []);
      rmSync(RAW_DIR, { recursive: true, force: true });
      return 0;
    }
    if (command === 'collect') return collect(rest);
    if (command === 'compare') return runCompare(rest);
    throw new UsageError(`unknown command ${command ?? '(none)'}`);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`bench: ${error.message}`);
    console.error('usage: node test/bench/cli.ts clean | collect [--out <file>] | compare [--result <file>] [--baseline <file>] [--tolerance <fraction>]');
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
