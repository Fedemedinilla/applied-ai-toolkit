// The DOM layer of the book tab. It binds to the markup in index.html, which the DOM tests load as
// is, and keeps all decisions in the pure modules. Text from the owner reaches the page only as
// text nodes, through h() in dom.ts.

import { toCsv } from './csv.ts';
import { readSentence, resolve, type Answer, type Draft, type Row } from './entry.ts';
import { localDay, localTime, money, signedMoney } from './format.ts';
import { categorise, type Kind } from './categories.ts';
import { byDay, totalsFor, undoLast, type DayTotals } from './ledger.ts';
import { mountCorpus } from './corpus-view.ts';
import { fact, h, need, sentenceView } from './dom.ts';
import { loadRows, saveRows, type KeyValue } from './storage.ts';
import { speechError, type RecognitionConstructor } from './speech.ts';

export interface AppDeps {
  storage: KeyValue | null;
  now(): Date;
  newId(): string;
  /** Resolves to the raw corpus JSON. Called the first time the phrases tab opens. */
  loadCorpus(): Promise<unknown>;
  recognition: RecognitionConstructor | null;
  download(fileName: string, text: string): void;
}

const KIND_LABEL: Record<Kind, string> = { income: 'Ingreso', expense: 'Gasto' };

function dayLabel(day: string, today: Date): string {
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day === localDay(today)) return 'Hoy';
  if (day === localDay(yesterday)) return 'Ayer';
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
}

