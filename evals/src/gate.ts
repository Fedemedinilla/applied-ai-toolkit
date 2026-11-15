/**
 * The CI gate: is the candidate run worse than the baseline run?
 *
 * The rule works on the difference d = candidate pass rate - baseline pass
 * rate, with a 95% interval for d built from the two Wilson intervals
 * (Newcombe's hybrid score interval, 1998):
 *
 *   lower = d - sqrt((pc - lc)^2 + (ub - pb)^2)
 *   upper = d + sqrt((uc - pc)^2 + (pb - lb)^2)
 *
 * - fail: upper < 0. The whole interval is below zero: the candidate is
 *   worse.
 * - pass: lower >= -margin. Even at the bad end of the interval, the drop is
 *   smaller than the margin the caller accepts.
 * - inconclusive: neither. The data allows both "no change" and "a drop
 *   larger than the margin". It has its own exit code and is never folded
 *   into pass or fail.
 *
 * Fail is checked first, so a run that is measurably worse fails even when
 * the drop is inside the margin.
 *
 * Why not "fail when the two intervals do not overlap": that rule adds the
 * two half-widths where this one combines them in quadrature, so it needs a
 * larger gap to call the same difference and lets real regressions through.
 * Every pair the overlap rule fails, this rule fails too.
 *
 * The two runs are treated as independent samples. When both ran the same
 * cases the outcomes are usually correlated, which makes the true interval
 * narrower than this one, so the gate errs towards "inconclusive".
 */
import { wilson } from './aggregate.ts';
import { byCodeUnit, repeatedResult, summarize, type RunSummary, type StoredRun } from './run.ts';

export type GateState = 'pass' | 'fail' | 'inconclusive';

/** Exit codes of the gate. 2 is the folder's code for "could not run": bad usage or runs that cannot be compared. */
export const GATE_EXIT = { pass: 0, fail: 1, refused: 2, inconclusive: 3 } as const;

export const DEFAULT_MARGIN = 0.1;

export class GateRefusal extends Error {
  override name = 'GateRefusal';
}

export type GateOptions = {
  /** The largest drop in pass rate that still counts as "not worse", as a fraction. Default 0.1. */
  margin?: number;
  /** Compare runs that hold failed calls or outputs with nothing to score. They stay out of the rates and are reported. */
  allowMissing?: boolean;
};

export type GateResult = {
  state: GateState;
  exitCode: number;
  reason: string;
  rubric: { name: string; version: string };
  margin: number;
  baseline: RunSummary;
  candidate: RunSummary;
  /** Candidate minus baseline pass rate, with its 95% interval. */
  difference: { estimate: number; lower: number; upper: number };
  /** Cases where the candidate passed fewer samples than the baseline, largest drop first. */
  regressions: { case: string; baseline: string; candidate: string }[];
};

/** 95% interval of p2 - p1 for k1 of n1 against k2 of n2, from the two Wilson intervals. */
export function differenceInterval(k1: number, n1: number, k2: number, n2: number): { estimate: number; lower: number; upper: number } {
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const [l1, u1] = wilson(k1, n1);
  const [l2, u2] = wilson(k2, n2);
  const d = p2 - p1;
  return {
    estimate: d,
    lower: Math.max(-1, d - Math.sqrt((p2 - l2) ** 2 + (u1 - p1) ** 2)),
    upper: Math.min(1, d + Math.sqrt((u2 - p2) ** 2 + (p1 - l1) ** 2)),
  };
}

/** The decision for bare counts. `gate` adds the comparability checks around it. */
export function decide(baselinePasses: number, baselineN: number, candidatePasses: number, candidateN: number, margin = DEFAULT_MARGIN): GateState {
  const d = differenceInterval(baselinePasses, baselineN, candidatePasses, candidateN);
  if (d.upper < 0) return 'fail';
  return d.lower >= -margin ? 'pass' : 'inconclusive';
}

