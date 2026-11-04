// The run: one site's checklist in progress, as it is stored and exported.
// Browser-safe and pure: every change returns a new run, so a refused change leaves nothing half done.

import { FEATURES, PLATFORM_GROUPS, PLATFORMS, type Catalogue, type FeatureId, type Item, type MatrixRow, type PlatformId } from './catalogue.ts';
import { consistentLog, type IncidentLog } from './incident.ts';

/** The seven states of a check, in the order the method lists them. */
export const STATES = ['pass', 'pass_with_note', 'fixed', 'fail', 'risk_accepted', 'not_applicable', 'not_verified'] as const;
export type State = (typeof STATES)[number];

export const STATE_LABELS: Readonly<Record<State, string>> = {
  pass: 'Passed',
  pass_with_note: 'Passed with a note',
  fixed: 'Fixed',
  fail: 'Fails',
  risk_accepted: 'Risk accepted',
  not_applicable: 'Not applicable',
  not_verified: 'Not verified',
};

export const STATE_MEANINGS: Readonly<Record<State, string>> = {
  pass: 'Tested and passed, with evidence',
  pass_with_note: 'Passes, with something worth improving written down',
  fixed: 'Failed, was fixed, was tested again and passes',
  fail: 'An open finding',
  risk_accepted: 'Known; the owner decided not to fix it, in writing',
  not_applicable: 'That surface does not exist on this site; say why',
  not_verified: 'Could not be tested; say why. A check that never ran never counts as passed',
};

export interface Mark {
  readonly state: State | null;
  readonly evidence: string;
  readonly at: string;
  /** Set when the check was marked Fixed while it was marked Fails, so the run JSON shows Fixed was earned. */
  readonly fixedFrom?: 'fail';
}

export interface Profile {
  readonly platform: PlatformId;
  readonly features: readonly FeatureId[];
  /** Written authorization signed. Without it only the passive checks apply. */
  readonly authorized: boolean;
}

export interface ImportRecord {
  readonly source: 'site-check';
  readonly domain: string;
  readonly runDate: string;
  readonly at: string;
  readonly applied: number;
  readonly kept: number;
}

export interface IncidentEntry {
  readonly at: string;
  readonly note: string;
}

export interface Baseline {
  readonly at: string;
  readonly states: Readonly<Record<string, State>>;
  readonly evidence: Readonly<Record<string, string>>;
}

export interface Run {
  readonly format: 'site-checklist-run';
  readonly version: 1;
  readonly catalogueId: string;
  readonly createdAt: string;
  readonly site: { readonly name: string; readonly url: string };
  readonly profile: Profile;
  readonly marks: Readonly<Record<string, Mark>>;
  /** The marked states, and their evidence notes, recorded as "before" for the before and after report. */
  readonly baseline: Baseline | null;
  /** Pre-change list row id to the time it was acknowledged. */
  readonly preChange: Readonly<Record<string, string>>;
  /** Post-change matrix row id to the time it was acknowledged. */
  readonly postChange: Readonly<Record<string, string>>;
  readonly closedAt: string | null;
  readonly imports: readonly ImportRecord[];
  readonly incident: Readonly<Record<string, IncidentEntry>>;
}

export function newRun(catalogue: Catalogue, now: Date): Run {
  return {
    format: 'site-checklist-run',
    version: 1,
    catalogueId: catalogue.id,
    createdAt: now.toISOString(),
    site: { name: '', url: '' },
    profile: { platform: 'wordpress', features: [], authorized: false },
    marks: {},
    baseline: null,
    preChange: {},
    postChange: {},
    closedAt: null,
    imports: [],
    incident: {},
  };
}

// ---------------------------------------------------------------------------------------------
// Applicability

export function applies(item: Item, profile: Profile): boolean {
  if (!item.platforms.includes(profile.platform)) return false;
  if (item.access === 'authorized' && !profile.authorized) return false;
  return item.needs.every((n) => profile.features.includes(n));
}

