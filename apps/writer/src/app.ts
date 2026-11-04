// The page: pick a role, pick a category, write the brief, choose one of the proposed titles,
// read the draft with the checks under it, ask for changes, copy.
//
// The history lives here and goes to the server whole on every turn. Each assistant turn is the
// `assistant` string the server returned, never text the page assembled. Model text reaches the
// page only as text nodes (h() appends strings), and the clipboard HTML is escaped in format.ts.

import { asReply, FAILURE_TEXT, failureFrom, type ApiReply, type ChatMessage, type DraftRequest, type FailureCode } from './api.ts';
import type { DraftReport, LengthCheck } from './checks.ts';
import { copyDraft, type ClipboardPort } from './clipboard.ts';
import type { ClientCatalog } from './config-schema.ts';
import { blocks, copyContent, type Segment } from './format.ts';
import { chooseTitleMessage, MAX_MESSAGES } from './protocol.ts';

export interface AppDeps {
  readonly catalog: ClientCatalog;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly clipboard: ClipboardPort;
  /** The page gives up a little after the server's own deadline. */
  readonly timeoutMs?: number;
}

type Props = Record<string, string | boolean | undefined>;

function h(tag: string, props: Props = {}, ...children: Array<Node | string | null>): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) if (child !== null) el.append(child);
  return el;
}

function need<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`writer: missing ${selector} in the markup`);
  return el;
}

const SENSITIVITY_LABEL = { normal: null, high: 'Sensibilidad alta', critical: 'Sensibilidad crítica' } as const;
const LANGUAGE_LABEL = { es: 'Español', en: 'Inglés' } as const;
const STATUS_LABEL = { short: 'corto', ok: 'dentro del rango', long: 'largo' } as const;
/** Grouping forced on: Spanish leaves four-digit numbers ungrouped by default, and checks.ts groups them. */
const formatInt = (n: number): string => new Intl.NumberFormat('es', { useGrouping: true }).format(n);

/** The user turn the "Ajustar la extensión" button sends: every number in it was measured in code. */
export function lengthRequest(lengths: readonly LengthCheck[]): string | null {
  const off = lengths.filter((l) => l.status !== 'ok');
  if (off.length === 0) return null;
  const parts = off.map(
    (l) => `el texto en ${l.lang === 'es' ? 'español' : 'inglés'} tiene ${formatInt(l.chars)} caracteres y la categoría pide entre ${formatInt(l.min)} y ${formatInt(l.max)}`,
  );
  return `Ajustar la extensión: ${parts.join('; ')}. Llevarlo a ese rango sin quitar datos ni marcas [COMPLETAR].`;
}

/** Consecutive bold segments share one <strong>, so a gap inside a bold date stays inside it. */
function segmentNodes(segs: readonly Segment[]): Node[] {
  const out: Node[] = [];
  let strong: HTMLElement | null = null;
  for (const s of segs) {
    const node: Node = s.gap ? h('mark', { class: 'gap' }, s.text) : document.createTextNode(s.text);
    if (!s.bold) {
      strong = null;
      out.push(node);
      continue;
    }
    if (!strong) {
      strong = h('strong');
      out.push(strong);
    }
    strong.append(node);
  }
  return out;
}

function renderText(target: HTMLElement, text: string): void {
  target.replaceChildren(
    ...blocks(text).map((b) => {
      if (b.kind === 'list') return h('ul', {}, ...b.items.map((item) => h('li', {}, ...segmentNodes(item))));
      const p = h('p');
      b.lines.forEach((line, i) => {
        if (i > 0) p.append(h('br'));
        p.append(...segmentNodes(line));
      });
      return p;
    }),
  );
}

