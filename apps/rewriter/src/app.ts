// The page. It asks ./api/health once: with a server that has a key, it shows the form and sends
// rewrites to it; without one (GitHub Pages answers 404), it shows the recorded examples and makes
// no call. Either way a result is shown in three panels: the original with its findings, the
// rewrite with each change and a button to revert it, and the facts, flags, status and cost.
//
// Every text from the model, the server or the examples goes into the page as text nodes, never as
// markup. The CV lives only in its text box: nothing here writes it to storage, a cookie or the URL.

import { failureMessage, health, requestRewrite, type ApiFetch, type Health } from './api.ts';
import { asDemoSet, EXAMPLES_URL, type DemoExample, type DemoSet } from './demo.ts';
import { markSegments } from './marks.ts';
import {
  GENRE_LABEL,
  GENRES,
  LANG_LABEL,
  LANGS,
  MAX_CV_CHARS,
  MAX_FIELD_CHARS,
  MAX_KEEP,
  MAX_KEEP_CHARS,
  MAX_PREVIOUS_CHARS,
  MAX_TEXT_CHARS,
  MODE_LABEL,
  MODES,
  REGISTER_LABEL,
  REGISTERS,
  VARIETIES,
  VARIETY_LABEL,
  type Genre,
  type Lang,
  type Mode,
  type Register,
  type RewriteRequest,
  type Variety,
} from './protocol.ts';
import { appliedIds, recompose } from './recompose.ts';
import type { FlagKind, Result, ResultChange, ResultFinding, ResultLint, Status } from './result.ts';

export interface AppDeps {
  readonly fetch: ApiFetch;
  /** Writes text to the clipboard; absent when the browser has no clipboard. */
  readonly copy?: (text: string) => Promise<void>;
  readonly rewriteTimeoutMs?: number;
  readonly healthTimeoutMs?: number;
}

export interface App {
  /** Resolves once the page knows its mode and shows either the form or the first example. */
  readonly ready: Promise<void>;
}

const STATUS_TEXT: Readonly<Record<Status, { label: string; text: string }>> = {
  ok: { label: 'OK', text: 'Every change kept passed the fact checks.' },
  'needs-review': {
    label: 'Needs review',
    text: 'A change was taken back for adding a fact, a fact went missing, or a check could not read the model\'s reply. Read the flags and the changes taken back before you send it.',
  },
  blocked: { label: 'Blocked', text: 'The rewrite still states something neither your text nor your CV backs. Do not send it as it is.' },
};

const FLAG_LABEL: Readonly<Record<FlagKind, string>> = {
  'not-in-cv': 'Not in your CV',
  'missing-fact': 'Missing fact',
  'tone-risk': 'Tone',
  length: 'Length',
  injection: 'Reads like an instruction',
};

const FACT_GROUPS: ReadonlyArray<{ key: keyof Result['facts']; label: string }> = [
  { key: 'fromCv', label: 'Added from your CV' },
  { key: 'notInCv', label: 'Only your text states these: kept, never strengthened' },
  { key: 'added', label: 'Added with nothing behind them' },
  { key: 'dropped', label: 'Dropped' },
  { key: 'placeholders', label: 'Left for you to fill in' },
  { key: 'kept', label: 'Kept' },
];

const changeNumber = (id: string): string => id.replace(/^e/u, '');