export function mountApp(root: Document, deps: AppDeps): void {
  const form = need<HTMLFormElement>(root, '#entry-form');
  const input = need<HTMLInputElement>(root, '#entry-input');
  const dictate = need<HTMLButtonElement>(root, '#dictate');
  const preview = need<HTMLElement>(root, '#preview');
  const status = need<HTMLElement>(root, '#status');
  const days = need<HTMLElement>(root, '#days');
  const undoButton = need<HTMLButtonElement>(root, '#undo');
  const exportButton = need<HTMLButtonElement>(root, '#export');
  const warning = need<HTMLElement>(root, '#storage-warning');
  const today = need<HTMLElement>(root, '#today');

  const loaded = loadRows(deps.storage, String(deps.now().getTime()));
  let rows: Row[] = loaded.rows;
  let draft: Draft | null = null;
  let kindOverride: Kind | null = null;
  let persistent = loaded.available && loaded.writable;
  /** True while the status line holds the "type something first" hint, so a later read clears it. */
  let hintShown = false;

  const warn = (): void => {
    const lines: string[] = [];
    if (loaded.dropped > 0) {
      const what = loaded.dropped === 1 ? 'Había 1 dato guardado que no se pudo leer' : `Había ${loaded.dropped} datos guardados que no se pudieron leer`;
      lines.push(
        loaded.backupKey
          ? `${what}. No se borró: quedó una copia en este navegador, con el nombre ${loaded.backupKey}, y la lista sigue sin eso.`
          : `${what}. Para no borrarlo, la caja no va a guardar nada en este navegador.`,
      );
    }
    if (!persistent) {
      lines.push('Lo que anotes ahora se pierde al cerrar la página. Exportá el CSV antes de cerrar.');
    }
    warning.textContent = lines.join(' ');
    warning.hidden = lines.length === 0;
  };

  const persist = (): void => {
    // Never write over stored text that did not load and could not be copied.
    persistent = loaded.writable && saveRows(deps.storage, rows);
    warn();
  };

  // ── The book ──────────────────────────────────────────────────────────────────────────────

  const totalsView = (d: DayTotals): HTMLElement =>
    h(
      'dl',
      { class: 'totals' },
      h('div', { class: 'in' }, h('dt', {}, 'Entró'), h('dd', {}, money(d.income))),
      h('div', { class: 'out' }, h('dt', {}, 'Salió'), h('dd', {}, money(d.expense))),
      h('div', { class: 'net' }, h('dt', {}, 'Neto'), h('dd', {}, d.net < 0 ? `−${money(-d.net)}` : money(d.net))),
    );

  const renderBook = (): void => {
    const now = deps.now();
    today.textContent = new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
    const todayKey = localDay(now);
    const groups = byDay(rows);
    if (!groups.some((g) => g.day === todayKey)) groups.unshift(totalsFor([], todayKey));
    groups.sort((a, b) => (a.day < b.day ? 1 : -1));
    days.replaceChildren(
      ...groups.map((g) => {
        const list = g.rows.length
          ? h(
              'ol',
              { class: 'rows' },
              ...g.rows.map((r) =>
                h(
                  'li',
                  { class: `row ${r.kind}`, 'data-id': r.id },
                  h('span', { class: 'time' }, localTime(new Date(r.at))),
                  h(
                    'span',
                    { class: 'what' },
                    h('span', { class: 'said' }, r.sentence),
                    h('span', { class: 'how' }, `${r.category} · ${r.literal}${r.approximate ? ' · aprox.' : ''}`),
                  ),
                  h('span', { class: 'amt' }, h('span', { class: 'visually-hidden' }, `${KIND_LABEL[r.kind]} `), signedMoney(r.amount, r.kind)),
                ),
              ),
            )
          : h('p', { class: 'empty' }, 'Todavía no anotaste nada.');
        const title = dayLabel(g.day, now);
        return h('section', { class: 'day', 'aria-label': title }, h('h3', {}, title), totalsView(g), list);
      }),
    );
    undoButton.disabled = rows.length === 0;
    exportButton.disabled = rows.length === 0;
  };

  // ── The preview ───────────────────────────────────────────────────────────────────────────

  const kindNow = (d: Draft & { kind: Kind }): Kind => kindOverride ?? d.kind;

  const guessFacts = (d: Extract<Draft, { status: 'ready' | 'ask' }>): HTMLElement[] => {
    const kind = kindNow(d);
    // The category shown is the one the row will get: flipping the kind re-picks it, as resolve() does.
    const { category, keyword } = kind === d.kind ? d : categorise(d.text, kind);
    const kindBy = kind === d.kind ? d.kindKeyword : null;
    return [
      fact('Tipo', KIND_LABEL[kind], ' ', h('small', {}, kindBy ? `por "${kindBy}"` : kind === d.kind ? 'supuesto' : 'elegido por vos')),
      fact('Categoría', category, ' ', h('small', {}, keyword ? `por "${keyword}"` : 'sin palabra clave')),
    ];
  };

  const flipButton = (d: Draft & { kind: Kind }): HTMLElement =>
    h('button', { type: 'button', 'data-action': 'flip' }, kindNow(d) === 'income' ? 'Es un gasto' : 'Es un ingreso');

  const renderPreview = (focus: boolean): void => {
    if (!draft) {
      preview.replaceChildren();
      return;
    }
    const d = draft;
    if (d.status === 'no_amount') {
      preview.replaceChildren(
        h('div', { class: 'card muted' }, h('p', {}, `No encontré un monto en "${d.text}".`), h('p', {}, 'Probá con un número: "pagué la luz 45 mil".')),
      );
      return;
    }
    if (d.status === 'invalid') {
      preview.replaceChildren(h('div', { class: 'card muted' }, sentenceView(d.text, d.spans), h('p', {}, d.message)));
      return;
    }
    const error = h('p', { class: 'error', id: 'preview-error' });
    if (d.status === 'ready') {
      const card = h(
        'div',
        { class: `card ${kindNow(d)}` },
        sentenceView(d.text, d.spans),
        h(
          'dl',
          { class: 'facts' },
          fact('Monto', h('span', { class: 'amount' }, `${d.approximate ? 'al menos ' : ''}${money(d.amount)}`)),
          ...guessFacts(d),
          fact('Cálculo', d.literal),
        ),
        error,
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', 'data-action': 'save' }, 'Guardar'), flipButton(d)),
      );
      preview.replaceChildren(card);
      if (focus) need<HTMLButtonElement>(card, '[data-action="save"]').focus();
      return;
    }
    const q = d.question;
    // A question with no buttons and no box (money in and out in one sentence) cannot be saved, so
    // the guessed kind and the flip button would only be noise on that card.
    const savable = q.typed || q.options.length > 0;
    const fieldset = h(
      'fieldset',
      { class: 'question' },
      h('legend', {}, q.prompt),
      q.note ? h('p', { class: 'note' }, q.note) : null,
      q.options.length
        ? h('div', { class: 'options' }, ...q.options.map((o, i) => h('button', { type: 'button', 'data-option': String(i) }, o.label)))
        : null,
      q.typed
        ? h(
            'form',
            { class: 'typed', 'data-action': 'typed' },
            h('label', { for: 'typed-amount' }, q.options.length ? 'Otro monto' : 'Monto'),
            h('input', { id: 'typed-amount', name: 'monto', type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-describedby': 'preview-error' }),
            h('button', { type: 'submit' }, 'Guardar este monto'),
          )
        : null,
    );
    const card = h(
      'div',
      { class: `card ask ${kindNow(d)}` },
      sentenceView(d.text, d.spans),
      savable ? h('dl', { class: 'facts' }, ...guessFacts(d)) : null,
      fieldset,
      error,
      savable ? h('div', { class: 'actions' }, flipButton(d)) : null,
    );
    preview.replaceChildren(card);
    if (focus) card.querySelector<HTMLElement>('[data-option], #typed-amount')?.focus();
  };

  const showError = (message: string): void => {
    const el = preview.querySelector('#preview-error');
    if (el) el.textContent = message;
  };

  const read = (): void => {
    draft = readSentence(input.value);
    kindOverride = null;
    if (draft.status === 'no_amount' && draft.text === '') {
      draft = null;
      status.textContent = 'Escribí una frase primero.';
      hintShown = true;
      renderPreview(false);
      return;
    }
    if (hintShown) {
      status.textContent = '';
      hintShown = false;
    }
    renderPreview(true);
  };

  // Editing the sentence after it was read makes the preview describe other words. It is cleared,
  // so Guardar can never save a sentence that is no longer in the box.
  input.addEventListener('input', () => {
    if (!draft) return;
    draft = null;
    kindOverride = null;
    renderPreview(false);
  });

  const save = (answer: Answer): void => {
    if (!draft) return;
    const ctx = kindOverride ? { now: deps.now(), id: deps.newId(), kind: kindOverride } : { now: deps.now(), id: deps.newId() };
    const result = resolve(draft, answer, ctx);
    if (!result.ok) {
      showError(result.message);
      return;
    }
    rows = [...rows, result.row];
    persist();
    hintShown = false;
    draft = null;
    kindOverride = null;
    input.value = '';
    renderPreview(false);
    renderBook();
    const saved = result.row;
    const undo = h('button', { type: 'button', class: 'link', 'data-undo': saved.id }, 'Deshacer');
    status.replaceChildren(
      `Guardado: ${KIND_LABEL[saved.kind].toLowerCase()} de ${money(saved.amount)} en ${saved.category}. `,
      undo,
    );
    input.focus();
  };

  const remove = (id: string): void => {
    const removed = rows.find((r) => r.id === id);
    if (!removed) return;
    rows = rows.filter((r) => r.id !== id);
    persist();
    renderBook();
    status.textContent = `Deshecho: ${removed.sentence} (${money(removed.amount)}).`;
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    read();
  });

  preview.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target || !draft) return;
    if (target.dataset['action'] === 'save') save({ type: 'as_read' });
    else if (target.dataset['action'] === 'flip' && draft.status !== 'no_amount' && draft.status !== 'invalid') {
      kindOverride = kindNow(draft) === 'income' ? 'expense' : 'income';
      if (kindOverride === draft.kind) kindOverride = null;
      renderPreview(false);
      preview.querySelector<HTMLElement>('[data-action="flip"]')?.focus();
    } else if (target.dataset['option'] !== undefined) save({ type: 'option', index: Number(target.dataset['option']) });
  });

  preview.addEventListener('submit', (event) => {
    event.preventDefault();
    const typed = preview.querySelector<HTMLInputElement>('#typed-amount');
    save({ type: 'typed', text: typed?.value ?? '' });
  });

  status.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-undo]') : null;
    const id = target?.dataset['undo'];
    if (id) {
      remove(id);
      input.focus();
    }
  });

  undoButton.addEventListener('click', () => {
    const { removed } = undoLast(rows);
    if (removed) remove(removed.id);
  });

  exportButton.addEventListener('click', () => {
    // The byte order mark makes spreadsheet programs read the file as UTF-8, so "vendí" survives.
    deps.download(`caja-${localDay(deps.now())}.csv`, `﻿${toCsv(rows)}`);
  });

  for (const example of root.querySelectorAll<HTMLButtonElement>('[data-example]')) {
    example.addEventListener('click', () => {
      input.value = example.dataset['example'] ?? '';
      read();
    });
  }

  // ── Dictation ─────────────────────────────────────────────────────────────────────────────

  if (deps.recognition) {
    const Recognition = deps.recognition;
    let active: InstanceType<RecognitionConstructor> | null = null;
    dictate.hidden = false;
    const stopped = (): void => {
      active = null;
      dictate.setAttribute('aria-pressed', 'false');
      dictate.textContent = 'Dictar';
    };
    dictate.addEventListener('click', () => {
      if (active) {
        active.stop();
        return;
      }
      const rec = new Recognition();
      rec.lang = 'es-AR';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (event) => {
        const transcript = event.results[0]?.[0]?.transcript ?? '';
        input.value = transcript;
        read();
      };
      rec.onerror = (event) => {
        const message = speechError(event.error);
        if (message) status.textContent = message;
      };
      rec.onend = stopped;
      active = rec;
      dictate.setAttribute('aria-pressed', 'true');
      dictate.textContent = 'Escuchando… tocá para parar';
      try {
        rec.start();
      } catch {
        stopped();
        status.textContent = speechError('');
      }
    });
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────────────────────

  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  let corpusRequested = false;
  const select = (tab: HTMLButtonElement, focus: boolean): void => {
    for (const t of tabs) {
      const selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      const panel = root.getElementById(t.getAttribute('aria-controls') ?? '');
      if (panel) panel.hidden = !selected;
    }
    if (focus) tab.focus();
    if (tab.id === 'tab-frases' && !corpusRequested) {
      corpusRequested = true;
      // A failed load (offline before corpus.json was cached) is retried on the next open.
      void mountCorpus(root, deps).then((ok) => {
        if (!ok) corpusRequested = false;
      });
    }
  };
  for (const [i, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab, false));
    tab.addEventListener('keydown', (event) => {
      const last = tabs.length - 1;
      const next = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last }[event.key];
      const target = next === undefined ? undefined : tabs[next];
      if (target) {
        event.preventDefault();
        select(target, true);
      }
    });
  }

  warn();
  renderBook();
}
