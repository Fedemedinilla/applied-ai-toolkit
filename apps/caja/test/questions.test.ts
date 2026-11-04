import { describe, expect, it } from 'vitest';
import { parseAmount, type AmbiguityReason } from '../../../amount-parser/src/index.ts';
import { questionFor, singular, type Question } from '../src/questions.ts';
import { corpus } from './corpus-json.ts';

function ask(text: string): Question {
  const parsed = parseAmount(text);
  if (!parsed?.ambiguous) throw new Error(`expected an ambiguous parse: ${text}`);
  return questionFor(text, parsed);
}

const amounts = (q: Question): number[] => q.options.map((o) => o.amount);

describe('one question per ambiguity reason', () => {
  it('unit_or_total names the unit and offers both readings', () => {
    const q = ask('vendí 5 docenas a 12 mil');
    expect(q.reason).toBe('unit_or_total');
    expect(q.prompt).toBe('¿12 mil cada docena o 12 mil en total?');
    expect(q.options).toEqual([
      { label: '12 mil cada docena: $60.000', amount: 60000, literal: '5 x 12 mil' },
      { label: '12 mil en total: $12.000', amount: 12000, literal: '12 mil' },
    ]);
    expect(q.typed).toBe(true);
  });

  it('unit_or_total without a noun says "cada uno"', () => {
    expect(ask('el 10 vendí 4 a 15 mil').prompt).toBe('¿15 mil cada uno o 15 mil en total?');
  });

  it('range: the first figure borrows the scale word said once, after the second', () => {
    const q = ask('entre 20 y 25 mil de flete');
    expect(q.reason).toBe('range');
    expect(amounts(q)).toEqual([20000, 25000]);
  });

  it('range with both scales said', () => {
    expect(amounts(ask('el gasista me pidió de 80 mil a 100 mil'))).toEqual([80000, 100000]);
  });

  it('discount_unclear: before or after, with the rate applied by the code', () => {
    const q = ask('compré por 50 mil con 20% de descuento');
    expect(q.prompt).toBe('¿Los 50 mil son antes o después del 20% de descuento?');
    expect(amounts(q)).toEqual([40000, 50000]);
    expect(ask('me hicieron un 10 de descuento sobre 45 mil').options.map((o) => o.amount)).toEqual([40500, 45000]);
  });

  it('tax_unclear: uses the stated rate, or offers 21% as a labelled button', () => {
    expect(amounts(ask('el proveedor me cobró 200 mil más el 21 de iva'))).toEqual([200000, 242000]);
    const q = ask('facturé 100 mil más iva');
    expect(q.options[1]?.label).toBe('No, va aparte (21%): $121.000');
  });

  it('instalments: the whole purchase or this payment', () => {
    const q = ask('compré la heladera en 6 cuotas sin interés de 25 lucas');
    expect(q.reason).toBe('instalments');
    expect(amounts(q)).toEqual([150000, 25000]);
  });

  it('net_or_gross: the full amount or what was left', () => {
    expect(amounts(ask('me pagaron 100 mil pero me descontaron 10 mil de comisión'))).toEqual([100000, 90000]);
  });

  it('open_remainder asks for the exact amount, with no buttons to guess from', () => {
    const q = ask('vendí el sillón en un palo y pico');
    expect(q).toMatchObject({ reason: 'open_remainder', options: [], typed: true });
    expect(q.prompt).toContain('un palo y pico');
  });

  it('several_quantities asks for the total', () => {
    expect(ask('compré dos cajas de doce gaseosas a mil doscientos cada una')).toMatchObject({
      reason: 'several_quantities',
      options: [],
      typed: true,
    });
  });

  it('foreign_currency asks how many pesos', () => {
    const q = ask('me pagaron 800 usd por el trabajo');
    expect(q).toMatchObject({ reason: 'foreign_currency', options: [], typed: true });
    expect(q.prompt).toContain('pesos');
  });

  it('mixed_directions cannot be saved as one amount at all', () => {
    expect(ask('cobré 50 mil de la obra y pagué 12 mil de materiales')).toMatchObject({
      reason: 'mixed_directions',
      options: [],
      typed: false,
    });
  });

  it('every ambiguous corpus phrase gets a question for its own reason, with positive, distinct buttons', () => {
    const seen = new Set<AmbiguityReason>();
    for (const c of corpus) {
      const parsed = parseAmount(c.phrase);
      if (!parsed?.ambiguous || !parsed.reason) continue;
      const q = questionFor(c.phrase, parsed);
      seen.add(q.reason);
      expect(q.reason).toBe(parsed.reason);
      expect(q.prompt.length).toBeGreaterThan(0);
      for (const o of q.options) expect(o.amount).toBeGreaterThan(0);
      expect(new Set(amounts(q)).size).toBe(q.options.length);
      expect(q.typed || q.reason === 'mixed_directions').toBe(true);
    }
    expect(seen.size).toBe(10);
  });
});

describe('singular', () => {
  it.each([
    ['docenas', 'docena'],
    ['tortas', 'torta'],
    ['panes', 'pan'],
    ['alfajores', 'alfajor'],
    ['postres', 'postre'],
    ['fletes', 'flete'],
    ['kilo', 'kilo'],
  ])('%s -> %s', (plural, one) => {
    expect(singular(plural)).toBe(one);
  });
});
