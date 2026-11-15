// Pre-fills external checks from a stored site-check run: run.json (schema_version 2, English
// names) or the datos.json of earlier versions (schema_version 1, Spanish names).
//
// The file comes from the user's disk, so it is validated field by field. Three rules decide what
// is written:
//   - a check already marked by hand is kept, and listed, never overwritten;
//   - a file for another domain is refused as a whole, so one site's results never land in another's run;
//   - a check id the catalogue does not know, or outside the profile, is listed and skipped.

import type { Catalogue } from './catalogue.ts';
import { applies, type Mark, type Run, type State } from './run.ts';

/** Version 1 of site-check keeps its states in Spanish, verbatim in datos.json. */
export const SITE_CHECK_STATES: Readonly<Record<string, State>> = {
  APROBADO: 'pass',
  APROBADO_CON_OBSERVACION: 'pass_with_note',
  FALLA: 'fail',
  NO_APLICA: 'not_applicable',
  NO_VERIFICADO: 'not_verified',
};

/** Version 2 writes the states with the names this app already uses. */
const STATES_V2: Readonly<Record<string, State>> = {
  pass: 'pass',
  pass_with_note: 'pass_with_note',
  fail: 'fail',
  not_applicable: 'not_applicable',
  not_verified: 'not_verified',
};

/** Where each field this app reads lives in one version of the stored run. */
interface Names {
  readonly states: Readonly<Record<string, State>>;
  readonly domain: string;
  readonly startedUtc: string;
  readonly startedLocal: string;
  readonly canonicalUrl: string;
  readonly organisation: string;
  readonly state: string;
  readonly sentence: string;
  readonly found: string;
  readonly notVerifiedReason: string;
  readonly reason: string;
  readonly evidence: string;
}

const NAMES: Readonly<Record<number, Names>> = {
  1: {
    states: SITE_CHECK_STATES,
    domain: 'dominio',
    startedUtc: 'inicio_utc',
    startedLocal: 'inicio_local',
    canonicalUrl: 'url_canonica',
    organisation: 'institucion',
    state: 'estado',
    sentence: 'frase_informe_llena',
    found: 'que_se_encontro',
    notVerifiedReason: 'motivo_no_verificado',
    reason: 'motivo',
    evidence: 'evidencia',
  },
  2: {
    states: STATES_V2,
    domain: 'domain',
    startedUtc: 'started_utc',
    startedLocal: 'started_local',
    canonicalUrl: 'canonical_url',
    organisation: 'organisation',
    state: 'state',
    sentence: 'sentence',
    found: 'found',
    notVerifiedReason: 'not_verified_reason',
    reason: 'reason',
    evidence: 'evidence',
  },
};

export interface ImportSummary {
  readonly domain: string;
  readonly runDate: string;
  readonly applied: readonly string[];
  readonly kept: readonly string[];
  readonly unknown: readonly string[];
  readonly outsideProfile: readonly string[];
  /** Entries without an id or with a state site-check does not define. */
  readonly invalid: number;
}

export type ImportRefusal = 'not_json' | 'not_site_check' | 'unsupported_version' | 'domain_mismatch' | 'bad_site_url' | 'run_closed';

export const IMPORT_REFUSALS: Readonly<Record<ImportRefusal, string>> = {
  not_json: 'The file is not JSON.',
  not_site_check: 'The file does not look like a site-check run.json or datos.json (no checks list or no domain).',
  unsupported_version: 'This site-check run has a schema version this app does not read (it reads versions 1 and 2).',
  domain_mismatch: 'The file is for another domain than the site of this run.',
  bad_site_url: 'The site address of this run is not a web address, so the file cannot be matched to it. Correct the address first.',
  run_closed: 'This run is closed. Reopen it to import.',
};

