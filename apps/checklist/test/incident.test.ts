// The incident runbook: dependency rules, times per step, and the generated timeline.

import { describe, expect, it } from 'vitest';
import { formatElapsed, formatUtc, missingFor, phaseProgress, refusalText, setTime, tick, timeline, untick, type IncidentLog, type IncidentResult } from '../src/incident.ts';
import { incidentMarkdown } from '../src/report.ts';
import { at, loadCatalogue, runWith } from './helpers.ts';

const catalogue = loadCatalogue();
const steps = catalogue.incident.steps;
const NOW = at(10_000);

function logOf(result: IncidentResult): IncidentLog {
  if (!result.ok) throw new Error(`refused: ${result.reason} ${result.steps.join(',')}`);
  return result.log;
}

/** Ticks steps in order, one minute apart from `start`. */
function tickAll(ids: readonly string[], start = 0, log: IncidentLog = {}): IncidentLog {
  return ids.reduce((l, id, i) => logOf(tick(steps, l, id, at(start + i), NOW)), log);
}

const PATH_TO_SECOND_PASS = ['snapshot', 'layer-files', 'layer-database', 'layer-users', 'layer-hosting', 'layer-dns-mail', 'layer-plugins', 'path-decided', 'content-inventory'];

describe('dependencies', () => {
  it('refuses "rotate real passwords" before "site isolated" and "admin lockout applied", and names what is missing', () => {
    const result = tick(steps, {}, 'rotate-passwords', at(0), NOW);
    expect(result).toEqual({ ok: false, reason: 'requires', steps: ['site-isolated', 'admin-lockout', 'second-pass-zero'] });
    expect(refusalText(catalogue, 'requires', ['site-isolated', 'admin-lockout'])).toBe('Needs first: Site isolated; Admin lockout applied.');
  });

  it('still refuses it with the site isolated but no lockout', () => {
    let log = tickAll(['site-isolated', ...PATH_TO_SECOND_PASS]);
    expect(missingFor(steps, log, 'rotate-passwords')).toEqual(['admin-lockout', 'second-pass-zero']);
    log = tickAll(['admin-lockout', 'restored-or-cleaned', 'second-pass-zero'], 20, log);
    expect(missingFor(steps, log, 'rotate-passwords')).toEqual([]);
    expect(tick(steps, log, 'rotate-passwords', at(30), NOW).ok).toBe(true);
  });

  it('refuses the admin lockout before the snapshot, so nothing is changed before evidence is kept', () => {
    expect(tick(steps, tickAll(['site-isolated']), 'admin-lockout', at(5), NOW)).toMatchObject({ ok: false, steps: ['snapshot'] });
  });

  it('lets every step be ticked in table order, so the table is a valid plan', () => {
    const log = tickAll(steps.map((s) => s.id));
    expect(Object.keys(log)).toHaveLength(steps.length);
    for (const p of catalogue.incident.phases) expect(phaseProgress(catalogue, log, p.number).done).toBe(phaseProgress(catalogue, log, p.number).total);
  });

  it('refuses to untick a step while a ticked step depends on it', () => {
    const log = tickAll(['site-isolated', 'snapshot', 'admin-lockout']);
    expect(untick(steps, log, 'site-isolated')).toEqual({ ok: false, reason: 'has_dependants', steps: ['admin-lockout'] });
    const without = logOf(untick(steps, log, 'admin-lockout'));
    expect(logOf(untick(steps, without, 'site-isolated'))['site-isolated']).toBeUndefined();
  });

  it('refuses unknown steps', () => {
    expect(tick(steps, {}, 'reboot', at(0), NOW)).toMatchObject({ ok: false, reason: 'unknown_step' });
  });
});

