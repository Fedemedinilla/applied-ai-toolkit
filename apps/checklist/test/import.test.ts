// Importing a site-check datos.json: states mapped, evidence written, hand marks kept, other
// domains refused, and the real example run of site-check read end to end.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { itemColour } from '../src/colours.ts';
import { setEvidence, setState, type Run } from '../src/run.ts';
import { evidenceFor, importSiteCheck, importSummaryText, type ImportResult } from '../src/sitecheck-import.ts';
import { at, fixture, loadCatalogue, ok, runWith } from './helpers.ts';

const catalogue = loadCatalogue();
const datos = fixture('datos.json');

function imported(result: ImportResult): Extract<ImportResult, { ok: true }> {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

describe('importing the fixture run', () => {
  const run = runWith(catalogue, 'wordpress', ['own-mail']);
  const result = imported(importSiteCheck(catalogue, run, datos, at(1)));

  it('maps the five site-check states onto the seven', () => {
    expect(result.run.marks['EXT-01']?.state).toBe('pass_with_note');
    expect(result.run.marks['EXT-05']?.state).toBe('fail');
    expect(result.run.marks['EXT-07']?.state).toBe('pass');
    expect(result.run.marks['VIS-12']?.state).toBe('not_verified');
  });

  it('writes the run date, the finding and the evidence files as the evidence note', () => {
    expect(result.run.marks['EXT-07']?.evidence).toBe('site-check 2026-10-20. The certificate is valid for 80 more days. Evidence files: tls.json.');
    expect(result.run.marks['VIS-12']?.evidence).toBe('site-check 2026-10-20. Reason: needs a test in a browser.');
  });

  it('lists what it skipped and why', () => {
    expect(result.summary).toEqual({
      domain: 'workshop.test',
      runDate: '2026-10-20',
      applied: ['EXT-01', 'EXT-05', 'EXT-07', 'VIS-12'],
      kept: [],
      unknown: ['XYZ-99'],
      // VIS-08 needs the bilingual feature and EXT-25 needs forms; this profile has neither.
      outsideProfile: ['VIS-08', 'EXT-25'],
      invalid: 3,
    });
    expect(importSummaryText(result.summary)).toBe(
      'Imported site-check run of workshop.test (2026-10-20): 4 checks pre-filled. 2 outside the site profile: VIS-08, EXT-25. 1 not in this catalogue: XYZ-99. 3 unreadable entries skipped.',
    );
  });

  it('fills an empty site name and address from the file, and records the import', () => {
    expect(result.run.site).toEqual({ name: 'Example Workshop', url: 'https://www.workshop.test/' });
    expect(result.run.imports).toEqual([{ source: 'site-check', domain: 'workshop.test', runDate: '2026-10-20', at: at(1).toISOString(), applied: 4, kept: 0 }]);
  });
});

describe('evidence and the address taken from the file', () => {
  const withCheck = (check: Record<string, unknown>, meta: Record<string, unknown> = {}): string => {
    const parsed = JSON.parse(datos) as { meta: Record<string, unknown> };
    return JSON.stringify({ ...parsed, meta: { ...parsed.meta, ...meta }, checks: [check] });
  };

  it('gives a pass with no finding and no evidence file an empty note, so it stays grey', () => {
    const run = runWith(catalogue, 'wordpress');
    const bare = { id: 'EXT-07', estado: 'APROBADO', evidencia: [], frase_informe_llena: null, motivo: 'measured' };
    const next = imported(importSiteCheck(catalogue, run, withCheck(bare), at(1))).run;
    expect(next.marks['EXT-07']).toMatchObject({ state: 'pass', evidence: '' });
    const item = catalogue.items.find((i) => i.id === 'EXT-07');
    if (!item) throw new Error('EXT-07');
    expect(itemColour(item, next)).toMatchObject({ colour: 'grey', grey: 'no_evidence' });
    // A note typed before stays, alone.
    const typed = ok(setEvidence(catalogue, run, 'EXT-07', 'own note', at(0)));
    expect(imported(importSiteCheck(catalogue, typed, withCheck(bare), at(1))).run.marks['EXT-07']?.evidence).toBe('own note');
  });

  it('keeps a reason for a check that did not pass, and needs a finding or a file for a pass', () => {
    expect(evidenceFor({ motivo_no_verificado: 'needs a browser' }, '2026-10-20', 'not_verified')).toBe('site-check 2026-10-20. Reason: needs a browser.');
    expect(evidenceFor({ motivo: 'checked' }, '2026-10-20', 'pass')).toBe('');
    expect(evidenceFor({ evidencia: ['tls.json'] }, '2026-10-20', 'pass')).toBe('site-check 2026-10-20. Evidence files: tls.json.');
  });

  it('takes the canonical URL only when it is on the file\'s own domain', () => {
    const run = runWith(catalogue, 'wordpress');
    const check = { id: 'EXT-07', estado: 'FALLA' };
    expect(imported(importSiteCheck(catalogue, run, withCheck(check, { url_canonica: 'https://elsewhere.test/landing' }), at(1))).run.site.url).toBe('https://workshop.test/');
    expect(imported(importSiteCheck(catalogue, run, withCheck(check, { url_canonica: 'not a url' }), at(1))).run.site.url).toBe('https://workshop.test/');
    expect(imported(importSiteCheck(catalogue, run, withCheck(check), at(1))).run.site.url).toBe('https://www.workshop.test/');
  });
});

describe('what an import does not touch', () => {
  it('keeps a check already marked by hand, and keeps a note typed before the import', () => {
    let run: Run = runWith(catalogue, 'wordpress', ['own-mail']);
    run = ok(setState(catalogue, run, 'EXT-05', 'pass', at(1)));
    run = ok(setEvidence(catalogue, run, 'EXT-05', 'checked the DNS by hand', at(2)));
    run = ok(setEvidence(catalogue, run, 'EXT-07', 'own note', at(3)));
    const result = imported(importSiteCheck(catalogue, run, datos, at(4)));
    expect(result.run.marks['EXT-05']).toEqual(run.marks['EXT-05']);
    expect(result.summary.kept).toEqual(['EXT-05']);
    expect(result.run.marks['EXT-07']?.evidence).toBe('site-check 2026-10-20. The certificate is valid for 80 more days. Evidence files: tls.json.\nown note');
  });

  it('refuses a file for another domain, as a whole', () => {
    const run = { ...runWith(catalogue, 'wordpress'), site: { name: 'Other', url: 'https://other.test/' } };
    expect(importSiteCheck(catalogue, run, datos, at(1))).toEqual({ ok: false, reason: 'domain_mismatch', detail: 'the file is for workshop.test, this run is for other.test' });
  });

  it('accepts the same domain with or without www', () => {
    const run = { ...runWith(catalogue, 'wordpress'), site: { name: '', url: 'https://workshop.test' } };
    expect(imported(importSiteCheck(catalogue, run, datos, at(1))).run.site.url).toBe('https://workshop.test');
  });

  it('refuses text that is not JSON, JSON that is not a datos.json, another schema version and a closed run', () => {
    const run = runWith(catalogue, 'wordpress');
    expect(importSiteCheck(catalogue, run, 'nope', at(1))).toMatchObject({ ok: false, reason: 'not_json' });
    expect(importSiteCheck(catalogue, run, '{"checks": []}', at(1))).toMatchObject({ ok: false, reason: 'not_site_check' });
    const v2 = JSON.stringify({ ...JSON.parse(datos), schema_version: 2 });
    expect(importSiteCheck(catalogue, run, v2, at(1))).toMatchObject({ ok: false, reason: 'unsupported_version' });
    expect(importSiteCheck(catalogue, { ...run, closedAt: at(0).toISOString() }, datos, at(1))).toMatchObject({ ok: false, reason: 'run_closed' });
  });
});

describe("site-check's own example run", () => {
  // The published example of site-check (a fictional school under .test), read as a user would load it.
  const example = readFileSync(new URL('../../../site-check/examples/datos.json', import.meta.url), 'utf8');

  it('pre-fills every one of its 37 checks on a WordPress profile with mail, forms and two languages', () => {
    const run = runWith(catalogue, 'wordpress', ['own-mail', 'forms', 'bilingual']);
    const result = imported(importSiteCheck(catalogue, run, example, at(1)));
    expect(result.summary.applied).toHaveLength(37);
    expect(result.summary).toMatchObject({ domain: 'colegio.test', unknown: [], outsideProfile: [], invalid: 0, kept: [] });
    expect(result.run.marks['VIS-08']?.state).toBe('not_applicable');
  });
});
