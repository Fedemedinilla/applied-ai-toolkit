// The preview card of model mode. It shows what the model read, what the code kept, and one plain
// question per flag. Nothing is saved until every question has an answer. No button carries the
// model's number: the amount is the parser's, or one the owner types (which goes through the
// parser too), so a disagreement is settled by a person and not by picking the model's figure.

import { categorise, EXPENSE_CATEGORIES, INCOME_CATEGORIES, type Category, type CategoryGuess, type Kind } from './categories.ts';
import type { Answer } from './entry.ts';
import { fact, h, sentenceView } from './dom.ts';
import { money } from './format.ts';
import { dateInWindow, DATE_WINDOW_DAYS, daysBefore, dayNumber, isCategoryOf, type Verdict } from './verdict.ts';

/** What the owner answered on the card. Kept across re-renders, which happen when the kind changes. */
export interface ModelAnswers {
  kind?: Kind;
  /** 'parser', 'typed', or 'o<index>' for one of the parser's readings. */
  amount?: string;
  typed?: string;
  category?: string;
  date?: string;
}

export interface ModelState {
  verdict: Verdict;
  answers: ModelAnswers;
  /** YYYY-MM-DD, the day the sentence was read. */
  today: string;
}

const KIND_LABEL: Record<Kind, string> = { income: 'Ingreso', expense: 'Gasto' };
const SIDE_NAME: Record<Kind, string> = { income: 'ingresos', expense: 'gastos' };
const CATEGORIES: Record<Kind, readonly Category[]> = { income: INCOME_CATEGORIES, expense: EXPENSE_CATEGORIES };

interface Questions {
  amount: 'mismatch' | 'ambiguous' | null;
  kind: boolean;
  category: boolean;
  date: boolean;
}

function questions(v: Verdict): Questions {
  const has = (flag: Verdict['flags'][number]): boolean => v.flags.includes(flag);
  return {
    amount: has('amount_mismatch') ? 'mismatch' : v.draft.status === 'ask' ? 'ambiguous' : null,
    kind: has('kind_unclear') || has('kind_mismatch'),
    category: has('category_unknown') || has('category_wrong_side'),
    date: has('date_unverified'),
  };
}

export const kindNow = (s: ModelState): Kind => s.answers.kind ?? s.verdict.kind;

/** The category the row would get now, and what to say picked it. Null while the question is open. */
function categoryNow(s: ModelState): { guess: CategoryGuess; by: string } | null {
  const kind = kindNow(s);
  if (questions(s.verdict).category) {
    const picked = s.answers.category;
    return picked !== undefined && isCategoryOf(kind, picked) ? { guess: { category: picked, keyword: null }, by: 'elegida por vos' } : null;
  }
  if (kind === s.verdict.kind) {
    const v = s.verdict;
    const by = v.categoryBy === 'model' ? 'por la IA' : v.keyword ? `por "${v.keyword}"` : 'sin palabra clave';
    return { guess: { category: v.category, keyword: v.keyword }, by };
  }
  // The owner flipped the kind: the category is re-picked from the other side's keyword table.
  const guess = categorise(s.verdict.draft.text, kind);
  return { guess, by: guess.keyword ? `por "${guess.keyword}"` : 'sin palabra clave' };
}