export function matrixApplies(row: MatrixRow, profile: Profile): boolean {
  return row.needs.every((n) => (n === 'store' ? (PLATFORM_GROUPS.store ?? []).includes(profile.platform) : profile.features.includes(n)));
}

// ---------------------------------------------------------------------------------------------
// Rules

export type Refusal =
  | 'run_closed'
  | 'unknown_item'
  | 'not_in_profile'
  | 'pre_change_pending'
  | 'not_failed'
  | 'fixed_items_exist'
  | 'post_change_pending'
  | 'baseline_exists';

export const REFUSALS: Readonly<Record<Refusal, string>> = {
  run_closed: 'This run is closed. Reopen it to change anything.',
  unknown_item: 'This check is not in the catalogue.',
  not_in_profile: 'This check does not apply to the site profile.',
  pre_change_pending: 'Fixed needs the pre-change list acknowledged first (Change control tab).',
  not_failed: 'Fixed means it failed before: mark it Fails, or record "before" while it fails, first.',
  fixed_items_exist: 'Some checks are marked Fixed. The pre-change list stays acknowledged while they are.',
  post_change_pending: 'Closing needs every row of the post-change matrix acknowledged (Change control tab).',
  baseline_exists: '"Before" is already recorded for this run.',
};

export type Result = { readonly ok: true; readonly run: Run } | { readonly ok: false; readonly reason: Refusal };
const refuse = (reason: Refusal): Result => ({ ok: false, reason });

export function preChangeDone(catalogue: Catalogue, run: Run): boolean {
  return catalogue.preChange.every((row) => run.preChange[row.id] !== undefined);
}

export function postChangePending(catalogue: Catalogue, run: Run): MatrixRow[] {
  return catalogue.postChange.filter((row) => matrixApplies(row, run.profile) && run.postChange[row.id] === undefined);
}

/** Why `state` cannot be set on `itemId` now, or null when it can. */
export function stateRefusal(catalogue: Catalogue, run: Run, itemId: string, state: State | null): Refusal | null {
  if (run.closedAt) return 'run_closed';
  const item = catalogue.items.find((i) => i.id === itemId);
  if (!item) return 'unknown_item';
  if (!applies(item, run.profile)) return 'not_in_profile';
  if (state === 'fixed') {
    if (!preChangeDone(catalogue, run)) return 'pre_change_pending';
    const failedBefore = run.baseline?.states[itemId] === 'fail' || run.marks[itemId]?.state === 'fail';
    if (!failedBefore) return 'not_failed';
  }
  return null;
}

export function setState(catalogue: Catalogue, run: Run, itemId: string, state: State | null, now: Date): Result {
  const refusal = stateRefusal(catalogue, run, itemId, state);
  if (refusal) return refuse(refusal);
  const prev = run.marks[itemId];
  const mark: Mark = { state, evidence: prev?.evidence ?? '', at: now.toISOString() };
  // Fixed stays Fixed when its evidence changes; the origin goes with the state, not the note.
  const fixedFrom = state !== 'fixed' ? undefined : prev?.state === 'fail' ? 'fail' : prev?.state === 'fixed' ? prev.fixedFrom : undefined;
  return { ok: true, run: { ...run, marks: { ...run.marks, [itemId]: fixedFrom ? { ...mark, fixedFrom } : mark } } };
}

export function setEvidence(catalogue: Catalogue, run: Run, itemId: string, evidence: string, now: Date): Result {
  if (run.closedAt) return refuse('run_closed');
  if (!catalogue.items.some((i) => i.id === itemId)) return refuse('unknown_item');
  const prev = run.marks[itemId];
  const mark: Mark = { state: prev?.state ?? null, evidence, at: now.toISOString() };
  return { ok: true, run: { ...run, marks: { ...run.marks, [itemId]: prev?.fixedFrom ? { ...mark, fixedFrom: prev.fixedFrom } : mark } } };
}

