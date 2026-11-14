import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { wilson } from '../src/aggregate.ts';
import { decide, differenceInterval, gate, GATE_EXIT, gateMarkdown, GateRefusal, gateText } from '../src/gate.ts';
import { RUN_FORMAT, type RunResult, type StoredRun } from '../src/run.ts';

/** A run of `cases` cases with one sample each, the first `passes` of them passing. */
function run(label: string, passes: number, cases: number, extra: Partial<StoredRun> = {}): StoredRun {
  const results: RunResult[] = Array.from({ length: cases }, (_, i) => ({
    case: `case-${String(i + 1).padStart(3, '0')}`,
    sample: 1,
    status: 'scored',
    pass: i < passes,
    metrics: {},
  }));
  return { format: RUN_FORMAT, rubric: { name: 'classification', version: '1 single [a, b]' }, label, results, tables: [], ...extra };
}

describe('the interval of the difference', () => {
  it('matches Newcombe\'s worked example (56/70 against 48/80)', () => {
    // Newcombe 1998, method 10: 0.2 with 95% interval 0.0524 to 0.3339.
    const d = differenceInterval(48, 80, 56, 70);
    expect(d.estimate).toBeCloseTo(0.2, 10);
    expect(d.lower).toBeCloseTo(0.0524, 3);
    expect(d.upper).toBeCloseTo(0.3339, 3);
  });

  it('is antisymmetric and contains zero for equal runs', () => {
    const d = differenceInterval(36, 40, 24, 40);
    const back = differenceInterval(24, 40, 36, 40);
    expect(back.lower).toBeCloseTo(-d.upper, 12);
    expect(back.upper).toBeCloseTo(-d.lower, 12);
    const same = differenceInterval(30, 40, 30, 40);
    expect(same.lower).toBeLessThan(0);
    expect(same.upper).toBeGreaterThan(0);
  });
});

describe('the decision rule', () => {
  it('fails when the whole interval is below zero', () => {
    expect(decide(36, 40, 24, 40)).toBe('fail');
    expect(decide(10, 10, 0, 10)).toBe('fail');
  });

  it('passes when the interval rules out a drop larger than the margin, including a better candidate', () => {
    expect(decide(180, 200, 178, 200)).toBe('pass');
    expect(decide(24, 40, 36, 40)).toBe('pass');
    expect(decide(180, 200, 178, 200, 0.02)).toBe('inconclusive');
  });

  it('is inconclusive on small samples, even with identical results', () => {
    expect(decide(10, 10, 10, 10)).toBe('inconclusive');
    expect(decide(36, 40, 35, 40)).toBe('inconclusive');
    expect(decide(0, 14, 0, 14)).toBe('inconclusive');
  });

  it('fails a measurable drop even when it is inside the margin', () => {
    expect(differenceInterval(1000, 1000, 960, 1000).estimate).toBeGreaterThan(-0.1);
    expect(decide(1000, 1000, 960, 1000)).toBe('fail');
  });

  it('needs the sample sizes the README states', () => {
    // Equal observed rates: the smallest round sizes at which "no change" is a pass at the default margin.
    expect([decide(72, 80, 72, 80), decide(36, 40, 36, 40)]).toEqual(['pass', 'inconclusive']);
    expect([decide(100, 200, 100, 200), decide(50, 100, 50, 100)]).toEqual(['pass', 'inconclusive']);
    // A drop from 90% to 70% is caught at 40 per run and not at 20.
    expect([decide(36, 40, 28, 40), decide(18, 20, 14, 20)]).toEqual(['fail', 'inconclusive']);
    // A drop from 90% to 80% needs more than 100 per run.
    expect([decide(108, 120, 96, 120), decide(72, 80, 64, 80)]).toEqual(['fail', 'inconclusive']);
  });

  it('fails every pair the "intervals do not overlap" rule fails', () => {
    let disjoint = 0;
    for (const n of [5, 12, 30, 75, 200]) {
      for (let kb = 0; kb <= n; kb++) {
        for (let kc = 0; kc <= n; kc++) {
          if (wilson(kc, n)[1] < wilson(kb, n)[0]) {
            disjoint++;
            expect(decide(kb, n, kc, n)).toBe('fail');
          }
        }
      }
    }
    expect(disjoint).toBeGreaterThan(1000);
    // And it catches a drop the overlap rule lets through: 90% to 70% at 40 per run.
    expect(wilson(28, 40)[1]).toBeGreaterThan(wilson(36, 40)[0]);
    expect(decide(36, 40, 28, 40)).toBe('fail');
  });
});

