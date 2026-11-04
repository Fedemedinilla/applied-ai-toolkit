// The incident runbook as a dependency graph: a step is ticked only after every step it requires,
// each tick keeps its time, and the timeline is generated from those times.
// Browser-safe and pure.

import type { Catalogue, IncidentStep } from './catalogue.ts';
import type { IncidentEntry, Run } from './run.ts';

export type IncidentLog = Readonly<Record<string, IncidentEntry>>;

export type IncidentRefusal = 'unknown_step' | 'requires' | 'has_dependants' | 'not_ticked' | 'bad_time' | 'before_requirement' | 'after_dependant' | 'in_future';

export type IncidentResult =
  | { readonly ok: true; readonly log: IncidentLog }
  | { readonly ok: false; readonly reason: IncidentRefusal; readonly steps: readonly string[] };

const refuse = (reason: IncidentRefusal, steps: readonly string[] = []): IncidentResult => ({ ok: false, reason, steps });

/** Times are kept to the minute, the precision of the time input, so a time shown can always be set back. */
export const toMinute = (at: Date): Date => new Date(Math.floor(at.getTime() / 60_000) * 60_000);
const minuteOf = (iso: string): number => Math.floor(Date.parse(iso) / 60_000);

const find = (steps: readonly IncidentStep[], id: string): IncidentStep | undefined => steps.find((s) => s.id === id);

/** Required steps of `id` that are not ticked yet, in catalogue order. */
export function missingFor(steps: readonly IncidentStep[], log: IncidentLog, id: string): string[] {
  return (find(steps, id)?.requires ?? []).filter((dep) => log[dep] === undefined);
}

/** Ticked steps that require `id`. */
export function tickedDependants(steps: readonly IncidentStep[], log: IncidentLog, id: string): string[] {
  return steps.filter((s) => s.requires.includes(id) && log[s.id] !== undefined).map((s) => s.id);
}

/** The time window a step's time must fall in: not before what it requires, not after what requires it. */
function timeRefusal(steps: readonly IncidentStep[], log: IncidentLog, id: string, at: Date, now: Date): IncidentResult | null {
  if (Number.isNaN(at.getTime())) return refuse('bad_time');
  if (at.getTime() > now.getTime()) return refuse('in_future');
  const step = find(steps, id);
  const minute = minuteOf(at.toISOString());
  const early = (step?.requires ?? []).filter((dep) => {
    const t = log[dep]?.at;
    return t !== undefined && minuteOf(t) > minute;
  });
  if (early.length) return refuse('before_requirement', early);
  const late = tickedDependants(steps, log, id).filter((dep) => minuteOf(log[dep]?.at ?? '') < minute);
  if (late.length) return refuse('after_dependant', late);
  return null;
}

export function tick(steps: readonly IncidentStep[], log: IncidentLog, id: string, at: Date, now: Date, note = ''): IncidentResult {
  if (!find(steps, id)) return refuse('unknown_step');
  const missing = missingFor(steps, log, id);
  if (missing.length) return refuse('requires', missing);
  const bad = timeRefusal(steps, log, id, at, now);
  if (bad) return bad;
  return { ok: true, log: { ...log, [id]: { at: toMinute(at).toISOString(), note } } };
}

export function untick(steps: readonly IncidentStep[], log: IncidentLog, id: string): IncidentResult {
  if (!find(steps, id)) return refuse('unknown_step');
  const dependants = tickedDependants(steps, log, id);
  if (dependants.length) return refuse('has_dependants', dependants);
  const next = { ...log };
  delete next[id];
  return { ok: true, log: next };
}

/** Moves a ticked step's time, for steps logged after the fact. */
export function setTime(steps: readonly IncidentStep[], log: IncidentLog, id: string, at: Date, now: Date): IncidentResult {
  if (!find(steps, id)) return refuse('unknown_step');
  const entry = log[id];
  if (!entry) return refuse('not_ticked');
  const bad = timeRefusal(steps, log, id, at, now);
  if (bad) return bad;
  return { ok: true, log: { ...log, [id]: { ...entry, at: toMinute(at).toISOString() } } };
}

