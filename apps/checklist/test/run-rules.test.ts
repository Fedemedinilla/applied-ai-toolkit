// The run's rules: what applies to a profile, the gate on Fixed, the gate on closing, a closed run,
// and the guard every stored or imported run passes through.

import { describe, expect, it } from 'vitest';
import {
  ackPostChange,
  ackPreChange,
  applies,
  closeRun,
  matrixApplies,
  parseRun,
  postChangePending,
  recordBaseline,
  reopenRun,
  repairRun,
  serialiseRun,
  setEvidence,
  setIncident,
  setProfile,
  setState,
  siteSlug,
  stateRefusal,
  type Run,
} from '../src/run.ts';
import { tick, type IncidentLog } from '../src/incident.ts';
import { at, loadCatalogue, ok, runWith } from './helpers.ts';

const catalogue = loadCatalogue();
const find = (id: string) => {
  const item = catalogue.items.find((i) => i.id === id);
  if (!item) throw new Error(id);
  return item;
};

function ackAllPre(run: Run): Run {
  return catalogue.preChange.reduce((r, row, i) => ok(ackPreChange(catalogue, r, row.id, true, at(10 + i))), run);
}

describe('applicability', () => {
  it('keeps the authorized checks out until the written authorization is ticked', () => {
    expect(applies(find('INT-05'), runWith(catalogue, 'wordpress').profile)).toBe(false);
    expect(applies(find('INT-05'), runWith(catalogue, 'wordpress', [], true).profile)).toBe(true);
    expect(applies(find('EXT-03'), runWith(catalogue, 'wordpress').profile)).toBe(true);
  });

  it('follows the platform and the features', () => {
    expect(applies(find('EXT-03'), runWith(catalogue, 'hosted').profile)).toBe(false);
    expect(applies(find('PLA-01'), runWith(catalogue, 'hosted-store', [], true).profile)).toBe(true);
    expect(applies(find('EXT-05'), runWith(catalogue, 'static').profile)).toBe(false);
    expect(applies(find('EXT-05'), runWith(catalogue, 'static', ['own-mail']).profile)).toBe(true);
    expect(applies(find('INT-30'), runWith(catalogue, 'wordpress', ['hosting-panel'], true).profile)).toBe(false);
    expect(applies(find('INT-30'), runWith(catalogue, 'wordpress', ['hosting-panel', 'own-mail'], true).profile)).toBe(true);
    expect(applies(find('COM-02'), runWith(catalogue, 'woocommerce', [], true).profile)).toBe(true);
    expect(applies(find('COM-02'), runWith(catalogue, 'wordpress', [], true).profile)).toBe(false);
  });

  it('asks for the payments row of the matrix only on a store', () => {
    const payments = catalogue.postChange.find((r) => r.id === 'payments');
    if (!payments) throw new Error('payments row');
    expect(matrixApplies(payments, runWith(catalogue, 'wordpress').profile)).toBe(false);
    expect(matrixApplies(payments, runWith(catalogue, 'hosted-store').profile)).toBe(true);
  });

  it('refuses a mark on a check outside the profile', () => {
    expect(stateRefusal(catalogue, runWith(catalogue, 'wordpress'), 'INT-01', 'fail')).toBe('not_in_profile');
    expect(stateRefusal(catalogue, runWith(catalogue, 'wordpress'), 'NOPE-01', 'fail')).toBe('unknown_item');
  });
});

describe('Fixed needs the pre-change list and an earlier failure', () => {
  const base = (): Run => ok(setState(catalogue, runWith(catalogue, 'wordpress', [], true), 'SEG-06', 'fail', at(1)));

  it('is refused while any pre-change row is unacknowledged', () => {
    let run = base();
    expect(setState(catalogue, run, 'SEG-06', 'fixed', at(2))).toEqual({ ok: false, reason: 'pre_change_pending' });
    for (const row of catalogue.preChange.slice(0, 5)) run = ok(ackPreChange(catalogue, run, row.id, true, at(3)));
    expect(setState(catalogue, run, 'SEG-06', 'fixed', at(4))).toEqual({ ok: false, reason: 'pre_change_pending' });
    run = ok(ackPreChange(catalogue, run, 'test-inventory', true, at(5)));
    expect(ok(setState(catalogue, run, 'SEG-06', 'fixed', at(6))).marks['SEG-06']?.state).toBe('fixed');
  });

  it('is refused on a check that never failed, even with the list acknowledged', () => {
    const run = ackAllPre(runWith(catalogue, 'wordpress', [], true));
    expect(setState(catalogue, run, 'SEG-06', 'fixed', at(20))).toEqual({ ok: false, reason: 'not_failed' });
  });

  it('accepts a check that failed in the recorded "before", whatever it shows now', () => {
    let run = ok(recordBaseline(base(), at(2)));
    run = ok(setState(catalogue, run, 'SEG-06', 'not_verified', at(3)));
    run = ackAllPre(run);
    expect(setState(catalogue, run, 'SEG-06', 'fixed', at(30)).ok).toBe(true);
  });

  it('keeps the pre-change list acknowledged while any check is Fixed', () => {
    let run = ackAllPre(base());
    run = ok(setState(catalogue, run, 'SEG-06', 'fixed', at(30)));
    expect(ackPreChange(catalogue, run, 'window', false, at(31))).toEqual({ ok: false, reason: 'fixed_items_exist' });
    run = ok(setState(catalogue, run, 'SEG-06', 'fail', at(32)));
    expect(ackPreChange(catalogue, run, 'window', false, at(33)).ok).toBe(true);
  });

  it('keeps the first acknowledgement time when a row is ticked twice', () => {
    const run = ok(ackPreChange(catalogue, ok(ackPreChange(catalogue, base(), 'window', true, at(5))), 'window', true, at(9)));
    expect(run.preChange.window).toBe(at(5).toISOString());
  });
});