describe('gate', () => {
  it('reports each state with its exit code, the two rates and the difference', () => {
    const fail = gate(run('main', 36, 40), run('pr', 24, 40));
    expect(fail).toMatchObject({ state: 'fail', exitCode: 1, margin: 0.1, rubric: { name: 'classification' } });
    expect(fail.baseline).toMatchObject({ label: 'main', passes: 36, scored: 40 });
    expect(fail.candidate).toMatchObject({ label: 'pr', passes: 24, scored: 40 });
    expect(fail.difference.estimate).toBeCloseTo(-0.3);
    expect(fail.regressions).toHaveLength(12);
    expect(fail.regressions[0]).toEqual({ case: 'case-025', baseline: '1/1', candidate: '0/1' });
    expect(gate(run('main', 180, 200), run('pr', 178, 200))).toMatchObject({ state: 'pass', exitCode: 0 });
    expect(gate(run('main', 36, 40), run('pr', 35, 40))).toMatchObject({ state: 'inconclusive', exitCode: 3 });
    expect(GATE_EXIT).toEqual({ pass: 0, fail: 1, refused: 2, inconclusive: 3 });
  });

  it('never words an inconclusive result as a pass or a fail', () => {
    const r = gate(run('main', 36, 40), run('pr', 35, 40));
    expect(gateText(r).split('\n')[0]).toBe('gate: INCONCLUSIVE (exit 3)');
    expect(gateMarkdown(r).split('\n')[0]).toBe('### Eval gate: inconclusive');
    for (const out of [gateText(r), gateMarkdown(r)]) {
      expect(out).toMatch(/not enough data/i);
      expect(out).not.toMatch(/gate: (PASS|FAIL)|is worse|is not worse/i);
    }
  });

  it('refuses another rubric, another version, other cases and uneven samples', () => {
    const base = run('main', 30, 40);
    expect(() => gate(base, run('pr', 30, 40, { rubric: { name: 'extraction', version: '1' } }))).toThrow(/different rubrics: baseline classification, candidate extraction/);
    expect(() => gate(base, run('pr', 30, 40, { rubric: { name: 'classification', version: '1 single [a, b, c]' } }))).toThrow(/different versions of classification/);
    expect(() => gate(base, run('pr', 30, 39))).toThrow(/different cases \(only in the baseline: case-040\)/);
    expect(() => gate(run('main', 30, 39), base)).toThrow(/only in the candidate: case-040/);
    const renamed = run('pr', 30, 40);
    renamed.results[0] = { ...renamed.results[0]!, case: 'other' };
    expect(() => gate(base, renamed)).toThrow(/only in the baseline: case-001; only in the candidate: other/);
    const twice = run('pr', 30, 40);
    twice.results.push({ ...twice.results[0]!, sample: 2 });
    expect(() => gate(base, twice)).toThrow(/different number of samples for 1 case\(s\): case-001 \(1 and 2\)/);
    expect(() => gate(base, twice)).toThrow(GateRefusal);
  });

  it('refuses missing results unless allowed, then keeps them out of the rates and in the report', () => {
    const cand = run('pr', 30, 40);
    cand.results[39] = { case: 'case-040', sample: 1, status: 'failed', pass: null, metrics: {}, detail: 'timeout' };
    cand.results[38] = { case: 'case-039', sample: 1, status: 'no-output', pass: null, metrics: {} };
    expect(() => gate(run('main', 30, 40), cand)).toThrow(/the candidate has 1 failed call\(s\) and 1 output\(s\) with nothing to score/);
    const r = gate(run('main', 30, 40), cand, { allowMissing: true });
    expect(r.candidate).toMatchObject({ scored: 38, passes: 30, failed: 1, noOutput: 1 });
    expect(gateText(r)).toContain('1 failed, 1 with no output');
    expect(gateMarkdown(r)).toContain('| candidate | pr | 30/38 | 79% | 64% to 89% | 2 |');
  });

  it('refuses a run with nothing scored and a margin out of range', () => {
    const empty = run('pr', 0, 2);
    empty.results = empty.results.map((r) => ({ ...r, status: 'failed' as const, pass: null }));
    expect(() => gate(run('main', 1, 2), empty, { allowMissing: true })).toThrow(/the candidate has no scored result/);
    for (const margin of [-0.1, 1, NaN]) expect(() => gate(run('a', 1, 2), run('b', 1, 2), { margin })).toThrow(/margin must be/);
  });

  it('prints text and Markdown with the rule\'s numbers', () => {
    const r = gate(run('main', 36, 40), run('pr', 24, 40));
    expect(gateText(r)).toBe(
      [
        'gate: FAIL (exit 1)',
        'the candidate is worse: the whole 95% interval of the difference (-46.5 to -11.1 points) is below zero',
        'rubric     classification 1 single [a, b]',
        'baseline   main: 36/40 pass, 90% (77% to 96%)',
        'candidate  pr: 24/40 pass, 60% (45% to 74%)',
        'difference -30.0 points (-46.5 to -11.1), margin 10.0',
        'cases that got worse (12): case-025 1/1 -> 0/1, case-026 1/1 -> 0/1, case-027 1/1 -> 0/1, case-028 1/1 -> 0/1, case-029 1/1 -> 0/1, ... (12 in all)',
      ].join('\n'),
    );
    const md = gateMarkdown(r);
    expect(md).toContain('### Eval gate: fail');
    expect(md).toContain('| baseline | main | 36/40 | 90% | 77% to 96% | 0 |');
    expect(md).toContain('Difference: -30.0 points (-46.5 to -11.1). Margin: 10.0 points.');
    expect(md).toContain('| case-025 | 1/1 | 0/1 |');
  });

  it('keeps a label or a case id from breaking the Markdown table or opening a tag', () => {
    const base = run('main | <img src=x onerror=alert(1)>', 36, 40);
    const cand = run('pr', 24, 40);
    for (const r of [base, cand]) r.results[30] = { ...r.results[30]!, case: 'a|b <script>alert(1)</script> `x`' };
    const md = gateMarkdown(gate(base, cand));
    expect(md).not.toMatch(/<(img|script)/);
    expect(md).toContain('main \\| &lt;img src=x onerror=alert(1)&gt;');
    expect(md).toContain('| a\\|b &lt;script&gt;alert(1)&lt;/script&gt; \\`x\\` | 1/1 | 0/1 |');
  });
});

