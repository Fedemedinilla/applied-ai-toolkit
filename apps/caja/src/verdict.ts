// Model mode: the code decides what the model read. Pure and browser-safe, so it runs next to the
// parser the offline path uses, and the server is never trusted with the amount.
//
// The model's form is treated as a witness statement. Four rules:
//   1. The amount comes from the parser, run on the whole sentence. The model's number is only a
//      check: when the two disagree, or the model returns no number where the parser read one,
//      the row gets amount_mismatch and the owner is asked.
//   2. The category must be on the list and on the same side of the book as the kind. Anything
//      else falls back to the keyword table with a flag, never to "the closest match".
//   3. A date the sentence names must be a real day, not after today and at most DATE_WINDOW_DAYS
//      back. Anything else falls back to today with a flag.
//   4. Any flag, and any ambiguity the parser reports, leaves the row unconfirmed, and the UI asks.

import { categorise, EXPENSE_CATEGORIES, INCOME_CATEGORIES, kindOf, type Category, type Kind } from './categories.ts';
import { readSentence, type Draft } from './entry.ts';

/** What the endpoint returns: the model's form, validated with zod on the server and by isReading() here. */
export interface ModelReading {
  /** "unclear" when the sentence does not say which way the money went. */
  kind: Kind | 'unclear';
  /** A category name from the closed list, or null when none clearly fits. */
  category: string | null;
  /** True when the sentence says when it happened ("ayer", "el martes"). */
  dateStated: boolean;
  /** That day as YYYY-MM-DD, or null when it cannot be pinned down without guessing. */
  date: string | null;
  /** The total as the model read it. A check, never the stored value. */
  amount: number | null;
  /** One short sentence on which words decided the fields, shown to the owner. */
  reason: string;
}

export const FLAGS = [
  'amount_mismatch',
  'amount_ambiguous',
  'amount_missing',
  'kind_unclear',
  'kind_mismatch',
  'category_unknown',
  'category_wrong_side',
  'date_unverified',
] as const;
export type Flag = (typeof FLAGS)[number];

/** How far back a stated date may go. Past this, a misread month or year is likelier than a late entry. */
export const DATE_WINDOW_DAYS = 31;
export const MAX_REASON = 200;