describe('times', () => {
  const log = tickAll(['site-isolated', 'snapshot', 'admin-lockout'], 0);

  it('keeps the time of each tick', () => {
    expect(log['snapshot']?.at).toBe(at(1).toISOString());
  });

  it('refuses a time before a step it requires', () => {
    expect(setTime(steps, log, 'admin-lockout', at(-5), NOW)).toEqual({ ok: false, reason: 'before_requirement', steps: ['site-isolated', 'snapshot'] });
  });

  it('refuses a time after a step that depends on it', () => {
    expect(setTime(steps, log, 'snapshot', at(9), NOW)).toEqual({ ok: false, reason: 'after_dependant', steps: ['admin-lockout'] });
  });

  it('refuses the future, a bad date, and a step not ticked', () => {
    expect(setTime(steps, log, 'admin-lockout', at(20_000), NOW)).toMatchObject({ reason: 'in_future' });
    expect(setTime(steps, log, 'admin-lockout', new Date('nope'), NOW)).toMatchObject({ reason: 'bad_time' });
    expect(setTime(steps, log, 'owner-told', at(3), NOW)).toMatchObject({ reason: 'not_ticked' });
  });

  it('moves a time inside the allowed window, kept to the minute', () => {
    expect(logOf(setTime(steps, log, 'snapshot', at(0.5), NOW))['snapshot']?.at).toBe(at(0).toISOString());
  });

  it('compares times to the minute, the precision the time input shows', () => {
    // Ticked at 13:00:30 and 13:00:45, both shown as 13:00. Setting the second to the 13:00 it shows is allowed.
    const a = logOf(tick(steps, {}, 'site-isolated', at(0.5), NOW));
    const b = logOf(tick(steps, a, 'snapshot', at(0.75), NOW));
    expect(a['site-isolated']?.at).toBe(at(0).toISOString());
    expect(logOf(setTime(steps, b, 'snapshot', at(0), NOW))['snapshot']?.at).toBe(at(0).toISOString());
    // A stored time with seconds, from an older run, is compared to the minute too.
    const old: IncidentLog = { 'site-isolated': { at: '2026-11-04T13:00:30.000Z', note: '' }, snapshot: { at: '2026-11-04T13:00:45.000Z', note: '' } };
    expect(setTime(steps, old, 'snapshot', at(0), NOW).ok).toBe(true);
  });

  it('refuses a tick timed before what it requires (a device clock that jumped back)', () => {
    expect(tick(steps, log, 'layer-files', at(-60), NOW)).toMatchObject({ ok: false, reason: 'before_requirement' });
  });
});

describe('the timeline', () => {
  it('orders by time, with the elapsed time from the first step', () => {
    let log = tickAll(['site-isolated'], 0);
    log = logOf(tick(steps, log, 'owner-told', at(65), NOW, 'phone call'));
    log = logOf(tick(steps, log, 'host-ticket', at(12), NOW));
    const entries = timeline(catalogue, log);
    expect(entries.map((e) => [e.step.id, formatElapsed(e.elapsed)])).toEqual([
      ['site-isolated', '+0 min'],
      ['host-ticket', '+12 min'],
      ['owner-told', '+1 h 05 min'],
    ]);
    expect(entries[2]?.note).toBe('phone call');
  });

  it('formats in UTC and days', () => {
    expect(formatUtc('2026-11-04T13:02:00.000Z')).toBe('2026-11-04 13:02 UTC');
    expect(formatElapsed((2 * 1440 + 3 * 60 + 7) * 60_000)).toBe('+2 d 3 h 07 min');
  });

  it('exports as a Markdown table with the steps still open', () => {
    const run = { ...runWith(catalogue, 'wordpress'), site: { name: 'Example Workshop', url: 'https://www.workshop.test/' }, incident: tickAll(['site-isolated', 'snapshot'], 0) };
    const text = incidentMarkdown(catalogue, { ...run, incident: { ...run.incident, snapshot: { at: at(1).toISOString(), note: 'files | db <b>' } } });
    expect(text).toContain('# Incident timeline: Example Workshop');
    expect(text).toContain('| 2026-11-04 13:00 UTC | +0 min | 1. Contain | Site isolated: public access blocked');
    expect(text).toContain('| files \\| db \\<b\\> |');
    expect(text).toContain(`## Not done (${steps.length - 2} of ${steps.length})`);
    expect(incidentMarkdown(catalogue, runWith(catalogue, 'wordpress'))).toContain('No step ticked yet.');
  });
});
