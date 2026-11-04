// The page: wires index.html to the run, the rules and the exports. Every change goes through one
// function (apply), which takes a Result from run.ts, saves it and re-renders. A refused change shows
// its reason next to the control and changes nothing.

import { FEATURES, PLATFORMS, type Catalogue, type FeatureId, type Item, type PlatformId } from './catalogue.ts';
import { COLOUR_INFO, COLOURS, countLine, itemColour, summarise, type Colour, type Derived } from './colours.ts';
import { builder, byId, type H } from './dom.ts';
import { formatElapsed, formatUtc, missingFor, phaseProgress, refusalText, setNote, setTime, stepTitle, tick, timeline, untick, type IncidentResult } from './incident.ts';
import { incidentMarkdown, reportMarkdown } from './report.ts';
import {
  ackPostChange,
  ackPreChange,
  applies,
  closeRun,
  matrixApplies,
  newRun,
  parseRun,
  postChangePending,
  preChangeDone,
  recordBaseline,
  reopenRun,
  REFUSALS,
  repairRun,
  serialiseRun,
  setEvidence,
  setIncident,
  setProfile,
  setSite,
  setState,
  siteSlug,
  STATE_LABELS,
  STATE_MEANINGS,
  STATES,
  type Result,
  type Run,
  type State,
} from './run.ts';
import { IMPORT_REFUSALS, importSiteCheck, importSummaryText } from './sitecheck-import.ts';
import type { Store } from './storage.ts';

export interface AppOptions {
  readonly doc: Document;
  readonly catalogue: Catalogue;
  readonly store: Store;
  readonly now?: () => Date;
  readonly download?: (name: string, text: string, type: string) => void;
  readonly confirm?: (message: string) => boolean;
}

export interface App {
  run(): Run;
  /** Resolves when every write started so far has finished. */
  idle(): Promise<void>;
}

function browserDownload(doc: Document): (name: string, text: string, type: string) => void {
  return (name, text, type) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = doc.createElement('a');
    a.href = url;
    a.download = name;
    a.hidden = true;
    doc.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}

const GREY_TEXT = { not_marked: 'not marked yet', not_verified: 'not verified', no_evidence: 'no evidence note' } as const;

function badgeText(d: Derived): { shape: string; label: string; detail: string } {
  if (d.colour === null) return { shape: '–', label: 'Not applicable', detail: '' };
  const info = COLOUR_INFO[d.colour];
  const detail = d.grey ? GREY_TEXT[d.grey] : (d.note ?? '');
  return { shape: info.shape, label: info.label, detail };
}

/**
 * "2026-11-04T13:02" for a datetime-local input. The input shows UTC on purpose, not the device's
 * zone, so the times typed match the timeline, which reads the same on every device.
 */
const toUtcInput = (iso: string): string => iso.slice(0, 16);
const fromUtcInput = (value: string): Date => new Date(`${value}:00Z`);