export function ackPreChange(catalogue: Catalogue, run: Run, rowId: string, on: boolean, now: Date): Result {
  if (run.closedAt) return refuse('run_closed');
  if (!catalogue.preChange.some((r) => r.id === rowId)) return refuse('unknown_item');
  const next = { ...run.preChange };
  if (on) {
    next[rowId] = run.preChange[rowId] ?? now.toISOString();
  } else {
    // Unticking would leave Fixed rows that no longer meet their own rule.
    if (Object.values(run.marks).some((m) => m.state === 'fixed')) return refuse('fixed_items_exist');
    delete next[rowId];
  }
  return { ok: true, run: { ...run, preChange: next } };
}

export function ackPostChange(catalogue: Catalogue, run: Run, rowId: string, on: boolean, now: Date): Result {
  if (run.closedAt) return refuse('run_closed');
  if (!catalogue.postChange.some((r) => r.id === rowId)) return refuse('unknown_item');
  const next = { ...run.postChange };
  if (on) next[rowId] = run.postChange[rowId] ?? now.toISOString();
  else delete next[rowId];
  return { ok: true, run: { ...run, postChange: next } };
}

/** Freezes the current states and their evidence notes as "before". Unmarked checks are left out. */
export function recordBaseline(run: Run, now: Date): Result {
  if (run.closedAt) return refuse('run_closed');
  if (run.baseline) return refuse('baseline_exists');
  const states: Record<string, State> = {};
  const evidence: Record<string, string> = {};
  for (const [id, mark] of Object.entries(run.marks)) {
    if (!mark.state) continue;
    states[id] = mark.state;
    evidence[id] = mark.evidence;
  }
  return { ok: true, run: { ...run, baseline: { at: now.toISOString(), states, evidence } } };
}

export function closeRun(catalogue: Catalogue, run: Run, now: Date): Result {
  if (run.closedAt) return refuse('run_closed');
  if (postChangePending(catalogue, run).length > 0) return refuse('post_change_pending');
  return { ok: true, run: { ...run, closedAt: now.toISOString() } };
}

export const reopenRun = (run: Run): Run => ({ ...run, closedAt: null });

/** The incident log of the run, replaced. A closed run keeps its log as it was closed. */
export function setIncident(run: Run, log: IncidentLog): Result {
  if (run.closedAt) return refuse('run_closed');
  return { ok: true, run: { ...run, incident: log } };
}

export function setProfile(run: Run, profile: Profile): Result {
  if (run.closedAt) return refuse('run_closed');
  return { ok: true, run: { ...run, profile } };
}

export function setSite(run: Run, site: { name: string; url: string }): Result {
  if (run.closedAt) return refuse('run_closed');
  return { ok: true, run: { ...run, site } };
}

// ---------------------------------------------------------------------------------------------
// The run JSON: export, and the guard that every stored or imported run goes through.

const PLATFORM_IDS: readonly string[] = PLATFORMS.map((p) => p.id);
const FEATURE_IDS: readonly string[] = FEATURES.map((f) => f.id);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u.test(v) && !Number.isNaN(Date.parse(v));
const isState = (v: unknown): v is State => (STATES as readonly unknown[]).includes(v);
const allValues = (v: unknown, test: (x: unknown) => boolean): boolean => isRecord(v) && Object.values(v).every(test);

