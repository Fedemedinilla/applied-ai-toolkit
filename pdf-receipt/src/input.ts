// The public data shape, its validation, and the step that turns it into drawable text.
//
// Numbers are checked strictly and throw: a price that is NaN or a float of cents is a bug in the
// caller, and printing "$NaN" or silently leaving a line out would put it on paper. Text is never
// rejected: any string is accepted, made safe for the font, and a warning says what was removed.

import { formatCalendarDate, formatCents, formatQuantity, lineTotalCents, type MoneyFormat } from './money.ts';
import type { ReceiptLabels } from './labels.ts';
import { toWinAnsiLine, toWinAnsiParagraphs } from './winansi.ts';

export interface ReceiptParty {
  readonly name: string;
  /** Address, contact, tax id: one string per printed line. At most MAX_PARTY_LINES are drawn. */
  readonly lines?: readonly string[] | undefined;
}

export interface ReceiptItem {
  readonly name: string;
  /** A short second column, such as a pack size ("x12") or a variant. */
  readonly detail?: string | undefined;
  /** Positive, with at most three decimals (1.25 kg). */
  readonly quantity: number;
  /** Integer cents, zero or more. */
  readonly unitPriceCents: number;
}

export interface ReceiptData {
  /** The document number as printed: "R-0042". */
  readonly number: string;
  /** Calendar date of issue, "YYYY-MM-DD". Also used as the PDF's creation date. */
  readonly issuedOn: string;
  readonly shop: ReceiptParty;
  readonly customer: ReceiptParty;
  /** Calendar date of delivery, "YYYY-MM-DD"; the line is left out when absent. */
  readonly deliveryOn?: string | null | undefined;
  readonly items: readonly ReceiptItem[];
  /**
   * Integer cents. null or absent: no shipping line. 0: a shipping line that shows $0, with no
   * grand total (it would repeat the items total). More than 0: shipping and a grand total.
   */
  readonly shippingCents?: number | null | undefined;
  /**
   * Integer cents owed from earlier orders, printed under the totals as a reminder and never
   * added to them. Negative: a credit in the customer's favour, printed without the sign.
   * null, absent or 0: nothing is printed.
   */
  readonly previousBalanceCents?: number | null | undefined;
  /** Free text, wrapped; line breaks start new paragraphs. Continues across pages. */
  readonly notes?: string | null | undefined;
  /** One line at the foot of every page. */
  readonly footer?: string | null | undefined;
}

export type ReceiptInputErrorCode = 'invalid_amount' | 'invalid_quantity' | 'invalid_date' | 'amount_too_large' | 'invalid_option';

/** A number, date or option that cannot be printed truthfully. `field` is a path such as "items[3].quantity". */
export class ReceiptInputError extends Error {
  readonly code: ReceiptInputErrorCode;
  readonly field: string;
  constructor(code: ReceiptInputErrorCode, field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'ReceiptInputError';
    this.code = code;
    this.field = field;
  }
}

export type ReceiptWarning =
  | { readonly code: 'characters_dropped'; readonly field: string; readonly count: number }
  | { readonly code: 'text_clipped'; readonly field: string }
  | { readonly code: 'lines_omitted'; readonly field: string; readonly count: number }
  | { readonly code: 'logo_unreadable'; readonly reason: 'unknown_format' | 'embed_failed' };

/** Amounts up to 99,999,999,999.99. The running total is checked after each line, so it never leaves the safe-integer range. */
export const MAX_CENTS = 9_999_999_999_999;
export const MAX_QUANTITY = 1_000_000;
export const MAX_PARTY_LINES = 4;

function cents(value: unknown, field: string, { allowNegative }: { allowNegative: boolean }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ReceiptInputError('invalid_amount', field, 'must be an integer number of cents');
  }
  if (value < 0 && !allowNegative) throw new ReceiptInputError('invalid_amount', field, 'must not be negative');
  if (Math.abs(value) > MAX_CENTS) throw new ReceiptInputError('amount_too_large', field, `must be at most ${MAX_CENTS} cents`);
  return value;
}

function optionalCents(value: unknown, field: string, allowNegative: boolean): number | null {
  if (value === null || value === undefined) return null;
  return cents(value, field, { allowNegative });
}

