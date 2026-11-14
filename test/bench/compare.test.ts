import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { calibrate, CALIBRATION_VERSION, calibrationRound, median } from './calibration.ts';
import { BenchResult, buildResult, compare, formatComparison, type RawFolder } from './compare.ts';

const MACHINE = { node: '24.0.0', platform: 'linux', arch: 'x64', cpu: 'Fixture CPU', cores: 4 };
const DATE = '2026-11-14T00:00:00.000Z';

const raw = (p50: number) => ({ latency: { p50, mean: p50 * 1.1, rme: 2.345, samplesCount: 100 } });
const folder = (name: string, calibrationMs: number, benches: Record<string, number>): RawFolder => ({
  folder: name,
  calibration: { version: CALIBRATION_VERSION, medianMs: calibrationMs },
  benches: Object.fromEntries(Object.entries(benches).map(([bench, p50]) => [bench, raw(p50)])),
});

/** A result with the given ratios, measured against a 4 ms calibration. */
const resultWith = (ratios: Record<string, number>, calibrationMs = 4): BenchResult =>
  buildResult([folder('lib', calibrationMs, Object.fromEntries(Object.entries(ratios).map(([name, ratio]) => [name, ratio * calibrationMs])))], MACHINE, DATE);

describe('buildResult', () => {
  it('stores each bench under folder/name with its ratio to the calibration of its own folder', () => {
    const result = buildResult([folder('slow-lib', 4, { parse: 2 }), folder('fast-lib', 8, { render: 2, lint: 12 })], MACHINE, DATE);
    expect(Object.keys(result.benches)).toEqual(['fast-lib/lint', 'fast-lib/render', 'slow-lib/parse']);
    expect(result.benches['slow-lib/parse']).toEqual({ medianMs: 2, meanMs: 2.2, rmePercent: 2.35, samples: 100, calibrationMs: 4, ratio: 0.5 });
    expect(result.benches['fast-lib/render']?.ratio).toBe(0.25);
    expect(result.benches['fast-lib/lint']?.ratio).toBe(1.5);
    expect(BenchResult.parse(result)).toEqual(result);
  });

  it('refuses a calibration measured by another version of the loop, and an empty run', () => {
    expect(() => buildResult([{ ...folder('lib', 4, { parse: 2 }), calibration: { version: CALIBRATION_VERSION + 1, medianMs: 4 } }], MACHINE, DATE)).toThrow(/calibration version/);
    expect(() => buildResult([], MACHINE, DATE)).toThrow(/no bench results/);
  });
});

describe('compare', () => {
  const baseline = resultWith({ parse: 1, render: 2 });

  it('the same ratios on a machine twice as slow pass: milliseconds are not compared', () => {
    const slower = resultWith({ parse: 1, render: 2 }, 8);
    expect(slower.benches['lib/parse']?.medianMs).toBe(2 * (baseline.benches['lib/parse']?.medianMs ?? 0));
    const comparison = compare(slower, baseline);
    expect(comparison.ok).toBe(true);
    expect(comparison.rows.map((r) => r.status)).toEqual(['ok', 'ok']);
  });

  it('a ratio above baseline x (1 + tolerance) is a regression; exactly at the limit passes', () => {
    expect(compare(resultWith({ parse: 1.5, render: 2 }), baseline, 0.5).ok).toBe(true);
    const over = compare(resultWith({ parse: 1.51, render: 2 }), baseline, 0.5);
    expect(over.ok).toBe(false);
    expect(over.rows).toEqual([
      { name: 'lib/parse', status: 'regression', baselineRatio: 1, ratio: 1.51, change: expect.closeTo(0.51, 10) },
      { name: 'lib/render', status: 'ok', baselineRatio: 2, ratio: 2, change: 0 },
    ]);
  });

  it('the tolerance is the caller’s: the same result passes at 0.6 and fails at 0.2', () => {
    const result = resultWith({ parse: 1.3, render: 2 });
    expect(compare(result, baseline, 0.6).ok).toBe(true);
    expect(compare(result, baseline, 0.2).ok).toBe(false);
  });

  it('a bench much faster than the baseline does not fail, and says the baseline is stale', () => {
    const comparison = compare(resultWith({ parse: 0.4, render: 2 }), baseline, 0.5);
    expect(comparison.ok).toBe(true);
    expect(comparison.rows[0]).toMatchObject({ status: 'faster' });
    expect(formatComparison(comparison)).toContain('record a new baseline');
  });

  it('a baseline bench that did not run fails; a bench the baseline lacks does not', () => {
    const missing = compare(resultWith({ parse: 1 }), baseline);
    expect(missing.ok).toBe(false);
    expect(missing.rows).toContainEqual({ name: 'lib/render', status: 'missing', baselineRatio: 2, ratio: null, change: null });

    const added = compare(resultWith({ parse: 1, render: 2, lint: 9 }), baseline);
    expect(added.ok).toBe(true);
    expect(added.rows).toContainEqual({ name: 'lib/lint', status: 'new', baselineRatio: null, ratio: 9, change: null });
  });

  it('refuses ratios taken against different calibration loops, and a tolerance that is not positive', () => {
    expect(() => compare({ ...resultWith({ parse: 1 }), calibrationVersion: CALIBRATION_VERSION + 1 }, baseline)).toThrow(/not comparable/);
    expect(() => compare(baseline, baseline, 0)).toThrow(/tolerance/);
    expect(() => compare(baseline, baseline, Number.NaN)).toThrow(/tolerance/);
  });

  it('the report names every bench, its change and the verdict', () => {
    const text = formatComparison(compare(resultWith({ parse: 1.8, render: 2.1 }), baseline, 0.5));
    expect(text).toMatch(/lib\/parse\s+1\.0000\s+1\.8000\s+\+80\.0%\s+regression/);
    expect(text).toMatch(/lib\/render\s+2\.0000\s+2\.1000\s+\+5\.0%\s+ok/);
    expect(text).toContain('FAILED: 1 of 2 benches');
    expect(formatComparison(compare(baseline, baseline))).toContain('OK: no bench is more than +50.0% above its baseline ratio.');
  });
});