export function isRun(v: unknown): v is Run {
  if (!isRecord(v) || v.format !== 'site-checklist-run' || v.version !== 1) return false;
  if (typeof v.catalogueId !== 'string' || !isIso(v.createdAt)) return false;
  const { site, profile, baseline, closedAt, imports } = v;
  if (!isRecord(site) || typeof site.name !== 'string' || typeof site.url !== 'string') return false;
  if (!isRecord(profile) || !PLATFORM_IDS.includes(String(profile.platform)) || typeof profile.authorized !== 'boolean') return false;
  if (!Array.isArray(profile.features) || !profile.features.every((f) => FEATURE_IDS.includes(String(f)))) return false;
  if (
    !allValues(v.marks, (m) => isRecord(m) && (m.state === null || isState(m.state)) && typeof m.evidence === 'string' && isIso(m.at) && (m.fixedFrom === undefined || m.fixedFrom === 'fail'))
  ) {
    return false;
  }
  if (baseline !== null && !(isRecord(baseline) && isIso(baseline.at) && allValues(baseline.states, isState) && allValues(baseline.evidence, (e) => typeof e === 'string'))) return false;
  if (!allValues(v.preChange, isIso) || !allValues(v.postChange, isIso)) return false;
  if (closedAt !== null && !isIso(closedAt)) return false;
  if (
    !Array.isArray(imports) ||
    !imports.every(
      (r) =>
        isRecord(r) && r.source === 'site-check' && typeof r.domain === 'string' && typeof r.runDate === 'string' && isIso(r.at) && Number.isInteger(r.applied) && Number.isInteger(r.kept),
    )
  ) {
    return false;
  }
  return allValues(v.incident, (e) => isRecord(e) && isIso(e.at) && typeof e.note === 'string');
}

// ---------------------------------------------------------------------------------------------
// The rules again, for a run that did not come through the functions above: a loaded file or a
// stored value. isRun checks the shape; repairRun checks the rules and undoes what breaks them.

export interface Repair {
  readonly run: Run;
  /** One sentence per entry that broke a rule and was undone, empty when the run was consistent. */
  readonly dropped: readonly string[];
}

export function repairRun(catalogue: Catalogue, run: Run): Repair {
  const dropped: string[] = [];
  const marks: Record<string, Mark> = { ...run.marks };
  const preDone = preChangeDone(catalogue, run);
  for (const [id, mark] of Object.entries(run.marks)) {
    if (mark.state !== 'fixed') continue;
    const earned = run.baseline?.states[id] === 'fail' || mark.fixedFrom === 'fail';
    if (preDone && earned) continue;
    // The evidence note stays: only the claim that a change was made and tested is undone.
    marks[id] = { state: null, evidence: mark.evidence, at: mark.at };
    dropped.push(`${id} was Fixed ${preDone ? 'but never marked Fails' : 'without the pre-change list acknowledged'}; it is unmarked now.`);
  }
  let next: Run = { ...run, marks };
  const incident = consistentLog(catalogue.incident.steps, run.incident);
  if (incident.dropped.length) {
    next = { ...next, incident: incident.log };
    const steps = incident.dropped.length === 1 ? 'step' : 'steps';
    dropped.push(`Incident ${steps} unknown or ticked before what they require, now unticked: ${incident.dropped.join(', ')}.`);
  }
  if (next.closedAt) {
    const pending = postChangePending(catalogue, next);
    if (pending.length) {
      next = { ...next, closedAt: null };
      dropped.push(`The run was closed with ${pending.length} post-change ${pending.length === 1 ? 'row' : 'rows'} pending; it is open now.`);
    }
  }
  return { run: dropped.length ? next : run, dropped };
}

export const serialiseRun = (run: Run): string => `${JSON.stringify(run, null, 2)}\n`;

export type ParsedRun = { readonly ok: true; readonly run: Run } | { readonly ok: false; readonly reason: 'not_json' | 'not_a_run' };

export function parseRun(text: string): ParsedRun {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  return isRun(value) ? { ok: true, run: value } : { ok: false, reason: 'not_a_run' };
}

/** A file-name-safe slug of the site, for exported files. */
export function siteSlug(run: Run): string {
  let base = run.site.name || run.site.url;
  try {
    if (run.site.url) base = new URL(run.site.url).hostname.replace(/^www\./u, '');
  } catch {
    // Not a URL: fall back to the name.
  }
  const slug = base.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return slug.slice(0, 40) || 'site';
}
