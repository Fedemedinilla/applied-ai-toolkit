/**
 * Run reports and the prompt metric. Each generate run writes one report; `stats` reads them all
 * back and gives the pass rate per entity type and prompt version, with a 95% Wilson interval.
 *
 * The pass rate is accepted / requested. A candidate the model did not return counts as a
 * failure, and so does every candidate of a run whose response could not be used at all. Without
 * that, a prompt that makes the model return two of eight candidates would score 100%.
 *
 * Reports are read back from disk, so they go through zod like any other external input.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { reportsDir } from './files.ts';
import { ENTITY_NAMES } from './schemas.ts';

export const STAGES = ['schema', 'rules', 'references'] as const;
export type Stage = (typeof STAGES)[number];

const ReportProblem = z.strictObject({
  stage: z.enum(STAGES),
  where: z.string(),
  path: z.string(),
  message: z.string(),
  rule: z.string().optional(),
});

export const Rejection = z.strictObject({
  /** Position in the model's array. */
  index: z.int().min(0),
  id: z.string().nullable(),
  problems: z.array(ReportProblem).min(1),
});
export type Rejection = z.infer<typeof Rejection>;

export const RunReport = z
  .strictObject({
    run: z.string().min(1),
    /** The gateway's job id, which is also on the ledger rows of the call. */
    jobId: z.uuid(),
    entity: z.enum(ENTITY_NAMES),
    promptVersion: z.string().min(1),
    createdAt: z.iso.datetime(),
    model: z.string(),
    effort: z.string(),
    costUsd: z.number().min(0).nullable(),
    usageId: z.string(),
    /** A gateway response code when the response could not be used at all, otherwise null. */
    failure: z.string().nullable(),
    requested: z.int().min(1),
    returned: z.int().min(0),
    /** Candidates past the requested count, which are not judged. */
    ignored: z.int().min(0),
    accepted: z.array(z.string()),
    /** Accepted candidates whose file could not be written, with the error code. */
    unwritten: z.array(z.strictObject({ id: z.string(), error: z.string() })).default([]),
    passRate: z.number().min(0).max(1),
    rejections: z.array(Rejection),
  })
  .refine((r) => r.accepted.length + r.rejections.length === Math.min(r.returned, r.requested), {
    message: 'every judged candidate is either accepted or rejected',
  })
  .refine((r) => r.unwritten.every((u) => r.accepted.includes(u.id)), { path: ['unwritten'], message: 'only an accepted candidate can be unwritten' })
  .refine((r) => r.passRate === r.accepted.length / r.requested, { path: ['passRate'], message: 'passRate is accepted / requested' });
export type RunReport = z.infer<typeof RunReport>;

