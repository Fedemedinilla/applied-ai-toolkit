// Totals per day. Sums run in integer cents, so 0.1 + 0.2 never shows up as $0,30000000000000004.

import type { Row } from './entry.ts';
import { localDay } from './format.ts';

export interface DayTotals {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  income: number;
  expense: number;
  /** income - expense. */
  net: number;
  rows: Row[];
}

const toCents = (n: number): number => Math.round(n * 100);

/** Rows grouped by local day, newest day first, newest row first inside each day. */
export function byDay(rows: readonly Row[]): DayTotals[] {
  const groups = new Map<string, { income: number; expense: number; rows: Row[] }>();
  for (const row of rows) {
    const day = localDay(new Date(row.at));
    let group = groups.get(day);
    if (!group) {
      group = { income: 0, expense: 0, rows: [] };
      groups.set(day, group);
    }
    if (row.kind === 'income') group.income += toCents(row.amount);
    else group.expense += toCents(row.amount);
    group.rows.push(row);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, g]) => ({
      day,
      income: g.income / 100,
      expense: g.expense / 100,
      net: (g.income - g.expense) / 100,
      rows: [...g.rows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)),
    }));
}

/** The totals for one day, zero when nothing was saved that day. */
export function totalsFor(rows: readonly Row[], day: string): DayTotals {
  return byDay(rows).find((d) => d.day === day) ?? { day, income: 0, expense: 0, net: 0, rows: [] };
}

/** The rows without the most recently saved one, and that one (null when the list is empty). */
export function undoLast(rows: readonly Row[]): { rows: Row[]; removed: Row | null } {
  if (rows.length === 0) return { rows: [], removed: null };
  let last = 0;
  rows.forEach((row, i) => {
    const current = rows[last];
    if (current && row.at >= current.at) last = i;
  });
  return { rows: rows.filter((_, i) => i !== last), removed: rows[last] ?? null };
}