describe('closing needs the post-change matrix', () => {
  it('is refused until every applicable row is acknowledged, then freezes the run', () => {
    let run = runWith(catalogue, 'wordpress', ['forms']);
    expect(postChangePending(catalogue, run).map((r) => r.id)).toEqual(['forms', 'admin-sign-in', 'key-pages', 'phone', 'cache-purged', 'anonymous', 'console', 'outgoing-mail']);
    expect(closeRun(catalogue, run, at(1))).toEqual({ ok: false, reason: 'post_change_pending' });
    for (const row of postChangePending(catalogue, run)) run = ok(ackPostChange(catalogue, run, row.id, true, at(2)));
    run = ok(closeRun(catalogue, run, at(3)));
    expect(run.closedAt).toBe(at(3).toISOString());

    expect(setState(catalogue, run, 'EXT-01', 'pass', at(4))).toEqual({ ok: false, reason: 'run_closed' });
    expect(setEvidence(catalogue, run, 'EXT-01', 'x', at(4))).toEqual({ ok: false, reason: 'run_closed' });
    expect(ackPostChange(catalogue, run, 'forms', false, at(4))).toEqual({ ok: false, reason: 'run_closed' });
    expect(setProfile(run, run.profile)).toEqual({ ok: false, reason: 'run_closed' });
    expect(closeRun(catalogue, run, at(5))).toEqual({ ok: false, reason: 'run_closed' });
    expect(setState(catalogue, reopenRun(run), 'EXT-01', 'pass', at(6)).ok).toBe(true);
  });

  it('asks for the payments row once the platform is a store', () => {
    let run = runWith(catalogue, 'wordpress');
    for (const row of postChangePending(catalogue, run)) run = ok(ackPostChange(catalogue, run, row.id, true, at(2)));
    expect(postChangePending(catalogue, run)).toEqual([]);
    run = ok(setProfile(run, { ...run.profile, platform: 'woocommerce' }));
    expect(postChangePending(catalogue, run).map((r) => r.id)).toEqual(['payments']);
  });
});

describe('the "before" snapshot', () => {
  it('keeps the marked states only, and is recorded once', () => {
    let run = ok(setState(catalogue, runWith(catalogue, 'wordpress'), 'EXT-02', 'fail', at(1)));
    run = ok(setEvidence(catalogue, run, 'EXT-03', 'only a note', at(2)));
    run = ok(recordBaseline(run, at(3)));
    expect(run.baseline).toEqual({ at: at(3).toISOString(), states: { 'EXT-02': 'fail' }, evidence: { 'EXT-02': '' } });
    expect(recordBaseline(run, at(4))).toEqual({ ok: false, reason: 'baseline_exists' });
  });
});

describe('the run JSON', () => {
  it('round-trips through export and import', () => {
    let run = ok(setState(catalogue, runWith(catalogue, 'wordpress'), 'EXT-02', 'fail', at(1)));
    run = { ...run, incident: { 'site-isolated': { at: at(2).toISOString(), note: 'deny all' } } };
    const parsed = parseRun(serialiseRun(run));
    expect(parsed).toEqual({ ok: true, run });
  });

  it('refuses text that is not JSON, and JSON that is not a run', () => {
    const good = JSON.parse(serialiseRun(runWith(catalogue, 'wordpress'))) as Record<string, unknown>;
    expect(parseRun('{ nope')).toEqual({ ok: false, reason: 'not_json' });
    const broken: unknown[] = [
      { ...good, format: 'other' },
      { ...good, marks: { 'EXT-01': { state: 'passed', evidence: '', at: at(0).toISOString() } } },
      { ...good, marks: { 'EXT-01': { state: 'pass', evidence: 3, at: at(0).toISOString() } } },
      { ...good, profile: { platform: 'wix', features: [], authorized: false } },
      { ...good, profile: { platform: 'wordpress', features: ['jetpack'], authorized: false } },
      { ...good, preChange: { window: 'yesterday' } },
      { ...good, closedAt: 12 },
      { ...good, incident: { x: { at: 'soon', note: '' } } },
      { ...good, imports: [{ source: 'other' }] },
    ];
    for (const value of broken) expect(parseRun(JSON.stringify(value)), JSON.stringify(value).slice(0, 80)).toEqual({ ok: false, reason: 'not_a_run' });
  });

  it('names files after the host, without www', () => {
    const run = runWith(catalogue, 'wordpress');
    expect(siteSlug({ ...run, site: { name: 'Example Workshop', url: 'https://www.workshop.test/contact' } })).toBe('workshop-test');
    expect(siteSlug({ ...run, site: { name: 'Taller Ñandú', url: '' } })).toBe('taller-nandu');
    expect(siteSlug(run)).toBe('site');
  });
});