/** 95% Wilson score interval for k successes in n trials, as fractions. */
export function wilson(k: number, n: number, z95 = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const z2 = z95 * z95;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface VersionStats {
  readonly entity: string;
  readonly promptVersion: string;
  readonly runs: number;
  readonly failedRuns: number;
  readonly requested: number;
  readonly accepted: number;
  readonly passRate: number;
  readonly interval: readonly [number, number];
  /** How many rejected candidates had at least one problem in each stage. */
  readonly byStage: Readonly<Record<Stage, number>>;
  /** Rule ids by how many rejected candidates broke them, most first. */
  readonly topRules: readonly (readonly [string, number])[];
  readonly costUsd: number | null;
}

/** Pools runs of the same entity and prompt version. Runs of different versions never mix. */
export function summarize(reports: readonly RunReport[]): VersionStats[] {
  const groups = new Map<string, RunReport[]>();
  for (const r of reports) {
    const key = `${r.entity}\u0000${r.promptVersion}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: VersionStats[] = [];
  for (const runs of groups.values()) {
    const first = runs[0];
    if (!first) continue;
    const requested = runs.reduce((s, r) => s + r.requested, 0);
    const accepted = runs.reduce((s, r) => s + r.accepted.length, 0);
    const byStage: Record<Stage, number> = { schema: 0, rules: 0, references: 0 };
    const rules = new Map<string, number>();
    for (const rejection of runs.flatMap((r) => r.rejections)) {
      for (const stage of STAGES) if (rejection.problems.some((p) => p.stage === stage)) byStage[stage] += 1;
      for (const rule of new Set(rejection.problems.flatMap((p) => (p.rule ? [p.rule] : [])))) rules.set(rule, (rules.get(rule) ?? 0) + 1);
    }
    // A run with an unknown cost makes the total unknown, never a smaller number.
    const costs = runs.map((r) => r.costUsd);
    const costUsd = costs.every((c) => c !== null) ? costs.reduce((s: number, c) => s + (c ?? 0), 0) : null;
    out.push({
      entity: first.entity,
      promptVersion: first.promptVersion,
      runs: runs.length,
      failedRuns: runs.filter((r) => r.failure !== null).length,
      requested,
      accepted,
      passRate: accepted / requested,
      interval: wilson(accepted, requested),
      byStage,
      topRules: [...rules].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      costUsd,
    });
  }
  return out.sort((a, b) => a.entity.localeCompare(b.entity) || a.promptVersion.localeCompare(b.promptVersion));
}

export interface LoadedReports {
  readonly reports: RunReport[];
  /** Files that are not a valid report. They are listed, never counted. */
  readonly invalid: string[];
}

export async function loadReports(dir: string): Promise<LoadedReports> {
  const folder = reportsDir(dir);
  let files: string[];
  try {
    files = (await readdir(folder)).filter((f) => f.endsWith('.json')).sort();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { reports: [], invalid: [] };
    throw error;
  }
  const reports: RunReport[] = [];
  const invalid: string[] = [];
  for (const file of files) {
    let json: unknown;
    try {
      json = JSON.parse(await readFile(join(folder, file), 'utf8'));
    } catch {
      invalid.push(file);
      continue;
    }
    const parsed = RunReport.safeParse(json);
    if (parsed.success) reports.push(parsed.data);
    else invalid.push(file);
  }
  return { reports, invalid };
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

export function formatRun(r: RunReport): string[] {
  const lines = [
    `${r.entity} ${r.promptVersion}: ${r.accepted.length} of ${r.requested} accepted (${pct(r.passRate)}), ${r.returned} returned${r.ignored > 0 ? `, ${r.ignored} past the count ignored` : ''}`,
  ];
  if (r.failure !== null) lines.push(`  the response could not be used: ${r.failure}`);
  const missing = r.failure === null ? r.requested - Math.min(r.returned, r.requested) : 0;
  if (missing > 0) lines.push(`  ${missing} requested ${missing === 1 ? 'candidate was not returned and counts as a failure' : 'candidates were not returned and count as failures'}`);
  for (const id of r.accepted) {
    const failed = r.unwritten.find((u) => u.id === id);
    lines.push(failed ? `  accepted ${id}, but its file could not be written to _candidates/: ${failed.error}` : `  accepted ${id}`);
  }
  for (const rejection of r.rejections) {
    lines.push(`  rejected ${rejection.id ?? `candidate ${rejection.index + 1}`}`);
    for (const p of rejection.problems) lines.push(`    [${p.stage}${p.rule ? ` ${p.rule}` : ''}] ${p.where}: ${p.path === '' ? '' : `${p.path}: `}${p.message}`);
  }
  lines.push(`  model ${r.model}, cost ${r.costUsd === null ? 'unknown' : `US$${r.costUsd.toFixed(6)}`}, report ${r.run}.json`);
  return lines;
}

export function formatStats(stats: readonly VersionStats[]): string[] {
  if (stats.length === 0) return ['No reports yet.'];
  return stats.map((s) => {
    const [lo, hi] = s.interval;
    const rules = s.topRules.length === 0 ? '' : `; rules broken: ${s.topRules.map(([id, n]) => `${id} ${n}`).join(', ')}`;
    return `${s.entity} ${s.promptVersion}: ${s.accepted}/${s.requested} = ${pct(s.passRate)} (95% CI ${pct(lo)} to ${pct(hi)}) over ${s.runs} run(s), ${s.failedRuns} unusable; rejected at schema ${s.byStage.schema}, rules ${s.byStage.rules}, references ${s.byStage.references}${rules}`;
  });
}
