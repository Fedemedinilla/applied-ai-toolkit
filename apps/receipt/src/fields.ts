// Reading the money and quantity fields of the form into integer cents and numbers.
//
// The format is the one the PDF prints: a dot groups thousands and a comma starts the cents
// (8.000,50). A dot is accepted only in well-formed groups of three, so "8.5" is refused
// instead of being read as 85 or as 8,50: a value with two readings is never guessed.

import { MAX_CENTS, MAX_QUANTITY } from '../../../pdf-receipt/src/index.ts';

export type FieldResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

const MONEY = /^(-?)\s*\$?\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/u;

/** Empty text is `null` (the field was left blank). */
export function parseMoney(text: string, { negative }: { negative: boolean }): FieldResult<number | null> {
  const s = text.trim().replace(/−/gu, '-');
  if (s === '') return { ok: true, value: null };
  const m = MONEY.exec(s);
  if (!m) {
    if (/\p{L}/u.test(s)) return { ok: false, message: 'Va solo en números, sin palabras: 8000 o 8.000,50.' };
    if (/\d\.\d{1,2}$/u.test(s)) return { ok: false, message: 'Los centavos van con coma: 8.000,50.' };
    return { ok: false, message: 'Escribe el monto como 8000, 8.000 o 8.000,50.' };
  }
  const [, sign = '', whole = '', fraction = ''] = m;
  if (sign && !negative) return { ok: false, message: 'No puede ser negativo.' };
  const cents = Number(whole.replaceAll('.', '')) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return { ok: false, message: 'Es demasiado grande.' };
  return { ok: true, value: sign ? -cents : cents };
}

const MAX_QUANTITY_TEXT = new Intl.NumberFormat('es-AR').format(MAX_QUANTITY);
const QUANTITY = /^(\d+)(?:,(\d{1,3}))?$/u;

export function parseQuantity(text: string): FieldResult<number> {
  const s = text.trim();
  if (s === '') return { ok: false, message: 'Falta la cantidad.' };
  const m = QUANTITY.exec(s);
  if (!m) {
    if (/^\d+\.\d+$/u.test(s)) return { ok: false, message: 'Los decimales van con coma: 1,5.' };
    return { ok: false, message: 'Escribe la cantidad como 3 o 1,25 (hasta tres decimales).' };
  }
  const [, whole = '', fraction = ''] = m;
  const value = Number(`${whole}.${fraction || '0'}`);
  if (value <= 0) return { ok: false, message: 'Tiene que ser mayor que cero.' };
  if (value > MAX_QUANTITY) return { ok: false, message: `Es demasiado grande (hasta ${MAX_QUANTITY_TEXT}).` };
  return { ok: true, value };
}

/** Cents back into the field's own format, so reading the field again gives the same value. */
export function moneyForField(cents: number | null): string {
  if (cents === null) return '';
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const rest = abs % 100;
  return `${cents < 0 ? '-' : ''}${whole}${rest ? `,${String(rest).padStart(2, '0')}` : ''}`;
}

export function quantityForField(q: number): string {
  return String(q).replace('.', ',');
}
