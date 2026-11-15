/**
 * A stored run: what one rubric said about one set of outputs, as a file.
 *
 * The gate and the HTML report read this format and nothing else, so they
 * work the same for a judged run and for a run scored in code. A run names
 * its rubric and version, and holds one result per case and sample. A result
 * that could not be scored (a failed call, a refusal) stays in the file with
 * its status, because a run that drops its failures looks better than it is.
 *
 * Two ways to make one: `scoreItems` for a code rubric, from outputs and
 * their labelled expected values, and `judgedRuns` for a judge rubric, from
 * the blind pieces, the key and the verdicts.
 */
import { z } from 'zod';
import { joinVerdicts, wilson, type AggregateOptions } from './aggregate.ts';
import type { BlindKey, BlindPiece } from './blind.ts';
import { readJudged, RubricError, type CodeRubric, type JudgeRubric, type Outcome, type Table } from './rubric.ts';

export const RUN_FORMAT = 'evals-run/1';

const TableSchema = z.strictObject({
  title: z.string(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number()]))),
  note: z.string().optional(),
});

export const RunResult = z
  .strictObject({
    case: z.string().min(1),
    sample: z.number().int().min(1),
    /** "no-output" is a refusal or an empty reply; "failed" is a call that never returned. */
    status: z.enum(['scored', 'no-output', 'failed']),
    /** Null exactly when there was nothing to score. */
    pass: z.boolean().nullable(),
    metrics: z.record(z.string(), z.number()),
    /** What the model was asked, when the run kept it. */
    input: z.string().optional(),
    /** What the model produced. Never trusted: every reader escapes it. */
    output: z.string().optional(),
    /** The rubric's one-line reason, for a person. */
    detail: z.string().optional(),
    /** Several judges, and they did not agree on pass or fail. */
    split: z.boolean().optional(),
  })
  .refine((r) => (r.status === 'scored') === (r.pass !== null), { message: 'pass must be set exactly when status is "scored"' });
export type RunResult = z.infer<typeof RunResult>;

/**
 * The index of the first result that repeats an earlier (case, sample) pair,
 * or -1. A run holds one result per pair: a repeat (two runs concatenated, a
 * variant listed twice) would count twice in the gate and once in the report.
 */
export function repeatedResult(results: readonly Pick<RunResult, 'case' | 'sample'>[]): number {
  const seen = new Set<string>();
  return results.findIndex((r) => {
    const id = `${r.case}\0${r.sample}`;
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  });
}

export const StoredRun = z
  .strictObject({
    format: z.literal(RUN_FORMAT),
    rubric: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
    /** Which side this is: a variant id, a branch, a model name. */
    label: z.string().min(1),
    results: z.array(RunResult),
    tables: z.array(TableSchema),
  })
  .superRefine((run, ctx) => {
    const i = repeatedResult(run.results);
    if (i >= 0) {
      const r = run.results[i]!;
      ctx.addIssue({ code: 'custom', path: ['results', i], message: `case ${JSON.stringify(r.case)} sample ${r.sample} appears twice` });
    }
  });
export type StoredRun = z.infer<typeof StoredRun>;

export class RunError extends Error {
  override name = 'RunError';
}

/** Validates a run read from disk. `what` names the file in the error. */
export function parseRun(raw: unknown, what = 'run'): StoredRun {
  const parsed = StoredRun.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RunError(`${what} is not a stored run (${RUN_FORMAT}): ${issue?.path.join('.') || 'root'}: ${issue?.message}`);
  }
  return parsed.data;
}

/** Code-unit order, so the same run sorts the same on every machine and locale. */
export const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const sortResults = (results: RunResult[]) => results.sort((a, b) => byCodeUnit(a.case, b.case) || a.sample - b.sample);

function checkedOutcome(outcome: Outcome, where: string): Outcome {
  for (const [name, value] of Object.entries(outcome.metrics)) {
    if (!Number.isFinite(value)) throw new RubricError(`${where}: metric "${name}" is ${value}; a metric must be a finite number`);
  }
  return outcome;
}

const Item = z.strictObject({
  case: z.string().min(1),
  sample: z.number().int().min(1).optional(),
  input: z.string().optional(),
  output: z.string().optional(),
  /** Set in place of `output` when the call failed. The item is kept and counted as failed. */
  error: z.string().optional(),
  expected: z.unknown(),
});

/**
 * Scores outputs with a code rubric. Each item is `{ case, output, expected }`,
 * with an optional `sample` (numbered per case in file order when absent) and
 * `input`. An item with `error` and no `output` is a failed call.
 */
export function scoreItems<V extends object, E>(rubric: CodeRubric<V, E>, label: string, items: readonly unknown[]): StoredRun {
  const results: RunResult[] = [];
  const verdicts: V[] = [];
  const nextSample = new Map<string, number>();
  const seen = new Set<string>();
  items.forEach((raw, i) => {
    const parsedItem = Item.safeParse(raw);
    if (!parsedItem.success) {
      const issue = parsedItem.error.issues[0];
      throw new RunError(`item ${i + 1}: ${issue?.path.join('.') || 'root'}: ${issue?.message}`);
    }
    const item = parsedItem.data;
    const where = `item ${i + 1} (case ${item.case})`;
    const sample = item.sample ?? (nextSample.get(item.case) ?? 0) + 1;
    nextSample.set(item.case, Math.max(sample, nextSample.get(item.case) ?? 0));
    const id = `${item.case}\0${sample}`;
    if (seen.has(id)) throw new RunError(`${where}: sample ${sample} appears twice`);
    seen.add(id);
    const expected = rubric.expected.safeParse(item.expected);
    if (!expected.success) throw new RunError(`${where}: expected: ${expected.error.issues[0]?.message}`);
    const base = { case: item.case, sample, ...(item.input === undefined ? {} : { input: item.input }) };
    if (item.output === undefined) {
      if (item.error === undefined) throw new RunError(`${where}: needs "output", or "error" for a call that failed`);
      results.push({ ...base, status: 'failed', pass: null, metrics: {}, detail: item.error });
      return;
    }
    const verdict = rubric.verdict.safeParse(rubric.score(item.output, expected.data));
    if (!verdict.success) throw new RubricError(`${where}: the rubric produced a verdict of the wrong shape: ${verdict.error.issues[0]?.message}`);
    rubric.complete?.(verdict.data, expected.data);
    const outcome = checkedOutcome(rubric.reduce(verdict.data), where);
    const detail = rubric.describe?.(verdict.data);
    verdicts.push(verdict.data);
    results.push({ ...base, status: 'scored', pass: outcome.pass, metrics: outcome.metrics, output: item.output, ...(detail ? { detail } : {}) });
  });
  return { format: RUN_FORMAT, rubric: { name: rubric.name, version: rubric.version }, label, results: sortResults(results), tables: rubric.tables?.(verdicts) ?? [] };
}