function dateLabel(date: string, today: string): string {
  if (date === today) return 'Hoy';
  if (date === daysBefore(today, 1)) return 'Ayer';
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function choice(name: string, value: string, label: string, checked: boolean): HTMLElement {
  return h('label', { class: 'choice' }, h('input', { type: 'radio', name, value, checked }), ' ', label);
}

function amountQuestion(s: ModelState, kind: 'mismatch' | 'ambiguous'): HTMLElement | null {
  const v = s.verdict;
  const a = s.answers;
  const typedBox = (label: string): HTMLElement =>
    h(
      'div',
      { class: 'typed' },
      h('label', { for: 'm-typed' }, label),
      h('input', { id: 'm-typed', name: 'm-typed', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: a.typed ?? '' }),
    );
  if (kind === 'mismatch' && v.draft.status === 'ready') {
    const parser = money(v.draft.amount);
    const model = v.modelAmount === null ? 'ningún monto seguro' : money(v.modelAmount);
    return h(
      'fieldset',
      { class: 'question', 'data-question': 'amount' },
      h('legend', {}, `La IA leyó ${model} y el lector de montos ${parser}. ¿Cuál es el monto?`),
      h(
        'div',
        { class: 'choices' },
        choice('m-amount', 'parser', parser, a.amount === 'parser'),
        choice('m-amount', 'typed', 'Otro monto, lo escribo', a.amount === 'typed'),
      ),
      typedBox('Monto'),
    );
  }
  if (kind === 'ambiguous' && v.draft.status === 'ask') {
    const q = v.draft.question;
    return h(
      'fieldset',
      { class: 'question', 'data-question': 'amount' },
      h('legend', {}, q.prompt),
      q.note ? h('p', { class: 'note' }, q.note) : null,
      h(
        'div',
        { class: 'choices' },
        ...q.options.map((o, i) => choice('m-amount', `o${i}`, o.label, a.amount === `o${i}`)),
        q.typed ? choice('m-amount', 'typed', q.options.length ? 'Otro monto, lo escribo' : 'Lo escribo', a.amount === 'typed') : null,
      ),
      q.typed ? typedBox('Monto') : null,
    );
  }
  return null;
}

function kindQuestion(s: ModelState): HTMLElement {
  const v = s.verdict;
  const legend = v.flags.includes('kind_unclear')
    ? 'La frase no dice si entró o salió plata. ¿Qué fue?'
    : `La IA leyó un ${KIND_LABEL[v.kind].toLowerCase()}, pero "${v.kindKeyword ?? ''}" suele ser un ${KIND_LABEL[v.kind === 'income' ? 'expense' : 'income'].toLowerCase()}. ¿Qué fue?`;
  return h(
    'fieldset',
    { class: 'question', 'data-question': 'kind' },
    h('legend', {}, legend),
    h(
      'div',
      { class: 'choices' },
      choice('m-kind', 'income', 'Entró plata (ingreso)', s.answers.kind === 'income'),
      choice('m-kind', 'expense', 'Salió plata (gasto)', s.answers.kind === 'expense'),
    ),
  );
}

function categoryQuestion(s: ModelState, proposed: string | null): HTMLElement {
  const kind = kindNow(s);
  const v = s.verdict;
  // Only a name from the list is repeated back; anything else the model sent is not shown.
  const legend =
    v.flags.includes('category_wrong_side') && proposed !== null
      ? `La IA propuso "${proposed}", que es una categoría de ${SIDE_NAME[kind === 'income' ? 'expense' : 'income']}. ¿En cuál va?`
      : 'La IA no eligió una categoría de la lista. ¿En cuál va?';
  const selected = s.answers.category;
  return h(
    'fieldset',
    { class: 'question', 'data-question': 'category' },
    h('legend', {}, legend),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'm-category' }, `Categoría de ${SIDE_NAME[kind]}`),
      h(
        'select',
        { id: 'm-category', name: 'm-category' },
        h('option', { value: '', selected: selected === undefined || !isCategoryOf(kind, selected) }, 'Elegí una'),
        ...CATEGORIES[kind].map((c) => h('option', { value: c, selected: selected === c }, c)),
      ),
    ),
  );
}

function dateQuestion(s: ModelState): HTMLElement {
  // Two cases raise the flag: the model named no day, or it named one the window rules out.
  const read = s.verdict.modelDate;
  const legend =
    read === null
      ? 'La frase nombra un día que la IA no pudo fijar. ¿Qué día fue?'
      : `La IA leyó el ${dateLabel(read, s.today)}, que no está entre hoy y hace ${DATE_WINDOW_DAYS} días. ¿Qué día fue?`;
  return h(
    'fieldset',
    { class: 'question', 'data-question': 'date' },
    h('legend', {}, legend),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'm-date' }, 'Día'),
      h('input', { id: 'm-date', name: 'm-date', type: 'date', min: daysBefore(s.today, DATE_WINDOW_DAYS), max: s.today, value: s.answers.date ?? '' }),
    ),
  );
}

