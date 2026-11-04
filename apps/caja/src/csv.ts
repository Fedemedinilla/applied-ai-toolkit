// CSV export, RFC 4180: comma separated, CRLF line ends, fields quoted when they hold a comma, a
// quote or a line break, with quotes doubled.
//
// The sentence is free text the owner typed, and spreadsheets run a cell that starts with "=",
// "+", "-", "@", a tab or a carriage return as a formula. A sentence like "=HYPERLINK(...)" would
// become a live link in the accountant's sheet. Those text cells get a leading apostrophe, which
// the spreadsheet shows as plain text. Numbers are written by the code and never get one.

import type { Row } from './entry.ts';
import { localDay, localTime } from './format.ts';

const FORMULA_START = /^[=+\-@\t\r]/u;

export function escapeField(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const HEADER = ['fecha', 'hora', 'tipo', 'monto', 'categoria', 'frase', 'calculo', 'aproximado'];

/** The whole book as CSV, oldest first. Amounts use a dot for decimals and no thousands separator. */
export function toCsv(rows: readonly Row[]): string {
  const sorted = [...rows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const lines = [HEADER.join(',')];
  for (const row of sorted) {
    const at = new Date(row.at);
    lines.push(
      [
        localDay(at),
        localTime(at),
        row.kind === 'income' ? 'ingreso' : 'gasto',
        String(row.amount),
        escapeField(row.category),
        escapeField(row.sentence),
        escapeField(row.literal),
        row.approximate ? 'si' : 'no',
      ].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
