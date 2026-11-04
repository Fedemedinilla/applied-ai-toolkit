import { describe, expect, it } from 'vitest';
import { readSentence, resolve, type Draft } from '../src/entry.ts';

const ctx = { now: new Date('2026-11-04T13:30:00Z'), id: 'r1' };

function draft(text: string): Draft {
  return readSentence(text);
}

describe('readSentence', () => {
  it('a plain amount is ready, with kind, category, the keywords behind them and the spans', () => {
    const d = draft('pagué la luz 45 lucas');
    expect(d).toMatchObject({
      status: 'ready',
      amount: 45000,
      kind: 'expense',
      kindKeyword: 'pagué',
      category: 'Servicios',
      keyword: 'luz',
      literal: '45 lucas',
      approximate: false,
    });
    if (d.status !== 'ready') throw new Error('unreachable');
    expect(d.spans).toEqual([{ start: 13, end: 21, text: '45 lucas', role: 'amount' }]);
  });

  it('a computed amount keeps how it was computed', () => {
    expect(draft('vendí 3 docenas a 12 mil la docena')).toMatchObject({
      status: 'ready',
      amount: 36000,
      literal: '3 x 12 mil',
      kind: 'income',
    });
  });

  it('an approximate amount is ready and flagged', () => {
    expect(draft('le pagué 30 lucas y pico al gasista')).toMatchObject({ status: 'ready', amount: 30000, approximate: true });
  });

  it('an ambiguous sentence carries a question and no amount', () => {
    const d = draft('vendí 5 tortas a 8000');
    expect(d.status).toBe('ask');
    expect(d).not.toHaveProperty('amount');
  });

  it('when both readings give the same amount there is no question', () => {
    expect(draft('vendí 1 torta a 8000')).toMatchObject({ status: 'ready', amount: 8000 });
  });

  it('no amount, and a zero amount, cannot be saved', () => {
    expect(draft('hoy llovió mucho')).toEqual({ status: 'no_amount', text: 'hoy llovió mucho' });
    expect(draft('gasté 0 pesos')).toMatchObject({ status: 'invalid', message: 'El monto tiene que ser mayor que cero.' });
  });

  it('trims the sentence', () => {
    expect(draft('   pagué la luz 45 lucas  ')).toMatchObject({ text: 'pagué la luz 45 lucas' });
  });
});

describe('resolve', () => {
  it('saves a ready draft as read', () => {
    const r = resolve(draft('pagué la luz 45 lucas'), { type: 'as_read' }, ctx);
    expect(r).toEqual({
      ok: true,
      row: {
        id: 'r1',
        at: '2026-11-04T13:30:00.000Z',
        kind: 'expense',
        amount: 45000,
        category: 'Servicios',
        keyword: 'luz',
        sentence: 'pagué la luz 45 lucas',
        literal: '45 lucas',
        approximate: false,
      },
    });
  });

  it('an ambiguous draft is not saved until a reading is picked', () => {
    const d = draft('vendí 5 tortas a 8000');
    expect(resolve(d, { type: 'as_read' }, ctx)).toEqual({ ok: false, message: 'Primero respondé la pregunta.' });
    expect(resolve(d, { type: 'option', index: 0 }, ctx)).toMatchObject({ ok: true, row: { amount: 40000, literal: '5 x 8000' } });
    expect(resolve(d, { type: 'option', index: 1 }, ctx)).toMatchObject({ ok: true, row: { amount: 8000 } });
    expect(resolve(d, { type: 'option', index: 7 }, ctx)).toMatchObject({ ok: false });
  });

  it('a typed answer goes through the parser and must be one plain amount', () => {
    const d = draft('vendí el sillón en un palo y pico');
    expect(resolve(d, { type: 'typed', text: '1.250.000' }, ctx)).toMatchObject({ ok: true, row: { amount: 1250000 } });
    expect(resolve(d, { type: 'typed', text: 'un palo' }, ctx)).toMatchObject({ ok: true, row: { amount: 1000000 } });
    expect(resolve(d, { type: 'typed', text: 'entre 10 y 12 mil' }, ctx)).toMatchObject({ ok: false });
    expect(resolve(d, { type: 'typed', text: 'no sé' }, ctx)).toMatchObject({ ok: false });
    expect(resolve(d, { type: 'typed', text: '0' }, ctx)).toEqual({ ok: false, message: 'El monto tiene que ser mayor que cero.' });
  });

  it('a sentence with money in and out cannot be saved by typing one amount', () => {
    const d = draft('cobré 50 mil de la obra y pagué 12 mil de materiales');
    expect(resolve(d, { type: 'typed', text: '38000' }, ctx)).toMatchObject({ ok: false });
  });

  it('flipping the kind re-picks the category from the other side', () => {
    const r = resolve(draft('me devolvieron 12 mil de la harina'), { type: 'as_read' }, { ...ctx, kind: 'expense' });
    expect(r).toMatchObject({ ok: true, row: { kind: 'expense', category: 'Materia prima', keyword: 'harina' } });
  });

  it('nothing to save without an amount', () => {
    expect(resolve(draft('hola'), { type: 'typed', text: '5000' }, ctx)).toMatchObject({ ok: false });
  });
});