export function mountApp(doc: Document, deps: AppDeps): App {
  const byId = <T extends HTMLElement>(id: string): T => {
    const found = doc.getElementById(id);
    if (!found) throw new Error(`#${id} is missing from the page`);
    return found as T;
  };
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className !== undefined) node.className = className;
    return node;
  };

  const modeBanner = byId('mode');
  const statusLine = byId('status');
  const demoSection = byId('demo');
  const demoIntro = byId('demo-intro');
  const demoList = byId('demo-list');
  const demoInput = byId('demo-input');
  const form = byId<HTMLFormElement>('form');
  const resultSection = byId('result');
  const resultHeading = byId('result-heading');
  const originalBox = byId('original');
  const findingsList = byId('findings');
  const rewrittenBox = byId('rewritten');
  const changesList = byId('changes');
  const changesHint = byId('changes-hint');
  const revertedWrap = byId('reverted-wrap');
  const revertedList = byId('reverted');
  const copyButton = byId<HTMLButtonElement>('copy');
  const keepAll = byId<HTMLButtonElement>('keep-all');
  const revertAll = byId<HTMLButtonElement>('revert-all');
  const verdict = byId('verdict');
  const messageLine = byId('message');
  const flagsList = byId('flags');
  const factsList = byId('facts');
  const lintLine = byId('lint');
  const costLine = byId('cost');

  const fields = {
    text: byId<HTMLTextAreaElement>('text'),
    genre: byId<HTMLSelectElement>('genre'),
    lang: byId<HTMLSelectElement>('lang'),
    variety: byId<HTMLSelectElement>('variety'),
    register: byId<HTMLSelectElement>('register'),
    mode: byId<HTMLSelectElement>('rewrite-mode'),
    name: byId<HTMLInputElement>('to-name'),
    org: byId<HTMLInputElement>('to-org'),
    role: byId<HTMLInputElement>('to-role'),
    previous: byId<HTMLTextAreaElement>('previous'),
    keep: byId<HTMLTextAreaElement>('keep'),
    cv: byId<HTMLTextAreaElement>('cv'),
  };
  const previousField = byId('previous-field');
  const submit = byId<HTMLButtonElement>('submit');

  const say = (text: string): void => {
    statusLine.textContent = text;
  };

  // --- the form ------------------------------------------------------------------------------

  const fill = (select: HTMLSelectElement, options: ReadonlyArray<[string, string]>): void => {
    select.replaceChildren(...options.map(([value, label]) => Object.assign(make('option', label), { value })));
  };
  fill(fields.genre, GENRES.map((g) => [g, GENRE_LABEL[g]]));
  fill(fields.lang, LANGS.map((l) => [l, LANG_LABEL[l]]));
  fill(fields.variety, VARIETIES.map((v) => [v, VARIETY_LABEL[v]]));
  fill(fields.register, [['', 'The genre\'s default'], ...REGISTERS.map((r): [string, string] => [r, REGISTER_LABEL[r]])]);
  fill(fields.mode, [['', 'The genre\'s default'], ...MODES.map((m): [string, string] => [m, MODE_LABEL[m]])]);
  fields.genre.value = 'email';
  fields.text.maxLength = MAX_TEXT_CHARS;
  fields.cv.maxLength = MAX_CV_CHARS;
  fields.previous.maxLength = MAX_PREVIOUS_CHARS;
  for (const input of [fields.name, fields.org, fields.role]) input.maxLength = MAX_FIELD_CHARS;

  const syncForm = (): void => {
    const spanish = fields.lang.value === 'es';
    fields.variety.disabled = !spanish;
    previousField.hidden = fields.genre.value !== 'follow-up';
  };
  fields.lang.addEventListener('change', syncForm);
  fields.genre.addEventListener('change', syncForm);
  syncForm();

  const trimmed = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim());

  /** The request, or the first field to fix with what to say. */
  function readForm(): { ok: true; body: RewriteRequest } | { ok: false; field: HTMLElement; message: string } {
    const text = fields.text.value;
    const cv = fields.cv.value;
    if (text.trim() === '') return { ok: false, field: fields.text, message: 'Write or paste the text to rewrite.' };
    if (cv.trim() === '') return { ok: false, field: fields.cv, message: 'Paste your CV: it is the only source of facts the rewrite may use.' };
    const keep = fields.keep.value
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    if (keep.length > MAX_KEEP) return { ok: false, field: fields.keep, message: `Up to ${MAX_KEEP} phrases to leave as they are.` };
    if (keep.some((k) => k.length > MAX_KEEP_CHARS)) return { ok: false, field: fields.keep, message: `Each phrase to leave as it is fits in ${MAX_KEEP_CHARS} characters.` };
    const lang = fields.lang.value as Lang;
    const genre = fields.genre.value as Genre;
    const name = trimmed(fields.name.value);
    const org = trimmed(fields.org.value);
    const role = trimmed(fields.role.value);
    const previous = genre === 'follow-up' ? trimmed(fields.previous.value) : undefined;
    const recipient = {
      ...(name === undefined ? {} : { name }),
      ...(org === undefined ? {} : { org }),
      ...(role === undefined ? {} : { role }),
      ...(previous === undefined ? {} : { previousMessage: fields.previous.value }),
    };
    const body: RewriteRequest = {
      text,
      genre,
      lang,
      ...(lang === 'es' ? { variety: fields.variety.value as Variety } : {}),
      ...(fields.register.value ? { register: fields.register.value as Register } : {}),
      ...(fields.mode.value ? { mode: fields.mode.value as Mode } : {}),
      ...(Object.keys(recipient).length > 0 ? { recipient } : {}),
      ...(keep.length > 0 ? { keep } : {}),
      cv,
    };
    return { ok: true, body };
  }

  let inFlight: AbortController | null = null;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const read = readForm();
    if (!read.ok) {
      say(read.message);
      read.field.focus();
      return;
    }
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    submit.disabled = true;
    say('Rewriting. A rewrite takes a few calls to the model and can take a minute.');
    void requestRewrite(deps.fetch, read.body, controller.signal, deps.rewriteTimeoutMs).then((answer) => {
      if (inFlight !== controller) return;
      inFlight = null;
      submit.disabled = false;
      if (!answer.ok) {
        say(failureMessage(answer.code, answer.fields));
        return;
      }
      show(answer.reply.original, answer.reply.result, read.body.lang);
      say(summary(answer.reply.result));
      resultHeading.focus();
    });
  });

  // --- the result ----------------------------------------------------------------------------

  interface Shown {
    readonly original: string;
    readonly result: Result;
    readonly lang: Lang;
    readonly accepted: Set<string>;
    /** False when the changes do not rebuild the returned rewrite: then it is shown as returned, with no buttons. */
    readonly rebuildable: boolean;
  }
  let shown: Shown | null = null;

  const applied = (r: Result): ResultChange[] => r.changes.filter((c) => c.status === 'applied');
  const kept = (s: Shown): number => applied(s.result).filter((c) => s.accepted.has(c.id)).length;

  function summary(r: Result): string {
    const a = applied(r).length;
    const back = r.changes.length - a;
    const changes = a === 0 ? 'no change' : a === 1 ? '1 change' : `${a} changes`;
    const taken = back === 0 ? '' : `, ${back} taken back by the checks`;
    return `Rewritten with ${changes}${taken}. Status: ${STATUS_TEXT[r.status].label}.`;
  }

  function currentText(s: Shown): string {
    if (!s.rebuildable) return s.result.rewritten;
    const r = recompose(s.original, s.result.changes, s.accepted);
    return r.ok ? r.text : s.result.rewritten;
  }

  function renderOriginal(s: Shown): void {
    const findings = s.result.lint.before.findings;
    originalBox.lang = s.lang;
    originalBox.replaceChildren(
      ...markSegments(s.original, findings).map((seg) => {
        if (seg.marks.length === 0) return doc.createTextNode(seg.text);
        const mark = make('mark', seg.text);
        const level = Math.min(...seg.marks.map((i) => findings[i]?.level ?? 3));
        mark.dataset['level'] = String(level);
        mark.title = seg.marks.map((i) => findings[i]?.ruleId ?? '').join(', ');
        return mark;
      }),
    );
    findingsList.replaceChildren(...(findings.length === 0 ? [make('li', 'None.', 'empty')] : findings.map((f) => findingItem(f, s.lang))));
  }

  function findingItem(f: ResultFinding, lang: Lang): HTMLLIElement {
    const li = make('li', undefined, `finding level-${f.level}`);
    const head = make('p', undefined, 'finding-head');
    head.append(make('span', f.ruleId, 'rule'), make('span', `level ${f.level}`, 'level'));
    if (f.match.trim() !== '') {
      const quote = make('q', f.match);
      quote.lang = lang;
      head.append(quote);
    }
    li.append(head, make('p', f.message), make('p', f.suggestion, 'hint'));
    return li;
  }

  function renderRewritten(s: Shown): void {
    rewrittenBox.lang = s.lang;
    if (!s.rebuildable) {
      rewrittenBox.replaceChildren(doc.createTextNode(s.result.rewritten));
      return;
    }
    const r = recompose(s.original, s.result.changes, s.accepted);
    if (!r.ok) return;
    rewrittenBox.replaceChildren(
      ...r.pieces.map((p) => {
        if (p.kind === 'same') return doc.createTextNode(p.text);
        if (p.kind === 'restored') {
          const span = make('span', p.text, 'restored');
          span.title = `Change ${changeNumber(p.id)} reverted: your words`;
          return span;
        }
        const ins = make('ins', p.text);
        ins.title = `Change ${changeNumber(p.id)}`;
        if (p.text === '') ins.className = 'cut';
        return ins;
      }),
    );
  }

  function diffLine(c: ResultChange, lang: Lang): HTMLParagraphElement {
    const p = make('p', undefined, 'diff');
    const del = make('del', c.before === '' ? '(nothing)' : c.before);
    del.lang = lang;
    const ins = make('ins', c.after === '' ? '(removed)' : c.after);
    ins.lang = lang;
    if (c.after === '') ins.className = 'cut';
    p.append(make('span', 'Your words: ', 'visually-hidden'), del, make('span', ' → ', 'arrow'), make('span', 'Rewrite: ', 'visually-hidden'), ins);
    return p;
  }

  function changeItem(s: Shown, c: ResultChange): HTMLLIElement {
    const li = make('li', undefined, 'change');
    li.id = `change-${c.id}`;
    const head = make('p', undefined, 'change-head');
    head.append(make('span', `Change ${changeNumber(c.id)}`, 'change-id'));
    if (c.ruleId) head.append(make('span', c.ruleId, 'rule'));
    const state = make('span', '', 'state');
    head.append(state);
    const reason = make('p', c.reason, 'reason');
    reason.lang = s.lang;
    li.append(head, diffLine(c, s.lang), reason);
    if (c.status === 'reverted') {
      li.classList.add('taken-back');
      state.textContent = 'Taken back';
      if (c.revertReason) li.append(make('p', `Why: ${c.revertReason}`, 'hint'));
      return li;
    }
    if (!s.rebuildable) return li;
    const button = make('button', '', 'secondary toggle');
    button.type = 'button';
    const setState = (): void => {
      const on = s.accepted.has(c.id);
      li.dataset['state'] = on ? 'kept' : 'reverted';
      state.textContent = on ? 'Kept' : 'Reverted: your words';
      button.replaceChildren(doc.createTextNode(on ? 'Revert' : 'Keep'), make('span', ` change ${changeNumber(c.id)}`, 'visually-hidden'));
    };
    setState();
    button.addEventListener('click', () => {
      if (s.accepted.has(c.id)) s.accepted.delete(c.id);
      else s.accepted.add(c.id);
      setState();
      renderRewritten(s);
      say(s.accepted.has(c.id) ? `Change ${changeNumber(c.id)} kept.` : `Change ${changeNumber(c.id)} reverted: your words are back.`);
    });
    li.append(button);
    return li;
  }

  function renderChanges(s: Shown): void {
    const live = applied(s.result);
    const back = s.result.changes.filter((c) => c.status === 'reverted');
    changesList.replaceChildren(...(live.length === 0 ? [make('li', 'No change.', 'empty')] : live.map((c) => changeItem(s, c))));
    revertedWrap.hidden = back.length === 0;
    revertedList.replaceChildren(...back.map((c) => changeItem(s, c)));
    const buttons = s.rebuildable && live.length > 0;
    keepAll.hidden = !buttons;
    revertAll.hidden = !buttons;
    changesHint.textContent = s.rebuildable
      ? 'Reverting a change puts your own words back in its place, so it cannot add a fact.'
      : 'This result cannot be rebuilt change by change, so it is shown as returned and its changes cannot be reverted here.';
  }

  function lintText(l: ResultLint): string {
    const n = l.findings.length;
    const levels = [1, 2, 3].map((level) => `level ${level}: ${l.findings.filter((f) => f.level === level).length}`).join(', ');
    return `${n} ${n === 1 ? 'pattern' : 'patterns'} (${levels}), score ${l.score.points} of ${l.score.max}`;
  }

  function renderFacts(s: Shown, demo: boolean): void {
    const r = s.result;
    const v = STATUS_TEXT[r.status];
    verdict.dataset['status'] = r.status;
    verdict.replaceChildren(make('strong', v.label, 'badge'), doc.createTextNode(` ${v.text}`));
    messageLine.hidden = r.message === undefined;
    messageLine.textContent = r.message ?? '';
    messageLine.lang = s.lang;
    flagsList.replaceChildren(
      ...(r.flags.length === 0
        ? [make('li', 'None.', 'empty')]
        : r.flags.map((f) => {
            const li = make('li', undefined, `flag flag-${f.kind}`);
            const text = make('span', f.message);
            text.lang = s.lang;
            li.append(make('strong', `${FLAG_LABEL[f.kind]}: `), text);
            return li;
          })),
    );
    const groups = FACT_GROUPS.filter((g) => r.facts[g.key].length > 0);
    factsList.replaceChildren(
      ...(groups.length === 0
        ? [make('dt', 'No facts found.')]
        : groups.flatMap((g) => {
            const dd = make('dd');
            dd.append(...r.facts[g.key].flatMap((fact, i) => [...(i > 0 ? [doc.createTextNode(', ')] : []), make('code', fact)]));
            return [make('dt', g.label), dd];
          })),
    );
    lintLine.replaceChildren(
      make('span', `Before: ${lintText(r.lint.before)}.`),
      make('br'),
      make('span', `After: ${lintText(r.lint.after)}.`),
    );
    const { calls, costUsd } = r.usage;
    const callText = calls === 0 ? 'No model call' : calls === 1 ? '1 model call' : `${calls} model calls`;
    const cost = costUsd === null ? 'cost not priced (the gateway has no price for a model)' : `US$${costUsd.toFixed(4)}`;
    costLine.textContent = `${callText}, ${cost}${demo ? ', as recorded' : ''}.`;
  }

  function show(original: string, result: Result, lang: Lang, demo = false): void {
    const accepted = appliedIds(result.changes);
    const all = recompose(original, result.changes, accepted);
    shown = { original, result, lang, accepted, rebuildable: all.ok && all.text === result.rewritten };
    resultSection.hidden = false;
    renderOriginal(shown);
    renderRewritten(shown);
    renderChanges(shown);
    renderFacts(shown, demo);
  }

  const setAll = (keep: boolean): void => {
    const s = shown;
    if (s === null || !s.rebuildable) return;
    s.accepted.clear();
    if (keep) for (const id of appliedIds(s.result.changes)) s.accepted.add(id);
    renderRewritten(s);
    // Update the items in place, so focus stays where it was.
    for (const c of applied(s.result)) doc.getElementById(`change-${c.id}`)?.replaceWith(changeItem(s, c));
    say(keep ? `Every change kept: ${kept(s)}.` : 'Every change reverted: the text is yours as you wrote it.');
  };
  keepAll.addEventListener('click', () => setAll(true));
  revertAll.addEventListener('click', () => setAll(false));

  copyButton.addEventListener('click', () => {
    const s = shown;
    if (s === null) return;
    if (!deps.copy) {
      say('This browser gives the page no clipboard. Select the text and copy it.');
      return;
    }
    deps.copy(currentText(s)).then(
      () => say(`Copied the text, with ${kept(s)} of ${applied(s.result).length} changes kept.`),
      () => say('The browser did not allow the copy. Select the text and copy it.'),
    );
  });

  // --- the demo ------------------------------------------------------------------------------

  function describeInput(e: DemoExample): void {
    const i = e.input;
    const facts: Array<[string, string]> = [
      ['Kind', GENRE_LABEL[i.genre]],
      ['Language', LANG_LABEL[i.lang]],
      ...(i.variety ? [['Variety', VARIETY_LABEL[i.variety]] as [string, string]] : []),
      ['How far', MODE_LABEL[i.mode]],
      ...(i.recipient ? [['Recipient', [i.recipient.name, i.recipient.role, i.recipient.org].filter(Boolean).join(', ')] as [string, string]] : []),
    ];
    const dl = make('dl', undefined, 'meta');
    for (const [k, v] of facts) {
      const pair = make('div');
      pair.append(make('dt', k), make('dd', v));
      dl.append(pair);
    }
    const parts: Node[] = [make('p', e.note), dl];
    if (i.recipient?.previousMessage) {
      const details = make('details');
      const prev = make('p', i.recipient.previousMessage, 'text small');
      prev.lang = i.lang;
      details.append(make('summary', 'The earlier message'), prev);
      parts.push(details);
    }
    demoInput.replaceChildren(...parts);
  }

  function showExample(set: DemoSet, id: string): void {
    const e = set.examples.find((x) => x.id === id);
    if (!e) return;
    describeInput(e);
    show(e.input.text.normalize('NFC'), e.result, e.input.lang, true);
  }

  async function startDemo(state: Health): Promise<void> {
    modeBanner.textContent =
      state === 'no-key'
        ? 'Your local server is running without ANTHROPIC_API_KEY, so it cannot rewrite. Below are recorded rewrites instead.'
        : 'Demo: there is no server behind this page, so it shows rewrites the model made earlier, of invented texts. Nothing you do here is sent anywhere.';
    modeBanner.dataset['mode'] = 'demo';
    let set: DemoSet | null = null;
    try {
      const res = await deps.fetch(EXAMPLES_URL, { cache: 'no-store' });
      set = res.ok ? asDemoSet(await res.json()) : null;
    } catch {
      set = null;
    }
    if (set === null) {
      say('The recorded examples could not be loaded.');
      return;
    }
    const loaded = set;
    demoIntro.textContent = `${loaded.examples.length} real rewrites by the model, recorded on ${loaded.recorded}. The texts, the people and the CVs they were checked against are invented.`;
    demoList.replaceChildren(
      ...loaded.examples.map((e, i) => {
        const label = make('label', undefined, 'option');
        const radio = make('input');
        radio.type = 'radio';
        radio.name = 'example';
        radio.value = e.id;
        radio.checked = i === 0;
        radio.addEventListener('change', () => {
          if (radio.checked) {
            showExample(loaded, e.id);
            say(`${e.title}. ${summary(e.result)}`);
          }
        });
        label.append(radio, make('span', e.title));
        return label;
      }),
    );
    demoSection.hidden = false;
    const first = loaded.examples[0];
    if (first) showExample(loaded, first.id);
  }

  const ready = (async () => {
    const state = await health(deps.fetch, deps.healthTimeoutMs);
    if (state === 'up') {
      modeBanner.textContent = 'Local server found. Your text and CV go to it, and it calls the model through the gateway with its spending caps.';
      modeBanner.dataset['mode'] = 'local';
      form.hidden = false;
      return;
    }
    await startDemo(state);
  })();

  return { ready };
}