/** The card. `proposed` is the model's raw category, shown only when it is a name from the list. */
export function modelCard(s: ModelState, proposed: string | null): HTMLElement {
  const v = s.verdict;
  const q = questions(v);
  const kind = kindNow(s);
  const cat = categoryNow(s);
  const kindBy = s.answers.kind !== undefined ? 'elegido por vos' : q.kind ? 'por confirmar' : v.kindBy === 'model' ? 'por la IA' : 'supuesto';
  const dateBy = v.date !== s.today ? ' por la IA' : '';
  const draft = v.draft;
  const amountFact =
    draft.status === 'ready'
      ? fact('Monto', h('span', { class: 'amount' }, `${draft.approximate ? 'al menos ' : ''}${money(draft.amount)}`), ' ', h('small', {}, 'por el lector de montos'))
      : fact('Monto', 'falta responder');
  const asked = [
    q.amount ? amountQuestion(s, q.amount) : null,
    q.kind ? kindQuestion(s) : null,
    q.category ? categoryQuestion(s, proposed) : null,
    q.date ? dateQuestion(s) : null,
  ];
  return h(
    'form',
    { class: `card model ${kind}`, 'data-action': 'model-form', 'aria-label': 'Lectura con IA' },
    draft.status === 'no_amount' ? h('p', { class: 'sentence' }, draft.text) : sentenceView(draft.text, draft.spans),
    h(
      'dl',
      { class: 'facts' },
      amountFact,
      fact('Tipo', KIND_LABEL[kind], ' ', h('small', {}, kindBy)),
      fact('Categoría', cat ? cat.guess.category : 'falta elegir', ' ', cat ? h('small', {}, cat.by) : null),
      fact('Fecha', q.date ? 'falta elegir' : dateLabel(v.date, s.today), dateBy ? ' ' : '', dateBy ? h('small', {}, dateBy.trim()) : null),
      draft.status === 'ready' ? fact('Cálculo', draft.literal) : null,
    ),
    v.reason ? h('p', { class: 'reason' }, h('strong', {}, 'La IA: '), v.reason) : null,
    v.confirmed ? null : h('p', { class: 'note' }, 'Antes de guardar, respondé:'),
    ...asked,
    h('p', { class: 'error', id: 'preview-error' }),
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'submit', class: 'primary', 'data-action': 'model-save' }, 'Guardar'),
      q.kind ? null : h('button', { type: 'button', 'data-action': 'model-flip' }, kind === 'income' ? 'Es un gasto' : 'Es un ingreso'),
      h('button', { type: 'button', 'data-action': 'model-off' }, 'Leer sin IA'),
    ),
  );
}

/** Reads the card's inputs into the answers, so a re-render keeps what the owner already chose. */
export function collectAnswers(card: ParentNode, answers: ModelAnswers): ModelAnswers {
  const next: ModelAnswers = { ...answers };
  const checked = (name: string): string | undefined => card.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;
  const kind = checked('m-kind');
  if (kind === 'income' || kind === 'expense') next.kind = kind;
  const amount = checked('m-amount');
  if (amount !== undefined) next.amount = amount;
  const typed = card.querySelector<HTMLInputElement>('#m-typed');
  if (typed) next.typed = typed.value;
  const category = card.querySelector<HTMLSelectElement>('#m-category');
  if (category && category.value !== '') next.category = category.value;
  const date = card.querySelector<HTMLInputElement>('#m-date');
  if (date && date.value !== '') next.date = date.value;
  return next;
}

export interface ModelSave {
  answer: Answer;
  kind: Kind;
  category: CategoryGuess;
  /** Set only when the movement happened on another day than today. */
  day: string | null;
}

/** Turns the card into what resolve() needs, or the first question still open. */
export function modelSave(s: ModelState): { ok: true; save: ModelSave } | { ok: false; message: string } {
  const v = s.verdict;
  const q = questions(v);
  const a = s.answers;
  let answer: Answer;
  if (q.amount === null) {
    if (v.draft.status !== 'ready') return { ok: false, message: 'No hay un monto para guardar.' };
    answer = { type: 'as_read' };
  } else if (a.amount === undefined) {
    return { ok: false, message: 'Elegí el monto.' };
  } else if (a.amount === 'typed') {
    answer = { type: 'typed', text: a.typed ?? '' };
  } else if (a.amount === 'parser') {
    answer = { type: 'as_read' };
  } else {
    answer = { type: 'option', index: Number(a.amount.slice(1)) };
  }
  if (q.kind && a.kind === undefined) return { ok: false, message: 'Elegí si entró o salió plata.' };
  const kind = kindNow(s);
  const cat = categoryNow(s);
  if (!cat) return { ok: false, message: 'Elegí una categoría.' };
  let date = v.date;
  if (q.date) {
    if (a.date === undefined || dayNumber(a.date) === null || !dateInWindow(a.date, s.today)) {
      return { ok: false, message: `Elegí un día entre hoy y hace ${DATE_WINDOW_DAYS} días.` };
    }
    date = a.date;
  }
  return { ok: true, save: { answer, kind, category: cat.guess, day: date === s.today ? null : date } };
}