export function setNote(steps: readonly IncidentStep[], log: IncidentLog, id: string, note: string): IncidentResult {
  const entry = log[id];
  if (!find(steps, id)) return refuse('unknown_step');
  if (!entry) return refuse('not_ticked');
  return { ok: true, log: { ...log, [id]: { ...entry, note } } };
}

export function refusalText(catalogue: Catalogue, reason: IncidentRefusal, ids: readonly string[]): string {
  const names = ids.map((id) => stepTitle(catalogue, id)).join('; ');
  switch (reason) {
    case 'requires':
      return `Needs first: ${names}.`;
    case 'has_dependants':
      return `Untick these first, they depend on it: ${names}.`;
    case 'before_requirement':
      return `That time is before a step it requires: ${names}.`;
    case 'after_dependant':
      return `That time is after a step that depends on it: ${names}.`;
    case 'in_future':
      return 'That time is in the future.';
    case 'bad_time':
      return 'That is not a valid date and time.';
    case 'not_ticked':
      return 'Tick the step before changing its time.';
    case 'unknown_step':
      return 'That step is not in the runbook.';
  }
}

/** The part of a step's text before the first colon: its short name. */
export function stepTitle(catalogue: Catalogue, id: string): string {
  const text = catalogue.incident.steps.find((s) => s.id === id)?.text ?? id;
  return text.split(':')[0] ?? text;
}

// ---------------------------------------------------------------------------------------------
// Timeline

export interface TimelineEntry {
  readonly step: IncidentStep;
  readonly phaseName: string;
  readonly at: string;
  readonly note: string;
  /** Milliseconds since the first ticked step. */
  readonly elapsed: number;
}

export function timeline(catalogue: Catalogue, log: IncidentLog): TimelineEntry[] {
  const order = new Map(catalogue.incident.steps.map((s, i) => [s.id, i]));
  const ticked = catalogue.incident.steps
    .filter((s) => log[s.id] !== undefined)
    .sort((a, b) => minuteOf(log[a.id]?.at ?? '') - minuteOf(log[b.id]?.at ?? '') || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const first = ticked[0] ? Date.parse(log[ticked[0].id]?.at ?? '') : 0;
  return ticked.map((step) => {
    const entry = log[step.id] ?? { at: '', note: '' };
    return {
      step,
      phaseName: catalogue.incident.phases.find((p) => p.number === step.phase)?.name ?? `Phase ${step.phase}`,
      at: entry.at,
      note: entry.note,
      elapsed: Date.parse(entry.at) - first,
    };
  });
}

/** "2026-11-04 13:02 UTC". UTC, so the timeline reads the same on every device it is opened on. */
export function formatUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** "+0 min", "+1 h 05 min", "+2 d 3 h 10 min". */
export function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `+${d} d ${h} h ${String(m).padStart(2, '0')} min`;
  if (h > 0) return `+${h} h ${String(m).padStart(2, '0')} min`;
  return `+${m} min`;
}

export function phaseProgress(catalogue: Catalogue, log: IncidentLog, phase: number): { done: number; total: number } {
  const steps = catalogue.incident.steps.filter((s) => s.phase === phase);
  return { done: steps.filter((s) => log[s.id] !== undefined).length, total: steps.length };
}

export const withIncident = (run: Run, log: IncidentLog): Run => ({ ...run, incident: log });

/**
 * The log without the entries that break the runbook's order: an unknown step, or a step whose
 * requirements are not ticked at the same minute or earlier. Requirements always come earlier in
 * the table, so one pass in table order also drops whatever depended on a dropped entry.
 */
export function consistentLog(steps: readonly IncidentStep[], log: IncidentLog): { log: IncidentLog; dropped: string[] } {
  const kept: Record<string, IncidentEntry> = {};
  const dropped = Object.keys(log).filter((id) => !find(steps, id));
  for (const step of steps) {
    const entry = log[step.id];
    if (!entry) continue;
    const inOrder = step.requires.every((dep) => {
      const t = kept[dep]?.at;
      return t !== undefined && minuteOf(t) <= minuteOf(entry.at);
    });
    if (inOrder) kept[step.id] = entry;
    else dropped.push(step.id);
  }
  return { log: kept, dropped };
}
