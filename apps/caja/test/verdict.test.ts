// The verdict as a pure function: a table of model readings against the parser and the lists, and
// a property over the parser's corpus that the amount never comes from the model.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readSentence } from '../src/entry.ts';
import { dayNumber, daysBefore, isReading, verdict, type Flag, type ModelReading, type Verdict } from '../src/verdict.ts';
import { corpus } from './corpus-json.ts';

const TODAY = '2026-11-04';

const reading = (partial: Partial<ModelReading>): ModelReading => ({
  kind: 'expense',
  category: 'Servicios',
  dateStated: false,
  date: null,
  amount: 45000,
  reason: 'una razón',
  ...partial,
});

type Expected = Partial<Pick<Verdict, 'amount' | 'kind' | 'kindBy' | 'category' | 'categoryBy' | 'keyword' | 'date' | 'confirmed'>> & { flags: Flag[] };

const cases: Array<[string, string, Partial<ModelReading>, Expected]> = [
  [
    'agreement on every field is confirmed',
    'pagué la luz 45 lucas',
    {},
    { amount: 45000, kind: 'expense', kindBy: 'model', category: 'Servicios', categoryBy: 'model', date: TODAY, confirmed: true, flags: [] },
  ],
  [
    'the model read only the unit price: the parser total stands, flagged',
    'vendí 3 docenas a 12 mil la docena',
    { kind: 'income', category: 'Ventas', amount: 12000 },
    { amount: 36000, confirmed: false, flags: ['amount_mismatch'] },
  ],
  [
    'the model returned no amount where the parser read one',
    'pagué la luz 45 lucas',
    { amount: null },
    { amount: 45000, flags: ['amount_mismatch'] },
  ],
  [
    'a negative model amount counts as no amount',
    'pagué la luz 45 lucas',
    { amount: -45000 },
    { amount: 45000, flags: ['amount_mismatch'] },
  ],
  [
    'cents of float noise are not a mismatch',
    'pagué la luz 45 lucas',
    { amount: 45000.004 },
    { amount: 45000, confirmed: true, flags: [] },
  ],
  [
    'the parser asks: no amount even when the model is sure',
    'vendí 5 tortas a 8000',
    { kind: 'income', category: 'Ventas', amount: 40000 },
    { amount: null, confirmed: false, flags: ['amount_ambiguous'] },
  ],
  [
    'readings that give the same amount collapse, as offline',
    'vendí 1 torta a 8000',
    { kind: 'income', category: 'Ventas', amount: 8000 },
    { amount: 8000, confirmed: true, flags: [] },
  ],
  [
    'no amount in the sentence: the model figure is not used',
    'hoy vino poca gente',
    { kind: 'income', category: 'Ventas', amount: 30000 },
    { amount: null, flags: ['amount_missing'] },
  ],
  [
    'an income filed under an expense category falls back to the income table',
    'vendí 3 docenas a 12 mil la docena',
    { kind: 'income', category: 'Materia prima', amount: 36000 },
    { kind: 'income', category: 'Ventas', categoryBy: 'keyword', keyword: null, flags: ['category_wrong_side'] },
  ],
  [
    'an expense filed under an income category falls back by keyword',
    'compré 2 bolsas de harina a 22.500 la bolsa',
    { category: 'Ventas', amount: 45000 },
    { kind: 'expense', category: 'Materia prima', categoryBy: 'keyword', keyword: 'harina', flags: ['category_wrong_side'] },
  ],
  [
    'a category outside the list falls back with a flag',
    'pagué la luz 45 lucas',
    { category: 'Panadería' },
    { category: 'Servicios', categoryBy: 'keyword', keyword: 'luz', flags: ['category_unknown'] },
  ],
  [
    'no category from the model is a question too',
    'pagué la luz 45 lucas',
    { category: null },
    { category: 'Servicios', categoryBy: 'keyword', flags: ['category_unknown'] },
  ],
  [
    'kind unclear: the keyword table decides for now, and the owner is asked',
    'harina 20 mil',
    { kind: 'unclear', category: null, amount: 20000 },
    { kind: 'expense', kindBy: 'keyword', category: 'Materia prima', keyword: 'harina', flags: ['kind_unclear', 'category_unknown'] },
  ],
  [
    'model and keyword table disagree on the kind',
    'me cobró el gasista 20 mil',
    { kind: 'income', category: 'Ventas', amount: 20000 },
    { kind: 'income', kindBy: 'model', category: 'Ventas', flags: ['kind_mismatch'] },
  ],
  [
    'a kind the keyword table has no word for is not a mismatch',
    'me devolvieron 12 mil de la harina',
    { kind: 'income', category: 'Ventas', amount: 12000 },
    { kind: 'income', confirmed: true, flags: [] },
  ],
  ['"ayer" resolved by the model is kept', 'ayer pagué la luz 45 lucas', { dateStated: true, date: '2026-11-03' }, { date: '2026-11-03', confirmed: true, flags: [] }],
  ['the edge of the window is kept', 'pagué la luz 45 lucas', { dateStated: true, date: '2026-10-04' }, { date: '2026-10-04', flags: [] }],
  ['a day past the window is not', 'pagué la luz 45 lucas', { dateStated: true, date: '2026-10-03' }, { date: TODAY, flags: ['date_unverified'] }],
  ['a future day is not', 'pagué la luz 45 lucas', { dateStated: true, date: '2026-11-05' }, { date: TODAY, flags: ['date_unverified'] }],
  ['a day that does not exist is not', 'pagué la luz 45 lucas', { dateStated: true, date: '2026-02-30' }, { date: TODAY, flags: ['date_unverified'] }],
  ['a stated day the model could not pin down is asked', 'el otro día pagué la luz 45 lucas', { dateStated: true, date: null }, { date: TODAY, flags: ['date_unverified'] }],
  ['a date with nothing stated is ignored', 'pagué la luz 45 lucas', { dateStated: false, date: '2026-10-20' }, { date: TODAY, confirmed: true, flags: [] }],
];