const points = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

function caseCounts(run: StoredRun): Map<string, { total: number; scored: number; passes: number }> {
  const counts = new Map<string, { total: number; scored: number; passes: number }>();
  for (const r of run.results) {
    const c = counts.get(r.case) ?? { total: 0, scored: 0, passes: 0 };
    c.total += 1;
    if (r.status === 'scored') c.scored += 1;
    if (r.pass === true) c.passes += 1;
    counts.set(r.case, c);
  }
  return counts;
}

const some = (items: string[]) => items.slice(0, 5).join(', ') + (items.length > 5 ? `, ... (${items.length} in all)` : '');

/**
 * Compares two stored runs. Throws `GateRefusal` when they cannot be compared:
 * another rubric or version, a case and sample repeated within a run, other
 * cases, another number of samples for a case, nothing scored, or results
 * missing on either side.
 */
export function gate(baseline: StoredRun, candidate: StoredRun, opts: GateOptions = {}): GateResult {
  const margin = opts.margin ?? DEFAULT_MARGIN;
  if (!(margin >= 0 && margin < 1)) throw new GateRefusal(`margin must be a fraction from 0 to below 1, got ${margin}`);
  if (baseline.rubric.name !== candidate.rubric.name) {
    throw new GateRefusal(`the runs use different rubrics: baseline ${baseline.rubric.name}, candidate ${candidate.rubric.name}`);
  }
  if (baseline.rubric.version !== candidate.rubric.version) {
    throw new GateRefusal(`the runs use different versions of ${baseline.rubric.name}: baseline "${baseline.rubric.version}", candidate "${candidate.rubric.version}"`);
  }
  for (const [side, run] of [['baseline', baseline], ['candidate', candidate]] as const) {
    const i = repeatedResult(run.results);
    if (i >= 0) throw new GateRefusal(`the ${side} holds ${run.results[i]!.case} sample ${run.results[i]!.sample} twice; a run has one result per case and sample`);
  }
  const b = caseCounts(baseline);
  const c = caseCounts(candidate);
  const onlyBaseline = [...b.keys()].filter((k) => !c.has(k)).sort(byCodeUnit);
  const onlyCandidate = [...c.keys()].filter((k) => !b.has(k)).sort(byCodeUnit);
  if (onlyBaseline.length || onlyCandidate.length) {
    const parts = [
      ...(onlyBaseline.length ? [`only in the baseline: ${some(onlyBaseline)}`] : []),
      ...(onlyCandidate.length ? [`only in the candidate: ${some(onlyCandidate)}`] : []),
    ];
    throw new GateRefusal(`the runs cover different cases (${parts.join('; ')})`);
  }
  const uneven = [...b.keys()].filter((k) => b.get(k)!.total !== c.get(k)!.total).sort(byCodeUnit);
  if (uneven.length) {
    throw new GateRefusal(`the runs have a different number of samples for ${uneven.length} case(s): ${some(uneven.map((k) => `${k} (${b.get(k)!.total} and ${c.get(k)!.total})`))}`);
  }
  const sb = summarize(baseline);
  const sc = summarize(candidate);
  for (const [side, s] of [['baseline', sb], ['candidate', sc]] as const) {
    if (s.scored === 0) throw new GateRefusal(`the ${side} has no scored result`);
    if (!opts.allowMissing && s.failed + s.noOutput > 0) {
      throw new GateRefusal(`the ${side} has ${s.failed} failed call(s) and ${s.noOutput} output(s) with nothing to score; rerun, or pass --allow-missing to compare the rest`);
    }
  }

  const difference = differenceInterval(sb.passes, sb.scored, sc.passes, sc.scored);
  const state = decide(sb.passes, sb.scored, sc.passes, sc.scored, margin);
  const range = `${points(difference.lower)} to ${points(difference.upper)} points`;
  const reason =
    state === 'fail'
      ? `the candidate is worse: the whole 95% interval of the difference (${range}) is below zero`
      : state === 'pass'
        ? `the candidate is not worse: the 95% interval of the difference (${range}) rules out a drop of more than ${points(margin).slice(1)} points`
        : `not enough data: the 95% interval of the difference (${range}) includes both zero and a drop of more than ${points(margin).slice(1)} points`;
  const regressions = [...b.keys()]
    .map((k) => ({ k, drop: b.get(k)!.passes - c.get(k)!.passes }))
    .filter((x) => x.drop > 0)
    .sort((x, y) => y.drop - x.drop || byCodeUnit(x.k, y.k))
    .map(({ k }) => ({ case: k, baseline: `${b.get(k)!.passes}/${b.get(k)!.scored}`, candidate: `${c.get(k)!.passes}/${c.get(k)!.scored}` }));
  return { state, exitCode: GATE_EXIT[state], reason, rubric: baseline.rubric, margin, baseline: sb, candidate: sc, difference, regressions };
}