export async function startApp(options: AppOptions): Promise<App> {
  const { doc, catalogue, store } = options;
  const now = options.now ?? (() => new Date());
  const download = options.download ?? browserDownload(doc);
  const confirmFn = options.confirm ?? ((m: string) => doc.defaultView?.confirm(m) ?? false);
  const h: H = builder(doc);
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => byId<T>(doc, id);

  const loaded = await store.load();
  // A stored run passed the shape guard; the rules are checked again, as for a loaded file.
  const repaired = loaded.run ? repairRun(catalogue, loaded.run) : null;
  let run: Run = repaired?.run ?? newRun(catalogue, now());
  let writes: Promise<unknown> = Promise.resolve();
  // After a failed read the store refuses writes; the warning below already says why.
  let saveFailed = loaded.unreadable;

  const status = $('status');
  const say = (text: string): void => {
    status.textContent = text;
  };

  const warning = $('storage-warning');
  const warn = (text: string): void => {
    warning.textContent = text;
    warning.hidden = !text;
  };
  if (store.kind === 'memory') warn('This browser does not let the app store data, so the run lasts until the tab closes. Export the run JSON to keep it.');
  else if (loaded.unreadable) {
    warn('The stored run could not be read this time. It is left as it was, and nothing from this session is saved over it. Reload to try again, or export the run JSON to keep this one.');
  } else if (loaded.invalid) warn('A stored run could not be read. It was kept aside and a new run was started.');
  else if (repaired?.dropped.length) warn(`The stored run broke some rules, which were undone. ${repaired.dropped.join(' ')}`);

  function persist(): void {
    const snapshot = run;
    writes = writes.then(() =>
      store.save(snapshot).then((ok) => {
        if (!ok && !saveFailed) {
          saveFailed = true;
          warn('Saving failed, so changes from now on may be lost when the tab closes. Export the run JSON to keep it.');
        }
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Tabs: the ARIA tab pattern, with arrow keys, Home and End.

  const tabs = [...doc.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  function selectTab(tab: HTMLButtonElement, focus: boolean): void {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = doc.getElementById(t.getAttribute('aria-controls') ?? '');
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
  }
  for (const [i, tab] of tabs.entries()) {
    tab.addEventListener('click', () => selectTab(tab, false));
    tab.addEventListener('keydown', (e) => {
      const last = tabs.length - 1;
      const to = e.key === 'ArrowRight' ? (i === last ? 0 : i + 1) : e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
      const target = tabs[to];
      if (to < 0 || !target) return;
      e.preventDefault();
      selectTab(target, true);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Site and profile

  const siteName = $<HTMLInputElement>('site-name');
  const siteUrl = $<HTMLInputElement>('site-url');
  const platform = $<HTMLSelectElement>('platform');
  const authorized = $<HTMLInputElement>('authorized');
  const featureBox = $('features');
  platform.append(...PLATFORMS.map((p) => h('option', { value: p.id }, p.label)));
  for (const f of FEATURES) {
    featureBox.append(h('div', { class: 'check' }, h('input', { type: 'checkbox', id: `feature-${f.id}`, 'data-feature': f.id }), h('label', { for: `feature-${f.id}` }, f.label)));
  }

  function renderProfile(): void {
    siteName.value = run.site.name;
    siteUrl.value = run.site.url;
    platform.value = run.profile.platform;
    authorized.checked = run.profile.authorized;
    for (const box of featureBox.querySelectorAll<HTMLInputElement>('input[data-feature]')) {
      box.checked = run.profile.features.includes(box.dataset.feature as FeatureId);
    }
    $('site-line').textContent = run.site.name || run.site.url ? `${run.site.name || run.site.url}${run.site.name && run.site.url ? `, ${run.site.url}` : ''}` : 'A website audit, check by check. Works offline.';
    const closed = run.closedAt !== null;
    for (const el of [siteName, siteUrl, platform, authorized, ...featureBox.querySelectorAll('input')]) (el as HTMLInputElement).disabled = closed;
    $('closed-banner').hidden = !closed;
  }

  function readProfile(): void {
    const features = [...featureBox.querySelectorAll<HTMLInputElement>('input[data-feature]')].filter((b) => b.checked).map((b) => b.dataset.feature as FeatureId);
    apply(setProfile(run, { platform: platform.value as PlatformId, features, authorized: authorized.checked }), { list: true });
  }
  platform.addEventListener('change', readProfile);
  authorized.addEventListener('change', readProfile);
  featureBox.addEventListener('change', readProfile);
  const readSite = (): void => apply(setSite(run, { name: siteName.value.trim(), url: siteUrl.value.trim() }), {});
  siteName.addEventListener('change', readSite);
  siteUrl.addEventListener('change', readSite);

  // ---------------------------------------------------------------------------------------------
  // Filters, summary and the list

  const phaseFilter = $<HTMLSelectElement>('filter-phase');
  const colourFilter = $<HTMLSelectElement>('filter-colour');
  const query = $<HTMLInputElement>('filter-q');
  const phasesWithItems = [...new Set(catalogue.items.map((i) => i.phase))].sort((a, b) => a - b);
  phaseFilter.append(h('option', { value: '' }, 'Every phase'));
  for (const n of phasesWithItems) {
    const name = catalogue.phases.find((p) => p.number === n)?.name ?? `Phase ${n}`;
    phaseFilter.append(h('option', { value: String(n) }, `${n}. ${name}`));
  }
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  phaseFilter.addEventListener('change', () => renderChecks());
  colourFilter.addEventListener('change', () => renderList());
  query.addEventListener('input', () => renderList());

  const selectedPhase = (): number | null => (phaseFilter.value === '' ? null : Number(phaseFilter.value));

  function renderSummary(): void {
    const phase = selectedPhase();
    const s = summarise(catalogue, run, phase);
    const phaseName = phase === null ? 'Every phase' : `Phase ${phase}, ${catalogue.phases.find((p) => p.number === phase)?.name ?? ''}`;
    $('summary-scope').textContent = `${phaseName}: ${s.applicable} applicable of ${s.inProfile} in this profile${s.notApplicable ? ` (${s.notApplicable} marked not applicable)` : ''}.`;
    const list = $('summary');
    list.replaceChildren(
      ...COLOURS.map((c) =>
        h('li', { 'data-colour': c }, h('span', { class: 'shape', 'aria-hidden': 'true' }, COLOUR_INFO[c].shape), ' ', h('strong', {}, `${COLOUR_INFO[c].label}:`), ' ', countLine(c, s)),
      ),
    );
    const greys: string[] = [];
    if (s.unmarked) greys.push(`${s.unmarked} not marked yet`);
    if (s.noEvidence) greys.push(`${s.noEvidence} passed without an evidence note`);
    if (greys.length) list.append(h('li', { class: 'aside' }, `Of the ones not checked: ${greys.join(', ')}.`));
    const bar = $('summary-bar');
    bar.replaceChildren(...COLOURS.filter((c) => s.colours[c] > 0).map((c) => h('span', { 'data-colour': c, 'data-count': s.colours[c] })));
    for (const seg of bar.querySelectorAll<HTMLElement>('span')) seg.style.flexGrow = seg.dataset.count ?? '0';
  }

  function badge(d: Derived, id: string): HTMLElement {
    const t = badgeText(d);
    return h(
      'span',
      { class: 'badge', 'data-colour': d.colour ?? 'na', id: `badge-${id}` },
      h('span', { class: 'shape', 'aria-hidden': 'true' }, t.shape),
      ' ',
      h('span', { class: 'badge-label' }, t.label),
      t.detail ? h('span', { class: 'badge-detail' }, ` (${t.detail})`) : null,
    );
  }

  function itemRow(item: Item): HTMLLIElement {
    const mark = run.marks[item.id];
    const d = itemColour(item, run);
    const closed = run.closedAt !== null;
    const select = h('select', { id: `state-${item.id}`, 'data-item': item.id, disabled: closed, 'aria-describedby': `msg-${item.id}` }, h('option', { value: '' }, 'Not marked'));
    for (const s of STATES) select.append(h('option', { value: s }, STATE_LABELS[s]));
    select.value = mark?.state ?? '';
    const evidence = h('textarea', { id: `ev-${item.id}`, 'data-item': item.id, rows: 2, disabled: closed, placeholder: 'What proves it: a header value, a file name, a screenshot name' });
    evidence.value = mark?.evidence ?? '';
    const facts: [string, string | null][] = [
      ['Where', item.where],
      ['Pass when', item.pass],
      ['If it fails', item.ifFails],
      ['Do not touch', item.doNotTouch],
      ['Priority', `${item.priority}, ${item.area}`],
      ['Access', item.access === 'passive' ? 'Passive: what any visitor sees' : 'Needs written authorization and access'],
    ];
    return h(
      'li',
      { class: 'item', id: `item-${item.id}`, 'data-colour': d.colour ?? 'na' },
      h('div', { class: 'item-head' }, h('h3', {}, h('span', { class: 'id' }, item.id), ' ', item.title), badge(d, item.id)),
      h('p', { class: 'question' }, item.question),
      h('details', {}, h('summary', {}, 'How to check'), h('dl', {}, ...facts.filter(([, v]) => v).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '')]))),
      h(
        'div',
        { class: 'mark' },
        h('div', { class: 'field' }, h('label', { for: `state-${item.id}` }, `State of ${item.id}`), select),
        h('div', { class: 'field grow' }, h('label', { for: `ev-${item.id}` }, `Evidence for ${item.id}`), evidence),
      ),
      h('p', { class: 'item-msg', id: `msg-${item.id}`, 'aria-live': 'polite' }),
    );
  }

  function visibleItems(): { items: Item[]; inProfile: number } {
    const phase = selectedPhase();
    const q = query.value.trim().toLowerCase();
    const colour = colourFilter.value;
    const inScope = catalogue.items.filter((i) => (phase === null || i.phase === phase) && applies(i, run.profile));
    const items = inScope.filter((item) => {
      if (q && !`${item.id} ${item.title} ${item.question}`.toLowerCase().includes(q)) return false;
      if (!colour) return true;
      const d = itemColour(item, run);
      if (colour === 'na') return d.colour === null;
      if (colour === 'unmarked') return d.grey === 'not_marked';
      return d.colour === colour;
    });
    return { items, inProfile: inScope.length };
  }

  function renderList(): void {
    const { items, inProfile } = visibleItems();
    $('list-count').textContent = `Showing ${items.length} of ${inProfile} ${inProfile === 1 ? 'check' : 'checks'} in this profile and phase.`;
    $('items').replaceChildren(...items.map(itemRow));
  }

  /** Updates one row's colour without rebuilding it, so typing in its evidence box keeps focus. */
  function refreshItem(id: string): void {
    const item = catalogue.items.find((i) => i.id === id);
    const row = doc.getElementById(`item-${id}`);
    if (!item || !row) return;
    const d = itemColour(item, run);
    row.dataset.colour = d.colour ?? 'na';
    doc.getElementById(`badge-${id}`)?.replaceWith(badge(d, id));
  }

  const renderChecks = (): void => {
    renderSummary();
    renderList();
  };

  const list = $('items');
  list.addEventListener('change', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLSelectElement) || !target.dataset.item) return;
    const id = target.dataset.item;
    const state = (target.value || null) as State | null;
    const result = setState(catalogue, run, id, state, now());
    const msg = doc.getElementById(`msg-${id}`);
    if (!result.ok) {
      target.value = run.marks[id]?.state ?? '';
      if (msg) msg.textContent = REFUSALS[result.reason];
      return;
    }
    if (msg) msg.textContent = '';
    apply(result, { item: id });
  });
  let evidenceTimer: ReturnType<typeof setTimeout> | undefined;
  // The summary is a live region: redrawn on every key, a screen reader would read it out while
  // the note is typed. The row's badge updates at once; the summary waits for a pause.
  let summaryTimer: ReturnType<typeof setTimeout> | undefined;
  const flushEvidence = (): void => {
    if (summaryTimer !== undefined) {
      clearTimeout(summaryTimer);
      summaryTimer = undefined;
      renderSummary();
    }
    if (evidenceTimer !== undefined) {
      clearTimeout(evidenceTimer);
      evidenceTimer = undefined;
      persist();
    }
  };
  list.addEventListener('input', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLTextAreaElement) || !target.dataset.item) return;
    const id = target.dataset.item;
    const result = setEvidence(catalogue, run, id, target.value, now());
    if (!result.ok) return;
    run = result.run;
    refreshItem(id);
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => {
      summaryTimer = undefined;
      renderSummary();
    }, 600);
    clearTimeout(evidenceTimer);
    evidenceTimer = setTimeout(() => {
      evidenceTimer = undefined;
      persist();
    }, 400);
  });
  list.addEventListener('focusout', (e) => {
    if (e.target instanceof HTMLTextAreaElement) flushEvidence();
  });

  // ---------------------------------------------------------------------------------------------
  // Change control

  function tickRow(kind: 'pre' | 'post', id: string, label: Node | string, at: string | undefined, disabled: boolean): HTMLLIElement {
    const inputId = `${kind}-${id}`;
    return h(
      'li',
      {},
      h('input', { type: 'checkbox', id: inputId, 'data-kind': kind, 'data-row': id, checked: at !== undefined, disabled }),
      h('label', { for: inputId }, label, at ? h('span', { class: 'when' }, ` Acknowledged ${formatUtc(at)}.`) : null),
    );
  }

  function renderControl(): void {
    const closed = run.closedAt !== null;
    $('pre-change').replaceChildren(...catalogue.preChange.map((r) => tickRow('pre', r.id, r.text, run.preChange[r.id], closed)));
    const preDone = preChangeDone(catalogue, run);
    const preCount = catalogue.preChange.filter((r) => run.preChange[r.id]).length;
    $('pre-status').textContent = preDone ? 'Acknowledged: checks can now be marked Fixed.' : `${preCount} of ${catalogue.preChange.length} acknowledged. Fixed is locked until all are.`;

    $('post-change').replaceChildren(
      ...catalogue.postChange
        .filter((r) => matrixApplies(r, run.profile))
        .map((r) => tickRow('post', r.id, h('span', {}, h('strong', {}, r.what), `. ${r.how}. Pass when: ${r.pass}.`), run.postChange[r.id], closed)),
    );
    const pending = postChangePending(catalogue, run);
    const total = catalogue.postChange.filter((r) => matrixApplies(r, run.profile)).length;
    $('post-status').textContent = pending.length ? `${total - pending.length} of ${total} acknowledged. The run closes when all are.` : `All ${total} acknowledged.`;

    $('baseline-status').textContent = run.baseline
      ? `Recorded ${formatUtc(run.baseline.at)}, with ${Object.keys(run.baseline.states).length} marked ${Object.keys(run.baseline.states).length === 1 ? 'check' : 'checks'}.`
      : 'Not recorded yet. Record it when the diagnosis is done and before the first change.';
    ($('record-baseline') as HTMLButtonElement).disabled = closed || run.baseline !== null;

    const closeBtn = $<HTMLButtonElement>('close-run');
    const reopenBtn = $<HTMLButtonElement>('reopen-run');
    closeBtn.hidden = closed;
    reopenBtn.hidden = !closed;
    $('close-status').textContent = closed ? `Closed ${formatUtc(run.closedAt ?? '')}.` : pending.length ? `${pending.length} matrix ${pending.length === 1 ? 'row' : 'rows'} still to acknowledge.` : 'Ready to close.';
  }

  $('panel-control').addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !t.dataset.row) return;
    const result = t.dataset.kind === 'pre' ? ackPreChange(catalogue, run, t.dataset.row, t.checked, now()) : ackPostChange(catalogue, run, t.dataset.row, t.checked, now());
    if (!result.ok) {
      t.checked = !t.checked;
      $(t.dataset.kind === 'pre' ? 'pre-status' : 'post-status').textContent = REFUSALS[result.reason];
      return;
    }
    apply(result, { focus: t.id });
  });
  $('record-baseline').addEventListener('click', () => apply(recordBaseline(run, now()), { message: '"Before" recorded.' }));
  $('close-run').addEventListener('click', () => {
    const result = closeRun(catalogue, run, now());
    if (!result.ok) {
      $('close-status').textContent = REFUSALS[result.reason];
      return;
    }
    apply(result, { list: true, message: 'Run closed.', focus: 'reopen-run' });
  });
  $('reopen-run').addEventListener('click', () => apply({ ok: true, run: reopenRun(run) }, { list: true, message: 'Run reopened.', focus: 'close-run' }));

  // ---------------------------------------------------------------------------------------------
  // Incident

  function stepRow(stepId: string): HTMLElement {
    const step = catalogue.incident.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(stepId);
    const entry = run.incident[step.id];
    const missing = missingFor(catalogue.incident.steps, run.incident, step.id);
    const state = entry ? 'done' : missing.length ? 'blocked' : 'ready';
    const needsId = `needs-${step.id}`;
    const closed = run.closedAt !== null;
    const row = h(
      'div',
      { class: 'step', 'data-state': state },
      h(
        'div',
        { class: 'check' },
        h('input', { type: 'checkbox', id: `step-${step.id}`, 'data-step': step.id, checked: entry !== undefined, disabled: closed, 'aria-describedby': `${needsId} msg-step-${step.id}` }),
        h('label', { for: `step-${step.id}` }, step.text),
      ),
      h('p', { class: 'needs', id: needsId }, missing.length && !entry ? `Needs first: ${missing.map((m) => stepTitle(catalogue, m)).join('; ')}.` : ''),
    );
    if (entry) {
      row.append(
        h(
          'div',
          { class: 'step-meta' },
          h('div', { class: 'field' }, h('label', { for: `time-${step.id}` }, 'Done at (UTC)'), h('input', { type: 'datetime-local', id: `time-${step.id}`, 'data-step-time': step.id, value: toUtcInput(entry.at), step: 60, disabled: closed })),
          h('div', { class: 'field grow' }, h('label', { for: `note-${step.id}` }, 'Note'), h('input', { type: 'text', id: `note-${step.id}`, 'data-step-note': step.id, value: entry.note, disabled: closed })),
        ),
      );
    }
    row.append(h('p', { class: 'item-msg', id: `msg-step-${step.id}`, 'aria-live': 'polite' }));
    return row;
  }

  function renderIncident(): void {
    const box = $('incident');
    box.replaceChildren(
      ...catalogue.incident.phases.map((p) => {
        const progress = phaseProgress(catalogue, run.incident, p.number);
        return h(
          'fieldset',
          { class: 'card phase' },
          h('legend', {}, `${p.number}. ${p.name} `, h('span', { class: 'progress' }, `${progress.done} of ${progress.total} done`)),
          ...catalogue.incident.steps.filter((s) => s.phase === p.number).map((s) => stepRow(s.id)),
        );
      }),
    );
    const entries = timeline(catalogue, run.incident);
    $('timeline').replaceChildren(
      ...(entries.length
        ? entries.map((e) => h('li', {}, h('span', { class: 'when' }, `${formatUtc(e.at)}, ${formatElapsed(e.elapsed)}`), ' ', `${e.step.phase}. ${e.phaseName}: ${stepTitle(catalogue, e.step.id)}`, e.note ? `. Note: ${e.note}` : ''))
        : [h('li', { class: 'aside' }, 'No step ticked yet.')]),
    );
  }

  function incidentChange(stepId: string, result: IncidentResult, focus: string, revert: () => void): void {
    const msg = doc.getElementById(`msg-step-${stepId}`);
    const next = result.ok ? setIncident(run, result.log) : null;
    if (!result.ok || !next?.ok) {
      revert();
      if (msg) msg.textContent = !result.ok ? refusalText(catalogue, result.reason, result.steps) : REFUSALS.run_closed;
      return;
    }
    apply(next, { focus });
  }

  const incidentBox = $('incident');
  incidentBox.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    const steps = catalogue.incident.steps;
    if (t.dataset.step) {
      const id = t.dataset.step;
      const at = now();
      const result = t.checked ? tick(steps, run.incident, id, at, at) : untick(steps, run.incident, id);
      incidentChange(id, result, t.id, () => (t.checked = !t.checked));
    } else if (t.dataset.stepTime) {
      const id = t.dataset.stepTime;
      const before = run.incident[id]?.at ?? '';
      incidentChange(id, setTime(steps, run.incident, id, fromUtcInput(t.value), now()), t.id, () => (t.value = toUtcInput(before)));
    } else if (t.dataset.stepNote) {
      const id = t.dataset.stepNote;
      incidentChange(id, setNote(steps, run.incident, id, t.value.trim()), t.id, () => undefined);
    }
  });
  $('export-incident').addEventListener('click', () => {
    download(`incident-${siteSlug(run)}-${now().toISOString().slice(0, 10)}.md`, incidentMarkdown(catalogue, run), 'text/markdown');
    say('Timeline downloaded.');
  });

  // ---------------------------------------------------------------------------------------------
  // Reports and data

  const date = (): string => now().toISOString().slice(0, 10);
  $('export-check').addEventListener('click', () => {
    download(`report-${siteSlug(run)}-${date()}.md`, reportMarkdown(catalogue, run, 'check', now()), 'text/markdown');
    say('Report downloaded.');
  });
  $('export-before-after').addEventListener('click', () => {
    if (!run.baseline) {
      say('The before and after report needs "before" recorded in Change control.');
      return;
    }
    download(`report-before-after-${siteSlug(run)}-${date()}.md`, reportMarkdown(catalogue, run, 'before-after', now()), 'text/markdown');
    say('Before and after report downloaded.');
  });
  $('export-run').addEventListener('click', () => {
    download(`run-${siteSlug(run)}-${date()}.json`, serialiseRun(run), 'application/json');
    say('Run downloaded.');
  });

  const readFile = async (input: HTMLInputElement): Promise<string | null> => {
    const file = input.files?.[0];
    input.value = '';
    return file ? file.text() : null;
  };
  $<HTMLInputElement>('import-sitecheck').addEventListener('change', async (e) => {
    const text = await readFile(e.currentTarget as HTMLInputElement);
    if (text === null) return;
    const result = importSiteCheck(catalogue, run, text, now());
    if (!result.ok) {
      say(`Not imported. ${IMPORT_REFUSALS[result.reason]}${result.detail ? ` (${result.detail})` : ''}`);
      return;
    }
    apply({ ok: true, run: result.run }, { list: true, message: importSummaryText(result.summary) });
  });
  $<HTMLInputElement>('import-run').addEventListener('change', async (e) => {
    const text = await readFile(e.currentTarget as HTMLInputElement);
    if (text === null) return;
    const parsed = parseRun(text);
    if (!parsed.ok) {
      say(parsed.reason === 'not_json' ? 'Not loaded. The file is not JSON.' : 'Not loaded. The file is not a run exported from this app.');
      return;
    }
    const other = parsed.run.catalogueId === catalogue.id ? '' : ' It was filled against another version of the catalogue; checks that changed keep their old states.';
    // The file passed the shape guard; what breaks a rule is undone and said, not trusted.
    const { run: loadedRun, dropped } = repairRun(catalogue, parsed.run);
    const undone = dropped.length ? ` ${dropped.length} ${dropped.length === 1 ? 'entry breaks' : 'entries break'} a rule and ${dropped.length === 1 ? 'was' : 'were'} undone. ${dropped.join(' ')}` : '';
    apply({ ok: true, run: loadedRun }, { list: true, message: `Run loaded.${other}${undone}` });
  });
  $('reset-run').addEventListener('click', () => {
    if (!confirmFn('Start a new run? The current one is replaced. Export it first if you need it.')) return;
    apply({ ok: true, run: newRun(catalogue, now()) }, { list: true, message: 'New run started.' });
  });
  $('storage-status').textContent =
    store.kind === 'indexeddb' ? 'The run is saved in this browser (IndexedDB) after each change.' : 'Nothing is saved in this browser. Export the run JSON to keep it.';

  const statesLegend = $('states-legend');
  for (const s of STATES) statesLegend.append(h('dt', {}, STATE_LABELS[s]), h('dd', {}, STATE_MEANINGS[s]));
  $('colours-legend').replaceChildren(
    ...COLOURS.map((c: Colour) => h('li', { 'data-colour': c }, h('span', { class: 'shape', 'aria-hidden': 'true' }, COLOUR_INFO[c].shape), ' ', h('strong', {}, `${COLOUR_INFO[c].label}:`), ' ', COLOUR_INFO[c].meaning)),
  );

  // ---------------------------------------------------------------------------------------------

  interface Redraw {
    readonly list?: boolean;
    readonly item?: string;
    readonly focus?: string;
    readonly message?: string;
  }

  function apply(result: Result, redraw: Redraw): void {
    if (!result.ok) {
      say(REFUSALS[result.reason]);
      return;
    }
    run = result.run;
    persist();
    renderProfile();
    if (redraw.list) renderList();
    if (redraw.item) refreshItem(redraw.item);
    renderSummary();
    renderControl();
    renderIncident();
    if (redraw.message) say(redraw.message);
    // Re-rendered controls are new elements: focus goes back to the one that was used.
    if (redraw.focus) doc.getElementById(redraw.focus)?.focus();
  }

  renderProfile();
  renderChecks();
  renderControl();
  renderIncident();

  return {
    run: () => run,
    idle: async () => {
      flushEvidence();
      await writes;
    },
  };
}
