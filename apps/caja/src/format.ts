// Display helpers. Pure, so the tests can pin the exact strings the screen shows.

import type { Span } from '../../../amount-parser/src/index.ts';

// Whole pesos show no decimals; anything with cents shows two, as a till does ("$0,30", not "$0,3").
const WHOLE = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const CENTS = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$36.000", "$1.234,50". The till works in one currency, so the sign is always "$". */
export function money(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return `$${(Number.isInteger(rounded) ? WHOLE : CENTS).format(rounded)}`;
}

/** Signed for the list: "+$36.000" for income, "−$45.000" for an expense (U+2212 minus sign). */
export function signedMoney(amount: number, kind: 'income' | 'expense'): string {
  return `${kind === 'income' ? '+' : '−'}${money(amount)}`;
}

/** Local calendar day as YYYY-MM-DD. Rows are grouped by the day the owner lived, not by UTC. */
export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function localTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export interface Segment {
  text: string;
  /** The role of the span this piece of text belongs to, or null for plain text. */
  role: Span['role'] | null;
}

/**
 * Cuts the sentence into plain and highlighted pieces. Spans come from the parser as offsets into
 * the exact string it was given. Spans that overlap an earlier one or fall outside the text are
 * dropped rather than trusted, so a bad span can never duplicate or lose characters.
 */
export function segments(text: string, spans: readonly Span[]): Segment[] {
  const sorted = [...spans]
    .filter((s) => s.start >= 0 && s.end <= text.length && s.start < s.end)
    .sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let at = 0;
  for (const span of sorted) {
    if (span.start < at) continue;
    if (span.start > at) out.push({ text: text.slice(at, span.start), role: null });
    out.push({ text: text.slice(span.start, span.end), role: span.role });
    at = span.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), role: null });
  return out;
}