describe('the gate script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evals-gate-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/gate.ts', import.meta.url));
  const file = (name: string, content: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
    return path;
  };
  const cli = (...args: string[]) => {
    // No key in the environment: the gate is offline and must not need one.
    const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const main = file('main.json', run('main', 36, 40));
  const big = file('big.json', run('main', 180, 200));

  it('exits 0 on pass, 1 on fail and 3 on inconclusive', () => {
    const pass = cli(big, file('pass.json', run('pr', 178, 200)));
    expect(pass).toMatchObject({ status: 0, stderr: '' });
    expect(pass.stdout).toMatch(/^gate: PASS \(exit 0\)\n/);
    const fail = cli(main, file('fail.json', run('pr', 24, 40)));
    expect(fail.status).toBe(1);
    expect(fail.stdout).toMatch(/^gate: FAIL \(exit 1\)\n/);
    const unsure = cli(main, file('unsure.json', run('pr', 35, 40)));
    expect(unsure.status).toBe(3);
    expect(unsure.stdout).toMatch(/^gate: INCONCLUSIVE \(exit 3\)\nnot enough data/);
  });

  it('exits 2 and says why when the runs cannot be compared or a file is not a run', () => {
    const other = cli(main, file('other.json', run('pr', 36, 40, { rubric: { name: 'extraction', version: '1' } })));
    expect(other.status).toBe(2);
    expect(other.stdout).toBe('');
    expect(other.stderr).toMatch(/^gate: REFUSED \(exit 2\)\nthe runs use different rubrics/);
    expect(cli(main, file('cases.json', run('pr', 36, 41))).status).toBe(2);
    const notRun = cli(main, file('rows.json', { rows: [] }));
    expect(notRun.status).toBe(2);
    expect(notRun.stderr).toMatch(/rows\.json is not a stored run/);
    expect(cli(main, file('broken.json', '{"format":')).status).toBe(2);
    expect(cli(main, join(dir, 'absent.json')).status).toBe(2);
    expect(cli(main).status).toBe(2);
    expect(cli(main, file('m.json', run('pr', 36, 40)), '--margin', 'ten').status).toBe(2);
  });

  it('prints JSON and Markdown, appends the summary file and honours the margin', () => {
    const cand = file('cand.json', run('pr', 24, 40));
    const json = cli(main, cand, '--json');
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ state: 'fail', exitCode: 1, baseline: { passes: 36 }, candidate: { passes: 24 } });
    const summary = file('summary.md', '# earlier step\n');
    const md = cli(main, cand, '--markdown', '--summary', summary);
    expect(md.status).toBe(1);
    expect(md.stdout).toContain('### Eval gate: fail');
    expect(readFileSync(summary, 'utf8')).toMatch(/^# earlier step\n### Eval gate: fail\n/);
    const near = file('near.json', run('pr', 178, 200));
    expect(cli(big, near, '--margin', '0.02').status).toBe(3);
  });
});
