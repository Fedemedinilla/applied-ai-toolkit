// From a sentence to a row. Pure: the DOM layer calls readSentence() and then resolve(), and both
// can be tested without a browser.
//
// readSentence() has four outcomes. `ready` has one amount and can be saved. `ask` carries the
// question that resolves the sentence; nothing is saved until it is answered. `no_amount` and
// `invalid` explain why there is nothing to save.

import { parseAmount, type ParsedAmount, type Span } from '../../../amount-parser/src/index.ts';
import { categorise, kindOf, type Category, type Kind } from './categories.ts';
import { questionFor, type Question } from './questions.ts';

/** A saved movement. Amounts are always positive; the direction is `kind`, never a sign. */
export interface Row {
  id: string;
  /** ISO 8601 timestamp of when it was saved. */
  at: string;
  kind: Kind;
  amount: number;
  category: Category;
  /** The word that picked the category, or null when the category is the default for the kind. */
  keyword: string | null;
  /** What the owner typed or dictated, word for word. */
  sentence: string;
  /** How the amount was obtained: "3 x 12 mil", "45 lucas", or the answer to a question. */
  literal: string;
  /** "30 lucas y pico": the amount is a floor. */
  approximate: boolean;
}

interface Guess {
  text: string;
  parsed: ParsedAmount;
  kind: Kind;
  /** The phrase that decided income or expense, or null when expense was assumed. */
  kindKeyword: string | null;
  category: Category;
  keyword: string | null;
  spans: Span[];
}

export type Draft =
  | ({ status: 'ready'; amount: number; literal: string; approximate: boolean } & Guess)
  | ({ status: 'ask'; question: Question } & Guess)
  | { status: 'no_amount'; text: string }
  | { status: 'invalid'; text: string; message: string; spans: Span[] };

/** The largest amount the till accepts. Past this a figure is a typo, not a sale. */
export const MAX_AMOUNT = 1e11;

function guess(text: string, parsed: ParsedAmount): Guess {
  const k = kindOf(text);
  const c = categorise(text, k.kind);
  return {
    text,
    parsed,
    kind: k.kind,
    kindKeyword: k.keyword,
    category: c.category,
    keyword: c.keyword,
    spans: parsed.spans,
  };
}

function checkAmount(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return 'El monto tiene que ser mayor que cero.';
  if (value > MAX_AMOUNT) return 'Ese monto es demasiado grande para una caja. Revisá la frase.';
  return null;
}

export function readSentence(input: string): Draft {
  const text = input.trim();
  const parsed = parseAmount(text);
  if (!parsed) return { status: 'no_amount', text };
  const base = guess(text, parsed);

  if (parsed.ambiguous) {
    const question = questionFor(text, parsed);
    // When every reading gives the same amount there is nothing to ask: "vendí 1 torta a 8000"
    // is 8000 either way, and two buttons with the same number would be a question for nothing.
    const first = question.options[0];
    if (first && question.options.length > 1 && question.options.every((o) => o.amount === first.amount)) {
      const problem = checkAmount(first.amount);
      if (problem) return { status: 'invalid', text, message: problem, spans: parsed.spans };
      return { ...base, status: 'ready', amount: first.amount, literal: first.literal, approximate: false };
    }
    return { ...base, status: 'ask', question };
  }

  // A parse that is not ambiguous always carries a value; the check keeps the type honest.
  if (parsed.value === null) return { status: 'no_amount', text };
  const problem = checkAmount(parsed.value);
  if (problem) return { status: 'invalid', text, message: problem, spans: parsed.spans };
  return {
    ...base,
    status: 'ready',
    amount: parsed.value,
    literal: parsed.literal,
    approximate: parsed.approximate,
  };
}

/** What the owner did with the preview: save it as read, pick a button, or type the amount. */
export type Answer =
  | { type: 'as_read' }
  | { type: 'option'; index: number }
  | { type: 'typed'; text: string };

export type Resolution = { ok: true; row: Row } | { ok: false; message: string };

export interface RowContext {
  now: Date;
  id: string;
  /** Overrides the guessed kind, when the owner flipped it on the preview. */
  kind?: Kind;
}

/**
 * Turns a draft and an answer into a row. A typed amount goes through the same parser, and must be
 * one plain amount: typing "entre 10 y 12" in the answer box does not get past the question.
 */
export function resolve(draft: Draft, answer: Answer, ctx: RowContext): Resolution {
  if (draft.status === 'no_amount' || draft.status === 'invalid') {
    return { ok: false, message: 'No hay un monto para guardar.' };
  }
  let amount: number;
  let literal: string;
  let approximate = false;

  if (answer.type === 'as_read') {
    if (draft.status !== 'ready') return { ok: false, message: 'Primero respondé la pregunta.' };
    amount = draft.amount;
    literal = draft.literal;
    approximate = draft.approximate;
  } else if (answer.type === 'option') {
    if (draft.status !== 'ask') return { ok: false, message: 'Esta frase no tiene opciones.' };
    const option = draft.question.options[answer.index];
    if (!option) return { ok: false, message: 'Esa opción no existe.' };
    amount = option.amount;
    literal = option.literal;
  } else {
    if (draft.status === 'ask' && !draft.question.typed) {
      return { ok: false, message: 'Esta frase no se puede guardar como un solo monto.' };
    }
    const typed = parseAmount(answer.text.trim());
    if (!typed || typed.ambiguous || typed.value === null) {
      return { ok: false, message: 'Escribí un solo monto, por ejemplo 45000 o 45 mil.' };
    }
    amount = typed.value;
    literal = typed.literal;
    approximate = typed.approximate;
  }

  const problem = checkAmount(amount);
  if (problem) return { ok: false, message: problem };

  const kind = ctx.kind ?? draft.kind;
  // Flipping the kind re-picks the category from the other side's table, so an income never ends
  // up under an expense category.
  const category = kind === draft.kind ? { category: draft.category, keyword: draft.keyword } : categorise(draft.text, kind);
  return {
    ok: true,
    row: {
      id: ctx.id,
      at: ctx.now.toISOString(),
      kind,
      amount,
      category: category.category,
      keyword: category.keyword,
      sentence: draft.text,
      literal,
      approximate,
    },
  };
}
