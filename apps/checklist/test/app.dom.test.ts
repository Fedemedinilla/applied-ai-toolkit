// @vitest-environment jsdom
//
// The page against the real index.html: profile, marks, the Fixed gate, change control, the
// incident tab, import and export, and the warnings when storage is missing or fails.

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, type App } from '../src/app.ts';
import { serialiseRun, type Run } from '../src/run.ts';
import { memoryStore, type Store } from '../src/storage.ts';
import { appDir, at, fixture, loadCatalogue, runWith } from './helpers.ts';

const html = readFileSync(join(appDir, 'index.html'), 'utf8');
const catalogue = loadCatalogue();

interface Harness {
  app: App;
  downloads: { name: string; text: string; type: string }[];
  store: Store;
}

async function mount(store: Store = memoryStore(), confirm = true): Promise<Harness> {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceWith(document.importNode(parsed.body, true));
  const downloads: Harness['downloads'] = [];
  let minute = 0;
  const app = await startApp({
    doc: document,
    catalogue,
    store,
    now: () => at(minute++),
    download: (name, text, type) => downloads.push({ name, text, type }),
    confirm: () => confirm,
  });
  return { app, downloads, store };
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
};
const text = (selector: string): string => $(selector).textContent ?? '';

function choose(id: string, state: string): void {
  const select = $<HTMLSelectElement>(`#state-${id}`);
  select.value = state;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}