describe('the calibration loop', () => {
  it('does the same work every round: the checksum is pinned', () => {
    // If this number changes, the loop changed: bump CALIBRATION_VERSION and record a new baseline.
    expect(calibrationRound()).toBe(calibrationRound());
    expect(calibrationRound()).toBe(CHECKSUM);
  });

  it('reports the median of its rounds, so one slow round does not move it', () => {
    expect(median([1, 2, 300])).toBe(2);
    expect(median([1, 2, 4, 300])).toBe(3);
    // A clock that advances 1 ms per read, except one round that takes 500 ms.
    let t = 0;
    let reads = 0;
    const clock = () => {
      reads += 1;
      t += reads === 4 ? 500 : 1;
      return t;
    };
    expect(calibrate(clock)).toMatchObject({ version: CALIBRATION_VERSION, medianMs: 1, minMs: 1, maxMs: 500, rounds: 101 });
  });
});

describe('the committed baseline', () => {
  it('is a valid result of the current calibration loop', () => {
    const baseline = BenchResult.parse(JSON.parse(readFileSync(new URL('./baseline.json', import.meta.url), 'utf8')));
    expect(baseline.calibrationVersion).toBe(CALIBRATION_VERSION);
    expect(Object.keys(baseline.benches)).toEqual([
      'amount-parser/parse-corpus',
      'gateway/concurrent-50-at-cap',
      'gateway/concurrent-50-under-cap',
      'safe-markdown/render-long-reply',
      'slop-lint/lint-long-en',
      'slop-lint/lint-long-es',
    ]);
  });
});

describe('cli.ts compare', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-compare-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const write = (name: string, value: unknown): string => {
    const file = join(dir, name);
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: dir });
  const baseline = write('baseline.json', resultWith({ parse: 1, render: 2 }));

  it('exits 0 when every bench is within the tolerance', () => {
    const out = run('compare', '--result', write('same.json', resultWith({ parse: 1.2, render: 2 }, 9)), '--baseline', baseline);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('OK:');
  });

  it('exits 1 on a regression beyond the tolerance, and names the bench', () => {
    const slow = write('slow.json', resultWith({ parse: 1.2, render: 2 }));
    const out = run('compare', '--result', slow, '--baseline', baseline, '--tolerance', '0.1');
    expect(out.status).toBe(1);
    expect(out.stdout).toMatch(/lib\/parse.*regression/);
    expect(out.stdout).toContain('FAILED: 1 of 2 benches');
  });

  it('exits 2 on a file that is missing or not a result, and on bad arguments', () => {
    expect(run('compare', '--result', join(dir, 'nowhere.json'), '--baseline', baseline).status).toBe(2);
    const broken = run('compare', '--result', write('broken.json', { schema: 1 }), '--baseline', baseline);
    expect(broken.status).toBe(2);
    expect(broken.stderr).toContain('is not a bench result');
    expect(run('compare', '--result', baseline, '--baseline', baseline, '--tolerance', 'lots').status).toBe(2);
    expect(run('compare', '--fast').status).toBe(2);
    expect(run('measure').status).toBe(2);
  });
});

/** calibrationRound() for CALIBRATION_VERSION 1. */
const CHECKSUM = 482_382;