const side = (s: RunSummary) => `${s.passes}/${s.scored} pass, ${pct(s.rate)} (${pct(s.ci[0])} to ${pct(s.ci[1])})`;
const missing = (s: RunSummary) => (s.failed + s.noOutput ? `, ${s.failed} failed, ${s.noOutput} with no output` : '');

export function gateText(r: GateResult): string {
  return [
    `gate: ${r.state.toUpperCase()} (exit ${r.exitCode})`,
    r.reason,
    `rubric     ${r.rubric.name} ${r.rubric.version}`,
    `baseline   ${r.baseline.label}: ${side(r.baseline)}${missing(r.baseline)}`,
    `candidate  ${r.candidate.label}: ${side(r.candidate)}${missing(r.candidate)}`,
    `difference ${points(r.difference.estimate)} points (${points(r.difference.lower)} to ${points(r.difference.upper)}), margin ${points(r.margin).slice(1)}`,
    ...(r.regressions.length ? [`cases that got worse (${r.regressions.length}): ${some(r.regressions.map((x) => `${x.case} ${x.baseline} -> ${x.candidate}`))}`] : []),
  ].join('\n');
}

/** Case ids and labels come from files: keep them from breaking a table or opening a tag. */
const cell = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/[`*_[\]]/g, '\\$&').replace(/\s+/g, ' ');

/** A summary for a pull request comment or $GITHUB_STEP_SUMMARY. */
export function gateMarkdown(r: GateResult): string {
  const row = (name: string, s: RunSummary) =>
    `| ${name} | ${cell(s.label)} | ${s.passes}/${s.scored} | ${pct(s.rate)} | ${pct(s.ci[0])} to ${pct(s.ci[1])} | ${s.failed + s.noOutput} |`;
  const shown = r.regressions.slice(0, 20);
  return [
    `### Eval gate: ${r.state}`,
    '',
    `${r.reason[0]!.toUpperCase()}${r.reason.slice(1)}.`,
    '',
    '| run | label | passed | rate | 95% CI | not scored |',
    '|---|---|---:|---:|---|---:|',
    row('baseline', r.baseline),
    row('candidate', r.candidate),
    '',
    `Difference: ${points(r.difference.estimate)} points (${points(r.difference.lower)} to ${points(r.difference.upper)}). Margin: ${points(r.margin).slice(1)} points. Rubric: ${cell(r.rubric.name)} ${cell(r.rubric.version)}.`,
    ...(shown.length
      ? ['', `Cases that got worse (${r.regressions.length}):`, '', '| case | baseline | candidate |', '|---|---:|---:|', ...shown.map((x) => `| ${cell(x.case)} | ${x.baseline} | ${x.candidate} |`), ...(r.regressions.length > shown.length ? ['', `${r.regressions.length - shown.length} more in the report.`] : [])]
      : []),
    '',
  ].join('\n');
}