function typeEvidence(id: string, value: string): void {
  const box = $<HTMLTextAreaElement>(`#ev-${id}`);
  box.value = value;
  box.dispatchEvent(new Event('input', { bubbles: true }));
}
function toggle(selector: string, checked = true): void {
  const box = $<HTMLInputElement>(selector);
  box.checked = checked;
  box.dispatchEvent(new Event('change', { bubbles: true }));
}
async function upload(selector: string, content: string): Promise<void> {
  const input = $<HTMLInputElement>(selector);
  const file = new File([content], 'datos.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the checklist tab', () => {
  it('starts with every passive check of the default profile, all grey, with the denominator', async () => {
    await mount();
    expect(document.querySelectorAll('#items > li')).toHaveLength(42);
    expect(text('#summary')).toContain('Fix now: 0 to fix now, of 42 applicable');
    expect(text('#summary')).toContain('Could not check: 42 not checked, of 42 applicable');
    expect(text('#summary')).toContain('42 not marked yet');
    expect(text('#list-count')).toBe('Showing 42 of 42 checks in this profile and phase.');
  });

  it('adds the internal checks when the authorization is ticked, and the mail checks with own mail', async () => {
    await mount();
    toggle('#authorized');
    toggle('#feature-own-mail');
    const n = document.querySelectorAll('#items > li').length;
    expect(n).toBeGreaterThan(100);
    expect($('#item-INT-05')).toBeTruthy();
    expect($('#item-EXT-05')).toBeTruthy();
  });

  it('derives the colour from the state and turns a pass green only with evidence', async () => {
    const { app } = await mount();
    choose('EXT-04', 'fail');
    expect($('#item-EXT-04').dataset.colour).toBe('red');
    expect(text('#badge-EXT-04')).toContain('Fix now');
    choose('EXT-07', 'pass');
    expect(text('#badge-EXT-07')).toContain('Could not check (no evidence note)');
    const box = $<HTMLTextAreaElement>('#ev-EXT-07');
    box.focus();
    typeEvidence('EXT-07', 'tls.json, 80 days left');
    expect(text('#badge-EXT-07')).toBe('● Good');
    // The evidence box was not rebuilt, so the cursor stays where the user types.
    expect(document.activeElement).toBe(box);
    // The summary is a live region: it waits for a pause or for the box to lose focus, so a screen
    // reader does not read it out on every key.
    expect(text('#summary')).toContain('0 good, of 42 applicable');
    await app.idle();
    expect(text('#summary')).toContain('1 to fix now, of 42 applicable');
    expect(text('#summary')).toContain('1 good, of 42 applicable');
    expect((await memoryStoreLoad(app)).marks['EXT-07']?.evidence).toBe('tls.json, 80 days left');
  });

  it('refuses Fixed before the pre-change list, says why, and puts the select back', async () => {
    await mount();
    choose('EXT-02', 'fail');
    choose('EXT-02', 'fixed');
    expect($<HTMLSelectElement>('#state-EXT-02').value).toBe('fail');
    expect(text('#msg-EXT-02')).toBe('Fixed needs the pre-change list acknowledged first (Change control tab).');
    for (const row of catalogue.preChange) toggle(`#pre-${row.id}`);
    expect(text('#pre-status')).toBe('Acknowledged: checks can now be marked Fixed.');
    choose('EXT-02', 'fixed');
    expect($<HTMLSelectElement>('#state-EXT-02').value).toBe('fixed');
    expect(text('#msg-EXT-02')).toBe('');
  });

  it('filters by phase, colour and text', async () => {
    await mount();
    toggle('#authorized');
    choose('EXT-04', 'fail');
    const phase = $<HTMLSelectElement>('#filter-phase');
    phase.value = '2';
    phase.dispatchEvent(new Event('change'));
    expect([...document.querySelectorAll('#items > li')].every((li) => li.id.startsWith('item-INT-'))).toBe(true);
    expect(text('#summary-scope')).toContain('Phase 2, Internal diagnosis');
    phase.value = '';
    phase.dispatchEvent(new Event('change'));
    const colour = $<HTMLSelectElement>('#filter-colour');
    colour.value = 'red';
    colour.dispatchEvent(new Event('change'));
    expect([...document.querySelectorAll('#items > li')].map((li) => li.id)).toEqual(['item-EXT-04']);
    colour.value = '';
    colour.dispatchEvent(new Event('change'));
    const q = $<HTMLInputElement>('#filter-q');
    q.value = 'xml-rpc';
    q.dispatchEvent(new Event('input'));
    expect([...document.querySelectorAll('#items > li')].map((li) => li.id)).toEqual(['item-EXT-11', 'item-SEG-07']);
  });
});

async function memoryStoreLoad(app: App) {
  await app.idle();
  return app.run();
}

describe('change control', () => {
  it('closes only after the matrix, then locks the marks until reopened', async () => {
    await mount();
    $<HTMLButtonElement>('#tab-control').click();
    $<HTMLButtonElement>('#close-run').click();
    expect(text('#close-status')).toBe('Closing needs every row of the post-change matrix acknowledged (Change control tab).');
    const rows = [...document.querySelectorAll<HTMLInputElement>('#post-change input')];
    expect(rows.map((r) => r.id)).not.toContain('post-payments');
    for (const r of rows) toggle(`#${r.id}`);
    $<HTMLButtonElement>('#close-run').click();
    expect($('#closed-banner').hidden).toBe(false);
    expect($<HTMLSelectElement>('#state-EXT-01').disabled).toBe(true);
    expect(document.activeElement?.id).toBe('reopen-run');
    $<HTMLButtonElement>('#reopen-run').click();
    expect($<HTMLSelectElement>('#state-EXT-01').disabled).toBe(false);
  });

  it('records "before" once', async () => {
    const { app } = await mount();
    choose('EXT-02', 'fail');
    $<HTMLButtonElement>('#record-baseline').click();
    expect(app.run().baseline?.states).toEqual({ 'EXT-02': 'fail' });
    expect($<HTMLButtonElement>('#record-baseline').disabled).toBe(true);
    expect(text('#baseline-status')).toContain('with 1 marked check.');
  });
});

describe('the incident tab', () => {
  it('will not tick "rotate real passwords" before isolation and lockout, and shows why', async () => {
    await mount();
    expect(text('#needs-rotate-passwords')).toBe('Needs first: Site isolated; Admin lockout applied; Second full pass over the six layers counts zero indicators.');
    toggle('#step-rotate-passwords');
    expect($<HTMLInputElement>('#step-rotate-passwords').checked).toBe(false);
    expect(text('#msg-step-rotate-passwords')).toContain('Needs first: Site isolated');
  });

  it('keeps a time per step and builds the timeline', async () => {
    const { app } = await mount();
    $<HTMLButtonElement>('#tab-incident').click();
    toggle('#step-site-isolated');
    toggle('#step-snapshot');
    expect(document.activeElement?.id).toBe('step-snapshot');
    expect($<HTMLInputElement>('#time-snapshot').value).toMatch(/^2026-11-04T13:\d{2}$/u);
    const items = [...document.querySelectorAll('#timeline li')].map((li) => li.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('1. Contain: Site isolated');
    const note = $<HTMLInputElement>('#note-snapshot');
    note.value = 'stored on the encrypted drive';
    note.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.run().incident.snapshot?.note).toBe('stored on the encrypted drive');
    // A time before the step it requires is refused and put back.
    const time = $<HTMLInputElement>('#time-snapshot');
    time.value = '2026-11-04T12:00';
    time.dispatchEvent(new Event('change', { bubbles: true }));
    expect(text('#msg-step-snapshot')).toBe('');
    toggle('#step-admin-lockout');
    const lock = $<HTMLInputElement>('#time-admin-lockout');
    lock.value = '2026-11-04T11:00';
    lock.dispatchEvent(new Event('change', { bubbles: true }));
    expect(text('#msg-step-admin-lockout')).toContain('That time is before a step it requires');
    $<HTMLButtonElement>('#export-incident').click();
  });

  it('is read-only while the run is closed', async () => {
    const closed: Run = { ...runWith(catalogue, 'wordpress'), incident: { 'site-isolated': { at: at(0).toISOString(), note: '' } } };
    let saved = 0;
    const store: Store = { kind: 'indexeddb', load: async () => ({ run: { ...closed, closedAt: null }, invalid: false, unreadable: false }), save: async () => (saved++, true) };
    const { app } = await mount(store);
    for (const r of [...document.querySelectorAll<HTMLInputElement>('#post-change input')]) toggle(`#${r.id}`);
    $<HTMLButtonElement>('#close-run').click();
    expect($<HTMLInputElement>('#step-snapshot').disabled).toBe(true);
    expect($<HTMLInputElement>('#step-site-isolated').disabled).toBe(true);
    expect($<HTMLInputElement>('#time-site-isolated').disabled).toBe(true);
    expect($<HTMLInputElement>('#note-site-isolated').disabled).toBe(true);
    // A change event that gets through anyway is refused and put back.
    await app.idle();
    const before = saved;
    toggle('#step-snapshot');
    expect($<HTMLInputElement>('#step-snapshot').checked).toBe(false);
    expect(text('#msg-step-snapshot')).toBe('This run is closed. Reopen it to change anything.');
    expect(app.run().incident.snapshot).toBeUndefined();
    await app.idle();
    expect(saved).toBe(before);
  });

  it('refuses to untick a step others depend on', async () => {
    await mount();
    toggle('#step-snapshot');
    toggle('#step-layer-files');
    toggle('#step-snapshot', false);
    expect($<HTMLInputElement>('#step-snapshot').checked).toBe(true);
    expect(text('#msg-step-snapshot')).toBe('Untick these first, they depend on it: Files.');
  });
});

describe('reports and data', () => {
  it('imports a site-check datos.json and reports what it did', async () => {
    const { app } = await mount();
    await upload('#import-sitecheck', fixture('datos.json'));
    expect(text('#status')).toContain('Imported site-check run of workshop.test (2026-10-20): 3 checks pre-filled. 3 outside the site profile: EXT-05, VIS-08, EXT-25.');
    expect($<HTMLSelectElement>('#state-EXT-07').value).toBe('pass');
    expect($('#item-EXT-07').dataset.colour).toBe('green');
    expect($<HTMLInputElement>('#site-url').value).toBe('https://www.workshop.test/');
    expect(app.run().imports).toHaveLength(1);
  });

  it('refuses a file that is not a datos.json', async () => {
    await mount();
    await upload('#import-sitecheck', '{"hello": 1}');
    expect(text('#status')).toBe('Not imported. The file does not look like a site-check datos.json (no checks list or no domain).');
  });

  it('exports the check report, the run JSON, and the before and after report only after "before"', async () => {
    const { downloads } = await mount();
    choose('EXT-04', 'fail');
    $<HTMLButtonElement>('#export-check').click();
    $<HTMLButtonElement>('#export-run').click();
    $<HTMLButtonElement>('#export-before-after').click();
    expect(text('#status')).toBe('The before and after report needs "before" recorded in Change control.');
    $<HTMLButtonElement>('#record-baseline').click();
    $<HTMLButtonElement>('#export-before-after').click();
    expect(downloads.map((d) => d.name)).toEqual(['report-site-2026-11-04.md', 'run-site-2026-11-04.json', 'report-before-after-site-2026-11-04.md']);
    expect(downloads[0]?.text).toContain('1 to fix now, of 42 applicable');
    expect(JSON.parse(downloads[1]?.text ?? '{}')).toMatchObject({ format: 'site-checklist-run', marks: { 'EXT-04': { state: 'fail' } } });
  });

  it('loads a run JSON back, and refuses anything else', async () => {
    const first = await mount();
    choose('EXT-04', 'fail');
    $<HTMLButtonElement>('#export-run').click();
    const exported = first.downloads[0]?.text ?? '';
    const second = await mount();
    await upload('#import-run', exported);
    expect(text('#status')).toBe('Run loaded.');
    expect(second.app.run().marks['EXT-04']?.state).toBe('fail');
    // A file that passes the shape guard but breaks the rules: rotation ticked before the lockout.
    const tampered: Run = { ...runWith(catalogue, 'wordpress'), incident: { 'rotate-passwords': { at: at(1).toISOString(), note: '' } } };
    await upload('#import-run', serialiseRun(tampered));
    expect(text('#status')).toBe('Run loaded. 1 entry breaks a rule and was undone. Incident step unknown or ticked before what they require, now unticked: rotate-passwords.');
    expect(second.app.run().incident).toEqual({});
    await upload('#import-run', '{"format": "site-checklist-run"}');
    expect(text('#status')).toBe('Not loaded. The file is not a run exported from this app.');
  });
});

describe('storage', () => {
  it('warns when nothing can be stored', async () => {
    await mount(memoryStore());
    expect($('#storage-warning').hidden).toBe(false);
    expect(text('#storage-warning')).toContain('Export the run JSON to keep it.');
  });

  it('warns once when a save fails, and keeps working', async () => {
    const failing: Store = { kind: 'indexeddb', load: async () => ({ run: null, invalid: false, unreadable: false }), save: async () => false };
    const { app } = await mount(failing);
    expect($('#storage-warning').hidden).toBe(true);
    choose('EXT-04', 'fail');
    await app.idle();
    expect(text('#storage-warning')).toContain('Saving failed');
    expect(app.run().marks['EXT-04']?.state).toBe('fail');
  });

  it('writes nothing over a stored run it could not read, and says so', async () => {
    let saved = 0;
    const unreadable: Store = { kind: 'indexeddb', load: async () => ({ run: null, invalid: false, unreadable: true }), save: async () => (saved++, false) };
    const { app } = await mount(unreadable);
    expect(text('#storage-warning')).toContain('nothing from this session is saved over it');
    choose('EXT-04', 'fail');
    await app.idle();
    // The warning is not replaced by the generic save failure.
    expect(text('#storage-warning')).toContain('nothing from this session is saved over it');
  });

  it('repairs a stored run that breaks a rule, and says what it undid', async () => {
    const stored: Run = { ...runWith(catalogue, 'wordpress'), closedAt: at(0).toISOString() };
    const store: Store = { kind: 'indexeddb', load: async () => ({ run: stored, invalid: false, unreadable: false }), save: async () => true };
    const { app } = await mount(store);
    expect(app.run().closedAt).toBeNull();
    expect(text('#storage-warning')).toContain('post-change rows pending; it is open now.');
  });

  it('starts from the stored run', async () => {
    const store = memoryStore();
    const first = await mount(store);
    choose('EXT-04', 'fail');
    await first.app.idle();
    await mount(store);
    expect($<HTMLSelectElement>('#state-EXT-04').value).toBe('fail');
  });
});

describe('tabs', () => {
  it('moves with the arrow keys, Home and End, and shows one panel', async () => {
    await mount();
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs[0]?.focus();
    tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabs[1]);
    expect($('#panel-control').hidden).toBe(false);
    expect($('#panel-checks').hidden).toBe(true);
    tabs[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(tabs[3]);
    tabs[3]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true')).toEqual([tabs[0]]);
  });
});