export interface Verdict {
  /** The parser's reading of the full sentence: the only source of the amount. */
  draft: Draft;
  /** From the parser, or null when it found none or asks. */
  amount: number | null;
  /** The model's amount when it was a usable number, kept to show next to the parser's. */
  modelAmount: number | null;
  kind: Kind;
  /** Who picked the kind: the model, or the keyword table when the model said "unclear". */
  kindBy: 'model' | 'keyword';
  /** The keyword the table matched, when it matched one. */
  kindKeyword: string | null;
  category: Category;
  categoryBy: 'model' | 'keyword';
  /** The keyword that picked a fallback category, or null for the model's pick or the default. */
  keyword: string | null;
  /** YYYY-MM-DD: the stated day when it checks out, today otherwise. */
  date: string;
  /** The model's stated day when it is a real date, kept to name it in the date question. */
  modelDate: string | null;
  flags: Flag[];
  /** No flag at all: the row can be saved as read. */
  confirmed: boolean;
  reason: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** Days since 1970-01-01 for a valid YYYY-MM-DD, or null. "2026-02-30" is null, not March 2. */
export function dayNumber(date: string): number | null {
  const m = ISO_DATE.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms / 86_400_000;
}

/** The YYYY-MM-DD `days` before `date` (a valid one). */
export function daysBefore(date: string, days: number): string {
  const n = dayNumber(date);
  if (n === null) throw new Error(`caja: not a date: ${date}`);
  return new Date((n - days) * 86_400_000).toISOString().slice(0, 10);
}

const SIDE: Readonly<Record<Kind, ReadonlySet<string>>> = {
  income: new Set(INCOME_CATEGORIES),
  expense: new Set(EXPENSE_CATEGORIES),
};

export function isCategoryOf(kind: Kind, value: string): value is Category {
  return SIDE[kind].has(value);
}

/** A stated date the code accepts: a real day, not after today, at most DATE_WINDOW_DAYS back. */
export function dateInWindow(date: string, today: string): boolean {
  const n = dayNumber(date);
  const t = dayNumber(today);
  return n !== null && t !== null && n <= t && t - n <= DATE_WINDOW_DAYS;
}

export function verdict(sentence: string, reading: ModelReading, today: string): Verdict {
  if (dayNumber(today) === null) throw new Error(`caja: today is not a date: ${today}`);
  const flags: Flag[] = [];
  const text = sentence.trim();

  // 1. Amount: the parser on the whole sentence. The arithmetic lives in the sentence ("3 docenas a
  // 12 mil la docena"), so a fragment the model points at would only ever say 12 mil.
  const draft = readSentence(text);
  const modelAmount = typeof reading.amount === 'number' && Number.isFinite(reading.amount) && reading.amount > 0 ? reading.amount : null;
  let amount: number | null = null;
  if (draft.status === 'ready') {
    amount = draft.amount;
    if (modelAmount === null || Math.abs(modelAmount - amount) > 0.005) flags.push('amount_mismatch');
  } else if (draft.status === 'ask') {
    flags.push('amount_ambiguous');
  } else {
    flags.push('amount_missing');
  }

  // 2. Kind: the model's, checked against the keyword table when the table matched a phrase.
  const table = kindOf(text);
  let kind: Kind;
  let kindBy: Verdict['kindBy'];
  if (reading.kind === 'unclear') {
    kind = table.kind;
    kindBy = 'keyword';
    flags.push('kind_unclear');
  } else {
    kind = reading.kind;
    kindBy = 'model';
    if (table.keyword !== null && table.kind !== kind) flags.push('kind_mismatch');
  }

  // 3. Category: on the list and on the side of the kind, or the keyword table with a flag.
  let category: Category;
  let categoryBy: Verdict['categoryBy'] = 'model';
  let keyword: string | null = null;
  const proposed = reading.category;
  if (proposed !== null && isCategoryOf(kind, proposed)) {
    category = proposed;
  } else {
    const other: Kind = kind === 'income' ? 'expense' : 'income';
    flags.push(proposed !== null && isCategoryOf(other, proposed) ? 'category_wrong_side' : 'category_unknown');
    const fallback = categorise(text, kind);
    category = fallback.category;
    keyword = fallback.keyword;
    categoryBy = 'keyword';
  }

  // 4. Date: nothing said means today, which is right almost always and dirties nothing. A day that
  // was named and does not check out is a question, because the owner said a different day.
  let date = today;
  if (reading.dateStated) {
    if (reading.date !== null && dateInWindow(reading.date, today)) date = reading.date;
    else flags.push('date_unverified');
  }

  return {
    draft,
    amount,
    modelAmount,
    kind,
    kindBy,
    kindKeyword: table.keyword,
    category,
    categoryBy,
    keyword,
    date,
    modelDate: reading.dateStated && reading.date !== null && dayNumber(reading.date) !== null ? reading.date : null,
    flags,
    confirmed: flags.length === 0,
    reason: reading.reason.trim().slice(0, MAX_REASON),
  };
}

/**
 * The browser's check of what the endpoint sent. zod already validated it on the server, but the
 * page cannot tell that server from a proxy, an older deploy or a hand-written reply, and zod
 * would not fit the page's JavaScript budget. The category stays a string: verdict() checks it.
 */
export function isReading(value: unknown): value is ModelReading {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    (r['kind'] === 'income' || r['kind'] === 'expense' || r['kind'] === 'unclear') &&
    (r['category'] === null || typeof r['category'] === 'string') &&
    typeof r['dateStated'] === 'boolean' &&
    (r['date'] === null || typeof r['date'] === 'string') &&
    (r['amount'] === null || (typeof r['amount'] === 'number' && Number.isFinite(r['amount']))) &&
    typeof r['reason'] === 'string'
  );
}