export type ImportResult =
  | { readonly ok: true; readonly run: Run; readonly summary: ImportSummary }
  | { readonly ok: false; readonly reason: ImportRefusal; readonly detail: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const bareHost = (host: string): string => host.toLowerCase().replace(/^www\./u, '').replace(/\.$/u, '');

function hostOf(url: string): string | null {
  try {
    return bareHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** The host of an address as a person types it: `mysite.test` reads as `https://mysite.test`. */
const typedHostOf = (url: string): string | null => hostOf(/^[a-z][a-z0-9+.-]*:/iu.test(url) ? url : `https://${url}`);

const EVIDENCE_LIMIT = 1200;

/**
 * The evidence note an imported check gets: the run date, what site-check found, and its evidence
 * files. Empty when site-check recorded neither a finding nor an evidence file: a pass with only a
 * date would otherwise turn green with nothing behind it.
 */
export function evidenceFor(check: Record<string, unknown>, runDate: string, state: State, names: Names = NAMES[1] as Names): string {
  const filled = check[names.sentence];
  const sentence = isRecord(filled) ? str(filled[names.found]) : '';
  const reason = str(check[names.notVerifiedReason]) || str(check[names.reason]);
  const listed = check[names.evidence];
  const files = Array.isArray(listed) ? listed.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : [];
  if (!sentence && files.length === 0) {
    // A reason explains a check that did not pass; it is not evidence that one did.
    const passed = state === 'pass' || state === 'pass_with_note';
    return reason && !passed ? `site-check ${runDate}. Reason: ${reason}.`.slice(0, EVIDENCE_LIMIT) : '';
  }
  const parts = [`site-check ${runDate}.`];
  if (sentence) parts.push(sentence.endsWith('.') ? sentence : `${sentence}.`);
  if (reason) parts.push(`Reason: ${reason}.`);
  if (files.length) parts.push(`Evidence files: ${files.join(', ')}.`);
  return parts.join(' ').slice(0, EVIDENCE_LIMIT);
}

export function importSiteCheck(catalogue: Catalogue, run: Run, text: string, now: Date): ImportResult {
  if (run.closedAt) return { ok: false, reason: 'run_closed', detail: '' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not_json', detail: '' };
  }
  if (!isRecord(data) || !Array.isArray(data.checks) || !isRecord(data.meta)) {
    return { ok: false, reason: 'not_site_check', detail: '' };
  }
  // The domain is read under either name first, so a file of a version this app does not know is
  // told apart from a file that is not a site-check run at all.
  const meta = data.meta;
  if (!str(meta.dominio) && !str(meta.domain)) return { ok: false, reason: 'not_site_check', detail: '' };
  const names = typeof data.schema_version === 'number' ? NAMES[data.schema_version] : undefined;
  if (!names) return { ok: false, reason: 'unsupported_version', detail: String(data.schema_version) };
  // The number says which names to expect; a file that carries the other version's names is neither.
  if (!str(meta[names.domain])) return { ok: false, reason: 'not_site_check', detail: '' };

  const domain = bareHost(str(meta[names.domain]));
  // An address that is there but does not parse is not "no site yet": the file is refused, and the
  // address is never replaced.
  const runHost = run.site.url ? typedHostOf(run.site.url) : null;
  if (run.site.url && !runHost) return { ok: false, reason: 'bad_site_url', detail: run.site.url };
  if (runHost !== null && runHost !== domain) {
    return { ok: false, reason: 'domain_mismatch', detail: `the file is for ${domain}, this run is for ${runHost}` };
  }
  const runDate = (str(meta[names.startedUtc]) || str(meta[names.startedLocal])).slice(0, 10) || 'unknown date';

  const marks: Record<string, Mark> = { ...run.marks };
  const applied: string[] = [];
  const kept: string[] = [];
  const unknown: string[] = [];
  const outsideProfile: string[] = [];
  let invalid = 0;
  const seen = new Set<string>();

  for (const check of data.checks) {
    if (!isRecord(check)) {
      invalid++;
      continue;
    }
    const id = str(check.id);
    const state = names.states[str(check[names.state])];
    if (!id || !state || seen.has(id)) {
      invalid++;
      continue;
    }
    seen.add(id);
    const item = catalogue.items.find((i) => i.id === id);
    if (!item) {
      unknown.push(id);
      continue;
    }
    if (!applies(item, run.profile)) {
      outsideProfile.push(id);
      continue;
    }
    const existing = run.marks[id];
    if (existing?.state) {
      kept.push(id);
      continue;
    }
    // A note typed before the import stays, after the imported one.
    const typed = existing?.evidence.trim() ?? '';
    const note = evidenceFor(check, runDate, state, names);
    marks[id] = { state, evidence: typed && note ? `${note}\n${typed}` : note || typed, at: now.toISOString() };
    applied.push(id);
  }

  // The canonical URL is taken only when it is on the file's own domain; a redirect elsewhere is not this site.
  const canonical = str(meta[names.canonicalUrl]);
  const url = canonical && hostOf(canonical) === domain ? canonical : `https://${domain}/`;
  const site = !run.site.url ? { name: run.site.name || str(meta[names.organisation]), url } : run.site;
  const next: Run = {
    ...run,
    site,
    marks,
    imports: [...run.imports, { source: 'site-check', domain, runDate, at: now.toISOString(), applied: applied.length, kept: kept.length }],
  };
  return { ok: true, run: next, summary: { domain, runDate, applied, kept, unknown, outsideProfile, invalid } };
}

export function importSummaryText(s: ImportSummary): string {
  const parts = [`Imported site-check run of ${s.domain} (${s.runDate}): ${s.applied.length} ${s.applied.length === 1 ? 'check' : 'checks'} pre-filled.`];
  if (s.kept.length) parts.push(`${s.kept.length} already marked and kept: ${s.kept.join(', ')}.`);
  if (s.outsideProfile.length) parts.push(`${s.outsideProfile.length} outside the site profile: ${s.outsideProfile.join(', ')}.`);
  if (s.unknown.length) parts.push(`${s.unknown.length} not in this catalogue: ${s.unknown.join(', ')}.`);
  if (s.invalid) parts.push(`${s.invalid} unreadable ${s.invalid === 1 ? 'entry' : 'entries'} skipped.`);
  return parts.join(' ');
}