describe('a loaded or stored run is checked against the rules, not only its shape', () => {
  const authorized = (): Run => runWith(catalogue, 'wordpress', [], true);
  const fixedMark = { state: 'fixed' as const, evidence: 'headers after the change', at: at(5).toISOString() };
  const allPre = (): Record<string, string> => Object.fromEntries(catalogue.preChange.map((r) => [r.id, at(1).toISOString()]));

  it('leaves a run the rules produced as it is, Fixed included', () => {
    let run = ackAllPre(ok(setState(catalogue, authorized(), 'SEG-06', 'fail', at(1))));
    run = ok(setState(catalogue, run, 'SEG-06', 'fixed', at(2)));
    expect(run.marks['SEG-06']?.fixedFrom).toBe('fail');
    // Editing the note keeps where the Fixed came from.
    run = ok(setEvidence(catalogue, run, 'SEG-06', 'retested', at(3)));
    expect(run.marks['SEG-06']?.fixedFrom).toBe('fail');
    const repaired = repairRun(catalogue, run);
    expect(repaired.dropped).toEqual([]);
    expect(repaired.run).toBe(run);
  });

  it('undoes a Fixed without the pre-change list, keeping its note', () => {
    const run: Run = { ...authorized(), marks: { 'SEG-06': { ...fixedMark, fixedFrom: 'fail' } } };
    const { run: next, dropped } = repairRun(catalogue, run);
    expect(next.marks['SEG-06']).toEqual({ state: null, evidence: 'headers after the change', at: at(5).toISOString() });
    expect(dropped).toEqual(['SEG-06 was Fixed without the pre-change list acknowledged; it is unmarked now.']);
  });

  it('undoes a Fixed on a check that never failed, and keeps one that failed in "before"', () => {
    const run: Run = {
      ...authorized(),
      preChange: allPre(),
      marks: { 'SEG-06': fixedMark, 'SEG-07': fixedMark },
      baseline: { at: at(0).toISOString(), states: { 'SEG-07': 'fail' }, evidence: { 'SEG-07': '' } },
    };
    const { run: next, dropped } = repairRun(catalogue, run);
    expect(next.marks['SEG-06']?.state).toBeNull();
    expect(next.marks['SEG-07']?.state).toBe('fixed');
    expect(dropped).toEqual(['SEG-06 was Fixed but never marked Fails; it is unmarked now.']);
  });

  it('reopens a run closed with post-change rows pending', () => {
    const run: Run = { ...authorized(), closedAt: at(9).toISOString() };
    const { run: next, dropped } = repairRun(catalogue, run);
    expect(next.closedAt).toBeNull();
    expect(dropped).toEqual([`The run was closed with ${postChangePending(catalogue, run).length} post-change rows pending; it is open now.`]);
  });

  it('unticks password rotation logged without isolation and lockout, and steps timed before what they require', () => {
    const e = (minute: number) => ({ at: at(minute).toISOString(), note: '' });
    const incident: IncidentLog = {
      'rotate-passwords': e(1),
      'site-isolated': e(5),
      snapshot: e(4),
      // Before the snapshot it requires.
      'indicators-recorded': e(2),
      reboot: e(3),
    };
    const { run: next, dropped } = repairRun(catalogue, { ...authorized(), incident });
    expect(Object.keys(next.incident).sort()).toEqual(['site-isolated', 'snapshot']);
    expect(dropped).toEqual(['Incident steps unknown or ticked before what they require, now unticked: reboot, indicators-recorded, rotate-passwords.']);
  });

  it('runs through parseRun: a tampered file passes the shape guard and is then repaired', () => {
    const tampered = serialiseRun({ ...authorized(), marks: { 'SEG-06': fixedMark } });
    const parsed = parseRun(tampered);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(repairRun(catalogue, parsed.run).run.marks['SEG-06']?.state).toBeNull();
    expect(parseRun(serialiseRun({ ...authorized(), marks: { 'SEG-06': { ...fixedMark, fixedFrom: 'pass' as never } } }))).toEqual({ ok: false, reason: 'not_a_run' });
  });
});

describe('the incident log of a closed run', () => {
  it('cannot change until the run is reopened', () => {
    const run: Run = { ...runWith(catalogue, 'wordpress'), closedAt: at(1).toISOString() };
    const result = tick(catalogue.incident.steps, run.incident, 'site-isolated', at(2), at(3));
    if (!result.ok) throw new Error(result.reason);
    expect(setIncident(run, result.log)).toEqual({ ok: false, reason: 'run_closed' });
    expect(ok(setIncident(reopenRun(run), result.log)).incident['site-isolated']?.at).toBe(at(2).toISOString());
  });
});
