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

function joinsTenAndUnit(before: string | undefined, after: string | undefined): boolean {
  const ten = NUMBER_WORDS[before ?? ''];
  const unit = NUMBER_WORDS[after ?? ''];
  return ten !== undefined && unit !== undefined && ten >= 30 && ten <= 90 && ten % 10 === 0 && unit >= 1 && unit <= 9;
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
  let scaledAfterMillion = false;
  let lastScale = 1;
  let i = start;

  for (; i < raw.length; i++) {
    const t = raw[i]!;

    // "treinta y cinco": the "y" inside a number is part of it. Spanish puts it only between a ten
    // from treinta to noventa and a unit; anywhere else it joins two figures ("entre veinte y
    // veinticinco mil" is a range, not 45.000), and the rules that read joiners have to see both.
    if (found && t === 'y' && joinsTenAndUnit(raw[i - 1], raw[i + 1])) continue;

    const unit = NUMBER_WORDS[t];
    if (unit !== undefined) {
      current = current === 0 ? unit : current + unit;
      found = true;
      continue;
    }

    const scale = scales[t];
    if (scale !== undefined) {
      // A scale after the million closes the group in front of it ("un millon doscientos cincuenta
      // MIL"), so what follows is read as it is said ("... mil quinientos" is 500, not 500.000).
      if (usedMillion && scale < 1_000_000) scaledAfterMillion = true;
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
  // "un millon doscientos" is said for 1.200.000, and "un millon doscientos cincuenta" for
  // 1.250.000: after a million, a bare group under a thousand with no scale of its own is
  // understood as thousands. That is the colloquial reading, and the corpus agrees with it.
  if (usedMillion && !scaledAfterMillion && total >= 1_000_000 && current > 0 && current < 1000) current *= 1000;
  const value = total + current;
  return Number.isFinite(value) && value > 0 ? { value, consumed: i - start, lastScale } : null;
}
