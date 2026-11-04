import { describe, expect, it } from 'vitest';
import { categorise, fold, kindOf } from '../src/categories.ts';
import { corpus } from './corpus-json.ts';

describe('kindOf', () => {
  it.each([
    ['vendí 3 docenas a 12 mil la docena', 'income', 'vendí'],
    ['cierre de caja 486.300', 'income', 'cierre de caja'],
    ['me transfirieron 84.500 de un pedido', 'income', 'me transfirieron'],
    ['pagué la luz 45 lucas', 'expense', 'pagué'],
    ['compré 2 bolsas de harina a 22.500 la bolsa', 'expense', 'compré'],
    // "cobro" inside "me cobró" is the supplier charging me, not a sale.
    ['el molino me cobró 200 mil', 'expense', 'me cobró'],
    ['el proveedor me cobra 15 mil por el flete', 'expense', 'me cobra'],
    ['cobro 5000 de una torta', 'income', 'cobro'],
    ['hoy cobra la vecina 3 docenas, 36 mil', 'income', 'cobra'],
    // Typed without accents, it still matches; the preview shows the entry with its accent.
    ['vendi 2 tortas', 'income', 'vendí'],
  ] as const)('%s -> %s', (text, kind, keyword) => {
    expect(kindOf(text)).toEqual({ kind, keyword });
  });

  it('matches whole words, so "centro" does not read as "entró"', () => {
    expect(kindOf('30 mil en el centro')).toEqual({ kind: 'expense', keyword: null });
  });

  it('the earliest phrase in the sentence decides', () => {
    expect(kindOf('cobré 50 mil y pagué 12 mil').kind).toBe('income');
    expect(kindOf('pagué 12 mil y cobré 50 mil').kind).toBe('expense');
  });

  it('assumes expense and says so (keyword null) when nothing matches', () => {
    expect(kindOf('45 mil de luz')).toEqual({ kind: 'expense', keyword: null });
  });

  it('agrees with the kind recorded in the parser corpus on 164 of 165 phrases', () => {
    const misses = corpus.filter((c) => kindOf(c.phrase).kind !== c.kind).map((c) => c.phrase);
    expect(corpus).toHaveLength(165);
    // The one miss: "hice 5 destapaciones" is income only if you know the speaker is a plumber.
    expect(misses).toEqual(['hice 5 destapaciones a 35 lucas cada una']);
  });
});

describe('categorise', () => {
  it.each([
    ['pagué la luz 45 lucas', 'expense', 'Servicios', 'luz'],
    ['compré 2 bolsas de harina a 22.500 la bolsa', 'expense', 'Materia prima', 'harina'],
    ['compré 200 cajas para tortas', 'expense', 'Envases', 'cajas'],
    ['le pagué el sueldo al ayudante 300 mil', 'expense', 'Sueldos', 'sueldo'],
    ['vino el técnico del horno, 80 mil', 'expense', 'Mantenimiento', 'horno'],
    ['cargué nafta 30 mil', 'expense', 'Transporte', 'nafta'],
    ['cobré un pedido de 40 medialunas, 24 mil', 'income', 'Pedidos y encargos', 'pedido'],
  ] as const)('%s -> %s', (text, kind, category, keyword) => {
    expect(categorise(text, kind)).toEqual({ category, keyword });
  });

  it('"gasoil" is fuel, not the gas bill', () => {
    expect(categorise('cargué gasoil 50 mil', 'expense').category).toBe('Transporte');
  });

  it('the first category in the table wins: a bag of flour is raw material', () => {
    expect(categorise('bolsas de harina', 'expense').category).toBe('Materia prima');
  });

  it('an income never gets an expense category', () => {
    expect(categorise('vendí harina a un vecino 5 mil', 'income')).toEqual({ category: 'Ventas', keyword: null });
  });

  it('falls back to the default and reports no keyword', () => {
    expect(categorise('gasté 20 mil', 'expense')).toEqual({ category: 'Otros gastos', keyword: null });
  });
});

describe('fold', () => {
  it('drops accents and case and collapses punctuation', () => {
    expect(fold('  Pagué   la LUZ, 45.000!  ')).toBe('pague la luz 45 000');
  });
});
