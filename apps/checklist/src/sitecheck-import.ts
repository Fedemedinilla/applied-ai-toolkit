// Pre-fills external checks from a site-check datos.json (schema_version 1).
//
// The file comes from the user's disk, so it is validated field by field. Three rules decide what
// is written:
//   - a check already marked by hand is kept, and listed, never overwritten;
//   - a file for another domain is refused as a whole, so one site's results never land in another's run;
//   - a check id the catalogue does not know, or outside the profile, is listed and skipped.

import type { Catalogue } from './catalogue.ts';
import { applies, type Mark, type Run, type State } from './run.ts';

/** site-check keeps its states in Spanish, verbatim in datos.json. */
export const SITE_CHECK_STATES: Readonly<Record<string, State>> = {
  APROBADO: 'pass',
  APROBADO_CON_OBSERVACION: 'pass_with_note',
  FALLA: 'fail',
  NO_APLICA: 'not_applicable',
  NO_VERIFICADO: 'not_verified',
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

export type ImportRefusal = 'not_json' | 'not_site_check' | 'unsupported_version' | 'domain_mismatch' | 'run_closed';

export const IMPORT_REFUSALS: Readonly<Record<ImportRefusal, string>> = {
  not_json: 'The file is not JSON.',
  not_site_check: 'The file does not look like a site-check datos.json (no checks list or no domain).',
  unsupported_version: 'This datos.json has a schema version this app does not read (it reads version 1).',
  domain_mismatch: 'The file is for another domain than the site of this run.',
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

const EVIDENCE_LIMIT = 1200;

/**
 * The evidence note an imported check gets: the run date, what site-check found, and its evidence
 * files. Empty when site-check recorded neither a finding nor an evidence file: a pass with only a
 * date would otherwise turn green with nothing behind it.
 */
export function evidenceFor(check: Record<string, unknown>, runDate: string, state: State): string {
  const sentence = isRecord(check.frase_informe_llena) ? str(check.frase_informe_llena.que_se_encontro) : '';
  const reason = str(check.motivo_no_verificado) || str(check.motivo);
  const files = Array.isArray(check.evidencia) ? check.evidencia.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : [];
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
  if (!isRecord(data) || !Array.isArray(data.checks) || !isRecord(data.meta) || !str(data.meta.dominio)) {
    return { ok: false, reason: 'not_site_check', detail: '' };
  }
  if (data.schema_version !== 1) return { ok: false, reason: 'unsupported_version', detail: String(data.schema_version) };

  const meta = data.meta;
  const domain = bareHost(str(meta.dominio));
  const runHost = run.site.url ? hostOf(run.site.url) : null;
  if (runHost !== null && runHost !== domain) {
    return { ok: false, reason: 'domain_mismatch', detail: `the file is for ${domain}, this run is for ${runHost}` };
  }
  const runDate = (str(meta.inicio_utc) || str(meta.inicio_local)).slice(0, 10) || 'unknown date';

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
    const state = SITE_CHECK_STATES[str(check.estado)];
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
    const note = evidenceFor(check, runDate, state);
    marks[id] = { state, evidence: typed && note ? `${note}\n${typed}` : note || typed, at: now.toISOString() };
    applied.push(id);
  }

  // The canonical URL is taken only when it is on the file's own domain; a redirect elsewhere is not this site.
  const canonical = str(meta.url_canonica);
  const url = canonical && hostOf(canonical) === domain ? canonical : `https://${domain}/`;
  const site = runHost === null ? { name: run.site.name || str(meta.institucion), url } : run.site;
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