const median = (values: number[]) => {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
};

/**
 * One stored run per variant, from a judged eval. Every refusal of
 * `joinVerdicts` applies, so a run with a lost judge or a missing piece does
 * not become a file.
 *
 * With several judges, a piece fails on a strict majority of failing
 * verdicts, the same rule as `consensus`, and each metric is the median
 * across judges. A case is named `<case>/<lang>`: the same brief in another
 * language is another case.
 */
export function judgedRuns<V extends object>(
  rubric: JudgeRubric<V>,
  pieces: readonly BlindPiece[],
  key: BlindKey,
  verdicts: readonly unknown[],
  opts: AggregateOptions = {},
): StoredRun[] {
  const { entries, byId, pieceById } = joinVerdicts(pieces, key, verdicts, opts, {
    read: (raw) => readJudged(rubric, raw),
    check: (v, p) => rubric.complete?.(v, { case: p.case, lang: p.lang, now: p.now, brief: p.brief, text: p.text }),
  });
  const runs = new Map<string, { results: RunResult[]; verdicts: V[] }>();
  for (const [id, entry] of entries) {
    const run = runs.get(entry.variant) ?? { results: [], verdicts: [] };
    runs.set(entry.variant, run);
    const base = { case: `${entry.case}/${entry.lang}`, sample: entry.sample };
    if (entry.withheld) {
      run.results.push({ ...base, status: entry.withheld === 'failed' ? 'failed' : 'no-output', pass: null, metrics: {}, detail: entry.withheld });
      continue;
    }
    const piece = pieceById.get(id)!;
    const judged = byId.get(id)!.slice().sort((a, b) => a.judge - b.judge);
    const outcomes = judged.map((v) => checkedOutcome(rubric.reduce(v), `piece ${id} judge ${v.judge}`));
    const fails = outcomes.filter((o) => !o.pass).length;
    const metrics: Record<string, number> = {};
    for (const name of Object.keys(outcomes[0]!.metrics).sort(byCodeUnit)) {
      metrics[name] = median(outcomes.map((o) => o.metrics[name] ?? NaN).filter((x) => !Number.isNaN(x)));
    }
    const reasons = judged
      .map((v, i) => ({ judge: v.judge, failed: !outcomes[i]!.pass, text: rubric.describe?.(v) ?? '' }))
      .filter((r) => r.failed && r.text !== '')
      .map((r) => (judged.length > 1 ? `judge ${r.judge}: ${r.text}` : r.text));
    run.verdicts.push(...judged);
    run.results.push({
      ...base,
      status: 'scored',
      pass: !(fails * 2 > outcomes.length),
      metrics,
      input: piece.brief,
      output: piece.text,
      ...(reasons.length ? { detail: reasons.join(' | ') } : {}),
      ...(fails !== 0 && fails !== outcomes.length ? { split: true } : {}),
    });
  }
  return [...runs]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([variant, run]) => ({
      format: RUN_FORMAT,
      rubric: { name: rubric.name, version: rubric.version },
      label: variant,
      results: sortResults(run.results),
      tables: rubric.tables?.(run.verdicts) ?? [],
    }));
}

export type RunSummary = {
  label: string;
  /** Every result, scored or not. */
  total: number;
  /** The denominator of the pass rate. */
  scored: number;
  passes: number;
  /** NaN when nothing was scored. */
  rate: number;
  /** 95% Wilson interval of the pass rate. */
  ci: [number, number];
  noOutput: number;
  failed: number;
  split: number;
  /** Mean of each metric over the scored results that carry it, by name. */
  metrics: Record<string, number>;
};

export function summarize(run: StoredRun): RunSummary {
  const scored = run.results.filter((r) => r.status === 'scored');
  const passes = scored.filter((r) => r.pass === true).length;
  const sums = new Map<string, { sum: number; n: number }>();
  for (const r of scored) {
    for (const [name, value] of Object.entries(r.metrics)) {
      const s = sums.get(name) ?? { sum: 0, n: 0 };
      s.sum += value;
      s.n += 1;
      sums.set(name, s);
    }
  }
  const metrics: Record<string, number> = {};
  for (const name of [...sums.keys()].sort(byCodeUnit)) metrics[name] = sums.get(name)!.sum / sums.get(name)!.n;
  return {
    label: run.label,
    total: run.results.length,
    scored: scored.length,
    passes,
    rate: scored.length ? passes / scored.length : NaN,
    ci: wilson(passes, scored.length),
    noOutput: run.results.filter((r) => r.status === 'no-output').length,
    failed: run.results.filter((r) => r.status === 'failed').length,
    split: scored.filter((r) => r.split === true).length,
    metrics,
  };
}