function quantity(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_QUANTITY) {
    throw new ReceiptInputError('invalid_quantity', field, `must be a number above 0 and at most ${MAX_QUANTITY}`);
  }
  if (Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-6) {
    throw new ReceiptInputError('invalid_quantity', field, 'must have at most three decimals');
  }
  return value;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function calendarDate(value: unknown, field: string): string {
  const m = typeof value === 'string' ? ISO_DATE.exec(value) : null;
  const [y, mo, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (!m || y < 1900 || probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new ReceiptInputError('invalid_date', field, 'must be a real calendar date as YYYY-MM-DD');
  }
  return value as string;
}

/** Everything the layout draws, already validated, computed and made safe for the font. */
export interface PreparedReceipt {
  readonly number: string;
  readonly issuedOn: string;
  readonly issuedText: string;
  readonly shop: { readonly name: string; readonly lines: readonly string[] };
  readonly customer: { readonly name: string; readonly lines: readonly string[] };
  readonly deliveryText: string | null;
  readonly items: ReadonlyArray<{
    readonly name: string;
    readonly detail: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly lineTotal: string;
  }>;
  readonly itemsTotalCents: number;
  readonly shippingCents: number | null;
  readonly previousBalanceCents: number | null;
  readonly notes: readonly string[];
  readonly footer: string;
  readonly labels: ReceiptLabels;
  readonly money: (cents: number) => string;
}

export interface PrepareContext {
  readonly labels: ReceiptLabels;
  readonly format: MoneyFormat;
  readonly warn: (warning: ReceiptWarning) => void;
}

export function prepare(data: ReceiptData, { labels: rawLabels, format, warn }: PrepareContext): PreparedReceipt {
  // Labels go through the same sanitizer: an override can contain anything a caller types.
  const labelText = Object.fromEntries(
    Object.entries(rawLabels).map(([k, v]) => [k, toWinAnsiLine(typeof v === 'string' ? v : '').text]),
  ) as ReceiptLabels;
  /**
   * A formatted number or date. Unlike caller text, it must reach the paper whole: a digit the
   * font cannot draw would turn "$1.500" into "$", so a locale that produces one is refused.
   */
  const printable = (formatted: string): string => {
    const { text, dropped } = toWinAnsiLine(formatted);
    if (dropped > 0) {
      throw new ReceiptInputError('invalid_option', 'locale', 'formats numbers or dates with characters the PDF fonts cannot draw');
    }
    return text;
  };
  /** One line of caller text. A field that had text and lost all of it says so instead of going blank. */
  const line = (value: unknown, field: string): string => {
    const raw = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
    const { text, dropped } = toWinAnsiLine(raw);
    if (dropped > 0) warn({ code: 'characters_dropped', field, count: dropped });
    return text === '' && dropped > 0 ? labelText.unprintable : text;
  };
  const money = (c: number): string => printable(formatCents(c, format));

  const party = (p: ReceiptParty, field: string) => {
    const all = p.lines ?? [];
    if (all.length > MAX_PARTY_LINES) warn({ code: 'lines_omitted', field: `${field}.lines`, count: all.length - MAX_PARTY_LINES });
    return {
      name: line(p.name, `${field}.name`),
      lines: all
        .slice(0, MAX_PARTY_LINES)
        .map((l, i) => line(l, `${field}.lines[${i}]`))
        .filter((l) => l.length > 0),
    };
  };

  if (!Array.isArray(data.items)) throw new ReceiptInputError('invalid_option', 'items', 'must be an array');
  let itemsTotal = 0;
  const items = data.items.map((item, i) => {
    const q = quantity(item.quantity, `items[${i}].quantity`);
    const price = cents(item.unitPriceCents, `items[${i}].unitPriceCents`, { allowNegative: false });
    const total = lineTotalCents(q, price);
    if (total > MAX_CENTS) throw new ReceiptInputError('amount_too_large', `items[${i}]`, 'quantity x unit price is too large');
    itemsTotal += total;
    if (itemsTotal > MAX_CENTS) throw new ReceiptInputError('amount_too_large', 'items', 'the items total is too large');
    return {
      name: line(item.name, `items[${i}].name`),
      detail: line(item.detail, `items[${i}].detail`),
      quantity: printable(formatQuantity(q, format.locale)),
      unitPrice: money(price),
      lineTotal: money(total),
    };
  });

  const shipping = optionalCents(data.shippingCents, 'shippingCents', false);
  if (shipping !== null && itemsTotal + shipping > MAX_CENTS) {
    throw new ReceiptInputError('amount_too_large', 'shippingCents', 'the grand total is too large');
  }
  const issuedOn = calendarDate(data.issuedOn, 'issuedOn');
  const deliveryOn = data.deliveryOn === null || data.deliveryOn === undefined ? null : calendarDate(data.deliveryOn, 'deliveryOn');

  let notes: string[] = [];
  if (data.notes !== null && data.notes !== undefined) {
    const { paragraphs, dropped } = toWinAnsiParagraphs(String(data.notes));
    if (dropped > 0) warn({ code: 'characters_dropped', field: 'notes', count: dropped });
    notes = paragraphs.length === 0 && dropped > 0 ? [labelText.unprintable] : paragraphs;
  }

  return {
    number: line(data.number, 'number'),
    issuedOn,
    issuedText: printable(formatCalendarDate(issuedOn, format.locale)),
    shop: party(data.shop, 'shop'),
    customer: party(data.customer, 'customer'),
    deliveryText: deliveryOn === null ? null : printable(formatCalendarDate(deliveryOn, format.locale)),
    items,
    itemsTotalCents: itemsTotal,
    shippingCents: shipping,
    previousBalanceCents: optionalCents(data.previousBalanceCents, 'previousBalanceCents', true),
    notes,
    footer: line(data.footer, 'footer'),
    labels: labelText,
    money,
  };
}
