// Reading one number, from digits or from words.

import { NUMBER_WORDS } from './vocabulary.ts';

/**
 * Turns the text of a number into a value with the Argentine convention: dot for thousands,
 * comma for decimals. When both appear, the rightmost one is the decimal separator.
 *   "3.500"    -> 3500        "1.234,56" -> 1234.56
 *   "20,5"     -> 20.5        "2.50.000" -> 250000
 * Every character other than digits, dots and commas is dropped first, so a sign is lost
 * ("-5000" -> 5000). Returns null when no digit is left.
 */
export function parseNumber(raw: string): number | null {
  let s = raw.replace(/[^\d.,]/gu, '');
  if (!/\d/u.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    s = s.split(thousands).join('');
    s = s.replace(decimal, '.');
  } else if (lastComma >= 0) {
    // Comma only: decimal when one or two digits follow ("20,50"), thousands otherwise.
    s = /,\d{1,2}$/u.test(s) ? s.replace(/,/gu, '.') : s.split(',').join('');
  } else if (lastDot >= 0) {
    // Dot only. "3.500" is three thousand five hundred, not three and a half: exactly three
    // digits after the last dot, or more than one dot, means thousands.
    const dots = (s.match(/\./gu) ?? []).length;
    s = dots > 1 || /\.\d{3}$/u.test(s) ? s.split('.').join('') : s;
  }

  const n = Number(s);
  // Number('') is 0 and Number('.') is NaN: neither may pass as an amount.
  return Number.isFinite(n) && /\d/u.test(s) ? n : null;
}

export interface WordNumber {
  value: number;
  /** How many raw tokens the number spans. */
  consumed: number;
  /** The last scale applied, so "dos palos y medio" adds half a palo. */
  lastScale: number;
}

/** "dos mil quinientos" -> 2500, reading from `start` as far as the number continues. */
export function readWordNumber(
  raw: readonly string[],
  start: number,
  scales: Readonly<Record<string, number>>,
): WordNumber | null {
  let total = 0;
  let current = 0;
  let found = false;
  let usedMillion = false;
  let lastScale = 1;
  let i = start;

  for (; i < raw.length; i++) {
    const t = raw[i]!;

    // "treinta y cinco": the "y" inside a number is part of it.
    if (found && t === 'y' && NUMBER_WORDS[raw[i + 1] ?? ''] !== undefined) continue;

    const unit = NUMBER_WORDS[t];
    if (unit !== undefined) {
      // "un millon doscientos" is said for 1.200.000: after a million, a bare group under a
      // thousand is understood as thousands. That is the colloquial reading, and the corpus
      // agrees with it.
      if (usedMillion && current === 0 && total >= 1_000_000) {
        current = unit * 1000;
        found = true;
        continue;
      }
      current = current === 0 ? unit : current + unit;
      found = true;
      continue;
    }

    const scale = scales[t];
    if (scale !== undefined) {
      if (usedMillion && current >= 1000) {
        // "un millon doscientos mil": the group already carries its own thousands.
        total += current;
        current = 0;
        found = true;
        continue;
      }
      // "mil millones": a bigger scale after a smaller one multiplies what came before it.
      // Adding them would give 1.001.000 for a thousand million.
      if (scale > lastScale && total > 0 && current === 0) {
        total *= scale;
        lastScale = scale;
        if (scale >= 1_000_000) usedMillion = true;
        found = true;
        continue;
      }
      current = (current === 0 ? 1 : current) * scale;
      lastScale = scale;
      if (scale >= 1_000_000) usedMillion = true;
      total += current;
      current = 0;
      found = true;
      continue;
    }

    if (found) break;
  }

  if (!found) return null;
  const value = total + current;
  return Number.isFinite(value) && value > 0 ? { value, consumed: i - start, lastScale } : null;
}
