// The per-variant results of a writer eval run, from the rows file the runner wrote. report.ts is
// the command line around it. Every rate carries a 95% Wilson interval, and failed calls are counted
// in their own column, never dropped from a denominator in silence.

import { wilson } from '../../../evals/src/index.ts';
import { readJsonl } from '../../../evals/src/index.ts';
import { isFailure, type EvalFailure, type EvalRow } from '../../../evals/src/index.ts';
import type { WriterConfig } from '../src/config-schema.ts';
import { CASE_SETS } from './cases.ts';
import { scoreDraft } from './specifics.ts';
import { factSheet, type WriterEvalCase } from './target.ts';

export interface ScoreRow {
  readonly variant: string;
  readonly probe: WriterEvalCase['probe'];
  readonly pieces: number;
  readonly failed: number;
  readonly offProtocol: number;
  /** Pieces with at least one specific the fact sheet does not hold. */
  readonly invented: number;
  /** Pieces with at least one [COMPLETAR]. On complete briefs, a needless gap. */
  readonly withGaps: number;
  /** The unsupported specifics, for reading by hand. */
  readonly examples: readonly string[];
}

export function scoreRows(config: WriterConfig, rows: readonly (EvalRow | EvalFailure)[]): ScoreRow[] {
  const cases = new Map(CASE_SETS['all']!.map((c) => [c.id, c]));
  const groups = new Map<string, { variant: string; probe: WriterEvalCase['probe']; pieces: number; failed: number; offProtocol: number; invented: number; withGaps: number; examples: string[] }>();
  for (const row of rows) {
    const c = cases.get(row.case);
    if (!c) throw new Error(`row for unknown case ${row.case}`);
    const key = `${row.variant}\0${c.probe}`;
    const g = groups.get(key) ?? { variant: row.variant, probe: c.probe, pieces: 0, failed: 0, offProtocol: 0, invented: 0, withGaps: 0, examples: [] };
    groups.set(key, g);
    if (isFailure(row)) {
      g.failed++;
      continue;
    }
    g.pieces++;
    const score = scoreDraft(row.text, factSheet(config, c, new Date(row.now)));
    if (!score.protocol) g.offProtocol++;
    if (score.unsupported.length > 0) {
      g.invented++;
      g.examples.push(`${c.id}: ${score.unsupported.map((s) => s.text).join(', ')}`);
    }
    if (score.gaps > 0) g.withGaps++;
  }
  return [...groups.values()].sort((a, b) => a.probe.localeCompare(b.probe) || a.variant.localeCompare(b.variant));
}

const pct = (k: number, n: number): string => {
  if (n === 0) return 'n/a';
  const [lo, hi] = wilson(k, n);
  return `${k}/${n} (${Math.round((100 * k) / n)}%, ${Math.round(100 * lo)}-${Math.round(100 * hi)}%)`;
};

export function toMarkdown(rows: readonly ScoreRow[]): string {
  const lines = [
    '| variant | briefs | pieces | failed | off protocol | invented specific | with [COMPLETAR] |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.variant} | ${r.probe} | ${r.pieces} | ${r.failed} | ${r.offProtocol} | ${pct(r.invented, r.pieces)} | ${pct(r.withGaps, r.pieces)} |`),
  ];
  return lines.join('\n');
}