export function mountApp(doc: Document, deps: AppDeps): void {
  const { catalog } = deps;
  const timeoutMs = deps.timeoutMs ?? 70_000;
  const el = {
    school: need(doc, '#school-name'),
    service: need(doc, '#service'),
    main: need(doc, '#main'),
    setup: need<HTMLFormElement>(doc, '#setup'),
    roleList: need(doc, '#role-list'),
    categoryList: need(doc, '#category-list'),
    categoryInfo: need(doc, '#category-info'),
    brief: need<HTMLTextAreaElement>(doc, '#brief'),
    askTitles: need<HTMLButtonElement>(doc, '#ask-titles'),
    titles: need(doc, '#titles'),
    titlesHeading: need(doc, '#titles-heading'),
    titlesForm: need<HTMLFormElement>(doc, '#titles-form'),
    titleList: need(doc, '#title-list'),
    writeDraft: need<HTMLButtonElement>(doc, '#write-draft'),
    draft: need(doc, '#draft'),
    draftTitle: need(doc, '#draft-title'),
    draftEs: need(doc, '#draft-es'),
    draftEnWrap: need(doc, '#draft-en-wrap'),
    draftEn: need(doc, '#draft-en'),
    lengths: need(doc, '#lengths'),
    notes: need(doc, '#notes'),
    copy: need<HTMLButtonElement>(doc, '#copy'),
    fixLength: need<HTMLButtonElement>(doc, '#fix-length'),
    reviseForm: need<HTMLFormElement>(doc, '#revise-form'),
    revise: need<HTMLInputElement>(doc, '#revise'),
    reviseHint: need(doc, '#revise-hint'),
    sendRevision: need<HTMLButtonElement>(doc, '#send-revision'),
    restart: need<HTMLButtonElement>(doc, '#restart'),
    status: need(doc, '#status'),
  };

  let messages: ChatMessage[] = [];
  let request: AbortController | null = null;
  let available = false;
  let title = '';
  let current: { es: string; en: string | null; report: DraftReport } | null = null;

  el.school.textContent = catalog.schoolName;
  const reviseHintText = el.reviseHint.textContent ?? '';
  /** A change is one more user turn: the request it starts is messages.length + 1 long. */
  const atCap = (): boolean => messages.length + 1 > MAX_MESSAGES;
  const say = (text: string) => {
    el.status.textContent = text;
  };

  const selected = (name: string): string | null => doc.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? null;

  function chip(name: string, value: string, label: string, describedBy?: string): HTMLElement {
    const id = `${name}-${value}`;
    return h(
      'label',
      { class: 'chip', for: id },
      h('input', { type: 'radio', name, value, id, 'aria-describedby': describedBy }),
      h('span', {}, label),
    );
  }

  catalog.roles.forEach((role) => el.roleList.append(chip('role', role.id, role.name)));

  function renderCategories(): void {
    const role = selected('role');
    const previous = selected('category');
    const list = catalog.categories.filter((c) => role !== null && c.roles.includes(role));
    el.categoryList.replaceChildren(...list.map((c) => chip('category', c.id, c.name, 'category-info')));
    if (role === null) el.categoryList.append(h('p', { class: 'hint' }, 'Primero elegir quién escribe.'));
    const keep = list.find((c) => c.id === previous);
    if (keep) need<HTMLInputElement>(el.categoryList, `#category-${keep.id}`).checked = true;
    renderInfo();
  }

  function renderInfo(): void {
    const category = catalog.categories.find((c) => c.id === selected('category'));
    if (!category) {
      el.categoryInfo.textContent = '';
      return;
    }
    const facts = [
      category.purpose,
      `Extensión: ${formatInt(category.length.min)} a ${formatInt(category.length.max)} caracteres.`,
      category.languages.length === 2 ? 'Se envía en español y en inglés.' : 'Se envía en español.',
      SENSITIVITY_LABEL[category.sensitivity],
    ].filter((f): f is string => f !== null);
    el.categoryInfo.textContent = facts.join(' ');
  }

  function busy(on: boolean): void {
    el.main.setAttribute('aria-busy', String(on));
    for (const b of [el.askTitles, el.writeDraft, el.sendRevision, el.fixLength]) b.disabled = on || !available;
    // At the cap the change controls stay enabled, so Enter and a click both reach the handler,
    // which says why; the hint under the box says it before anyone tries.
    el.reviseHint.textContent = atCap() ? FAILURE_TEXT.history_too_long : reviseHintText;
  }

  /** Clears the flow. True when it cancelled a request in flight. */
  function reset(): boolean {
    const cancelled = request !== null;
    request?.abort();
    request = null;
    messages = [];
    current = null;
    title = '';
    el.titles.hidden = true;
    el.draft.hidden = true;
    el.restart.hidden = true;
    el.titleList.replaceChildren();
    return cancelled;
  }

  function changed(): void {
    if (reset()) say('Se canceló el pedido en curso.');
    busy(false);
  }

  async function send(next: ChatMessage[], waiting: string): Promise<ApiReply | null> {
    const role = selected('role');
    const category = selected('category');
    if (role === null || category === null) return null;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
    busy(true);
    say(waiting);
    const body: DraftRequest = { role, category, messages: next };
    let failure: FailureCode | null = null;
    let replyValue: ApiReply | null = null;
    try {
      const res = await deps.fetch('./api/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) failure = failureFrom(res.status, json);
      else {
        replyValue = asReply(json);
        if (replyValue === null) failure = 'bad_reply';
      }
    } catch {
      failure = controller.signal.reason === 'timeout' ? 'timeout' : 'network';
    } finally {
      clearTimeout(timer);
    }
    // A newer request, a restart or a change of role or category replaced this one.
    if (request !== controller) return null;
    request = null;
    busy(false);
    if (failure !== null) {
      say(FAILURE_TEXT[failure]);
      return null;
    }
    return replyValue;
  }

  function showTitles(titles: readonly string[]): void {
    el.titleList.replaceChildren(
      ...titles.map((t, i) =>
        h('label', { class: 'option', for: `title-${i}` }, h('input', { type: 'radio', name: 'title', value: t, id: `title-${i}`, checked: i === 0 }), h('span', {}, t)),
      ),
    );
    el.titles.hidden = false;
    el.draft.hidden = true;
    el.restart.hidden = false;
    el.titlesHeading.focus();
  }

  function showDraft(es: string, en: string | null, report: DraftReport): void {
    current = { es, en, report };
    // A model that skipped the titles turn leaves no chosen title: the category name stands in.
    if (title === '') title = catalog.categories.find((c) => c.id === selected('category'))?.name ?? 'Borrador';
    el.draftTitle.textContent = title;
    renderText(el.draftEs, es);
    el.draftEnWrap.hidden = en === null;
    renderText(el.draftEn, en ?? '');
    el.lengths.replaceChildren(
      ...report.lengths.map((l) =>
        h(
          'li',
          { class: `length ${l.status}`, 'data-status': l.status },
          `${LANGUAGE_LABEL[l.lang]}: ${formatInt(l.chars)} caracteres (rango ${formatInt(l.min)} a ${formatInt(l.max)}), ${STATUS_LABEL[l.status]}.`,
        ),
      ),
    );
    el.notes.replaceChildren(
      ...report.notes.map((n) => h('li', { class: `note ${n.level}`, 'data-code': n.code }, h('span', { class: 'level' }, n.level === 'warn' ? 'Revisar: ' : 'Recordatorio: '), n.text)),
    );
    el.fixLength.hidden = lengthRequest(report.lengths) === null;
    el.titles.hidden = true;
    el.draft.hidden = false;
    el.restart.hidden = false;
    el.revise.value = '';
    busy(false);
    el.draftTitle.focus();
  }

  function accept(next: ChatMessage[], reply: ApiReply): void {
    messages = [...next, { role: 'assistant', content: reply.assistant }];
    if (reply.type === 'titles') {
      showTitles(reply.titles);
      say(`${reply.titles.length} títulos propuestos. Elegir uno para redactar.`);
    } else if (reply.type === 'draft') {
      showDraft(reply.es, reply.en, reply.report);
      const warnings = reply.report.notes.filter((n) => n.level === 'warn').length;
      say(warnings === 0 ? 'Borrador listo.' : `Borrador listo, con ${warnings === 1 ? '1 punto' : `${warnings} puntos`} para revisar.`);
    } else {
      say(`El asistente respondió sin borrador: ${reply.text}`);
    }
  }

  async function turn(content: string, waiting: string): Promise<void> {
    const next: ChatMessage[] = [...messages, { role: 'user', content }];
    const reply = await send(next, waiting);
    if (reply) accept(next, reply);
  }

  el.roleList.addEventListener('change', () => {
    changed();
    renderCategories();
  });
  el.categoryList.addEventListener('change', () => {
    changed();
    renderInfo();
  });

  el.setup.addEventListener('submit', (event) => {
    event.preventDefault();
    if (selected('role') === null) return say('Falta elegir quién escribe.');
    if (selected('category') === null) return say('Falta elegir el tipo de comunicado.');
    const brief = el.brief.value.trim();
    if (brief === '') {
      el.brief.focus();
      return say('Falta el pedido: qué hay que comunicar.');
    }
    reset();
    void turn(brief, 'Proponiendo títulos...');
  });

  el.titlesForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const chosen = selected('title');
    if (chosen === null) return say('Falta elegir un título.');
    title = chosen;
    void turn(chooseTitleMessage(chosen), 'Redactando el borrador...');
  });

  el.reviseForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const change = el.revise.value.trim();
    if (change === '') return say('Falta escribir el cambio.');
    if (atCap()) return say(FAILURE_TEXT.history_too_long);
    void turn(change, 'Aplicando el cambio...');
  });

  el.fixLength.addEventListener('click', () => {
    const text = current ? lengthRequest(current.report.lengths) : null;
    if (text === null) return;
    if (atCap()) return say(FAILURE_TEXT.history_too_long);
    void turn(text, 'Ajustando la extensión...');
  });

  el.copy.addEventListener('click', () => {
    if (!current) return;
    const pending = current.report.placeholders.length;
    void copyDraft(deps.clipboard, copyContent(title, current.es, current.en)).then((result) => {
      const gaps = pending === 0 ? '' : pending === 1 ? ' Queda 1 dato por completar.' : ` Quedan ${pending} datos por completar.`;
      if (result === 'rich') say(`Copiado con formato.${gaps}`);
      else if (result === 'plain') say(`Copiado como texto sin formato.${gaps}`);
      else say('El navegador no permitió copiar. Seleccionar el texto y copiarlo a mano.');
    });
  });

  el.restart.addEventListener('click', () => {
    reset();
    busy(false);
    el.brief.focus();
    say('Listo para un pedido nuevo.');
  });

  renderCategories();
  busy(true);
  deps
    .fetch('./api/health')
    .then((res) => res.ok)
    .catch(() => false)
    .then((ok) => {
      available = ok;
      el.service.hidden = ok;
      if (!ok) el.service.textContent = 'El servicio de redacción no está disponible en esta copia de la página. Se pueden recorrer los roles y las categorías, pero no pedir borradores.';
      busy(false);
    });
}