describe('verdict', () => {
  it.each(cases)('%s', (_name, sentence, partial, expected) => {
    const v = verdict(sentence, reading(partial), TODAY);
    const { flags, ...fields } = expected;
    expect(v).toMatchObject(fields);
    expect(v.flags).toEqual(flags);
    expect(v.confirmed).toBe(flags.length === 0);
  });

  it('cuts the reason to 200 characters and trims it', () => {
    expect(verdict('pagué la luz 45 lucas', reading({ reason: `  ${'x'.repeat(300)}` }), TODAY).reason).toHaveLength(200);
  });

  it('refuses a today that is not a date', () => {
    expect(() => verdict('pagué la luz 45 lucas', reading({}), '04/11/2026')).toThrow(/not a date/u);
  });

  it('the amount is the parser’s on every corpus phrase, whatever the model says', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...corpus.map((c) => c.phrase)),
        fc.record({
          kind: fc.constantFrom('income', 'expense', 'unclear'),
          category: fc.option(fc.constantFrom('Ventas', 'Materia prima', 'Servicios', 'Otros gastos', 'Inventada')),
          dateStated: fc.boolean(),
          date: fc.option(fc.constantFrom('2026-11-03', '2026-11-05', '2025-11-04', 'mañana')),
          amount: fc.option(fc.double({ min: -1e9, max: 1e12, noNaN: true })),
          reason: fc.string({ maxLength: 20 }),
        }),
        (phrase, r) => {
          const v = verdict(phrase, r as ModelReading, TODAY);
          const d = readSentence(phrase);
          expect(v.amount).toBe(d.status === 'ready' ? d.amount : null);
          expect(v.confirmed).toBe(v.flags.length === 0);
          if (v.confirmed) expect(d.status).toBe('ready');
          if (v.kind === 'income') expect(['Ventas', 'Pedidos y encargos']).toContain(v.category);
          else expect(['Ventas', 'Pedidos y encargos']).not.toContain(v.category);
          expect(dayNumber(v.date)).not.toBeNull();
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('dates and the reading guard', () => {
  it('validates calendar days and steps back across months and years', () => {
    expect(dayNumber('2028-02-29')).not.toBeNull();
    expect(dayNumber('2026-02-29')).toBeNull();
    expect(dayNumber('2026-11-4')).toBeNull();
    expect(daysBefore('2026-03-01', 1)).toBe('2026-02-28');
    expect(daysBefore('2027-01-01', 1)).toBe('2026-12-31');
  });

  it.each([
    [reading({}), true],
    [reading({ kind: 'unclear', category: null, amount: null }), true],
    [{ ...reading({}), kind: 'maybe' }, false],
    [{ ...reading({}), amount: '45000' }, false],
    [{ ...reading({}), amount: Number.POSITIVE_INFINITY }, false],
    [{ ...reading({}), dateStated: 'yes' }, false],
    [{ kind: 'expense' }, false],
    [null, false],
    ['reading', false],
  ])('isReading(%j) is %s', (value, ok) => {
    expect(isReading(value)).toBe(ok);
  });
});
