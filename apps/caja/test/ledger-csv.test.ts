import { describe, expect, it } from 'vitest';
import { escapeField, toCsv } from '../src/csv.ts';
import type { Row } from '../src/entry.ts';
import { money, segments, signedMoney } from '../src/format.ts';
import { byDay, totalsFor, undoLast } from '../src/ledger.ts';

// Local times, so the day grouping does not depend on the machine's time zone.
const at = (day: number, hour: number): string => new Date(2026, 10, day, hour, 0).toISOString();

function row(id: string, kind: Row['kind'], amount: number, when: string, sentence = 'x'): Row {
  return { id, at: when, kind, amount, category: kind === 'income' ? 'Ventas' : 'Otros gastos', keyword: null, sentence, literal: String(amount), approximate: false };
}

describe('daily totals', () => {
  const rows = [
    row('a', 'income', 36000, at(3, 9)),
    row('b', 'expense', 45000, at(4, 8)),
    row('c', 'income', 120000, at(4, 12)),
    row('d', 'expense', 5000, at(4, 18)),
  ];

  it('groups by local day, newest first, and sums each side', () => {
    const days = byDay(rows);
    expect(days.map((d) => [d.day, d.income, d.expense, d.net])).toEqual([
      ['2026-11-04', 120000, 50000, 70000],
      ['2026-11-03', 36000, 0, 36000],
    ]);
    expect(days[0]?.rows.map((r) => r.id)).toEqual(['d', 'c', 'b']);
  });

  it('sums in cents', () => {
    const t = totalsFor([row('a', 'income', 0.1, at(4, 9)), row('b', 'income', 0.2, at(4, 10))], '2026-11-04');
    expect(t.income).toBe(0.3);
  });

  it('a day without rows is zero', () => {
    expect(totalsFor(rows, '2026-11-05')).toEqual({ day: '2026-11-05', income: 0, expense: 0, net: 0, rows: [] });
  });

  it('undo removes the most recently saved row, wherever it sits in the array', () => {
    const shuffled = [rows[3], rows[0], rows[1]].filter((r): r is Row => r !== undefined);
    const { rows: left, removed } = undoLast(shuffled);
    expect(removed?.id).toBe('d');
    expect(left.map((r) => r.id)).toEqual(['a', 'b']);
    expect(undoLast([])).toEqual({ rows: [], removed: null });
  });
});

describe('CSV', () => {
  it.each([
    ['plain', 'plain'],
    ['vendí 3, a 12 mil', '"vendí 3, a 12 mil"'],
    ['dijo "barato"', '"dijo ""barato"""'],
    ['dos\nlíneas', '"dos\nlíneas"'],
    ['=HYPERLINK("http://x.example")', '"\'=HYPERLINK(""http://x.example"")"'],
    ['+54 11', "'+54 11"],
    ['-5 mil', "'-5 mil"],
    ['@suma', "'@suma"],
  ])('escapes %j', (input, output) => {
    expect(escapeField(input)).toBe(output);
  });

  it('writes a header and one CRLF line per row, oldest first', () => {
    const csv = toCsv([
      row('b', 'expense', 45000, at(4, 8), 'pagué la luz, 45 lucas'),
      row('a', 'income', 1500.5, at(3, 9), 'vendí 3'),
    ]);
    expect(csv).toBe(
      'fecha,hora,tipo,monto,categoria,frase,calculo,aproximado\r\n' +
        '2026-11-03,09:00,ingreso,1500.5,Ventas,vendí 3,1500.5,no\r\n' +
        '2026-11-04,08:00,gasto,45000,Otros gastos,"pagué la luz, 45 lucas",45000,no\r\n',
    );
  });
});

describe('rows dated by the owner (model mode)', () => {
  it('count on the stated day, and the CSV writes that day with the time it was noted', () => {
    const dated: Row = { ...row('m', 'expense', 45000, at(4, 10), 'ayer pagué la luz'), day: '2026-11-03', via: 'model' };
    expect(byDay([dated, row('a', 'income', 1000, at(4, 9))]).map((d) => [d.day, d.expense])).toEqual([
      ['2026-11-04', 0],
      ['2026-11-03', 45000],
    ]);
    expect(toCsv([dated]).split('\r\n')[1]).toBe('2026-11-03,10:00,gasto,45000,Otros gastos,ayer pagué la luz,45000,no');
  });
});

describe('format', () => {
  it('money in es-AR', () => {
    expect(money(36000)).toBe('$36.000');
    expect(money(1234.5)).toBe('$1.234,50');
    expect(money(0.1 + 0.2)).toBe('$0,30');
    expect(money(45000.004)).toBe('$45.000');
    expect(signedMoney(45000, 'expense')).toBe('−$45.000');
    expect(signedMoney(45000, 'income')).toBe('+$45.000');
  });

  it('segments cut the sentence at the spans and never lose or repeat a character', () => {
    const text = 'vendí 3 docenas a 12 mil la docena';
    const spans = [
      { start: 18, end: 24, text: '12 mil', role: 'unit_price' as const },
      { start: 6, end: 7, text: '3', role: 'quantity' as const },
      { start: 20, end: 27, text: 'mil la', role: 'figure' as const }, // overlaps "12 mil": dropped
      { start: 30, end: 99, text: '', role: 'amount' as const }, // out of range: dropped
    ];
    const segs = segments(text, spans);
    expect(segs.map((s) => s.text).join('')).toBe(text);
    expect(segs.filter((s) => s.role).map((s) => [s.text, s.role])).toEqual([
      ['3', 'quantity'],
      ['12 mil', 'unit_price'],
    ]);
  });
});
