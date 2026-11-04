import { describe, expect, it } from 'vitest';
import { moneyForField, parseMoney, parseQuantity, quantityForField } from '../src/fields.ts';

const money = (s: string, negative = false) => parseMoney(s, { negative });

describe('parseMoney', () => {
  it.each([
    ['8000', 800_000],
    ['8.000', 800_000],
    ['8.000,50', 800_050],
    ['8000,5', 800_050],
    ['$ 8.000', 800_000],
    ['1.250.000', 125_000_000],
    ['0', 0],
    ['  12  ', 1200],
  ])('reads %j as %i cents', (s, cents) => {
    expect(money(s)).toEqual({ ok: true, value: cents });
  });

  it('reads empty as null, so a blank optional field prints nothing', () => {
    expect(money('')).toEqual({ ok: true, value: null });
    expect(money('   ')).toEqual({ ok: true, value: null });
  });

  it.each([
    ['8.5', 'Los centavos van con coma: 8.000,50.'],
    ['8000.50', 'Los centavos van con coma: 8.000,50.'],
    ['8 mil', 'Va solo en números, sin palabras: 8000 o 8.000,50.'],
    ['8.00', 'Los centavos van con coma: 8.000,50.'],
    ['80.00.000', 'Escribe el monto como 8000, 8.000 o 8.000,50.'],
    ['1e4', 'Va solo en números, sin palabras: 8000 o 8.000,50.'],
    ['8,505', 'Escribe el monto como 8000, 8.000 o 8.000,50.'],
    ['--5', 'Escribe el monto como 8000, 8.000 o 8.000,50.'],
  ])('refuses %j instead of guessing', (s, message) => {
    expect(money(s, true)).toEqual({ ok: false, message });
  });

  it('accepts a minus sign only where the field allows it', () => {
    expect(money('-3.000', true)).toEqual({ ok: true, value: -300_000 });
    expect(money('−3.000', true)).toEqual({ ok: true, value: -300_000 });
    expect(money('-3.000')).toEqual({ ok: false, message: 'No puede ser negativo.' });
  });

  it('refuses amounts above the library maximum', () => {
    expect(money('99.999.999.999,99')).toEqual({ ok: true, value: 9_999_999_999_999 });
    expect(money('100.000.000.000')).toEqual({ ok: false, message: 'Es demasiado grande.' });
  });

  it('round-trips through moneyForField', () => {
    for (const cents of [0, 1, 50, 800_000, 800_050, -300_000, 9_999_999_999_999]) {
      expect(money(moneyForField(cents), true)).toEqual({ ok: true, value: cents });
    }
    expect(moneyForField(null)).toBe('');
  });
});

describe('parseQuantity', () => {
  it('reads whole numbers and up to three decimals with a comma', () => {
    expect(parseQuantity('3')).toEqual({ ok: true, value: 3 });
    expect(parseQuantity('1,25')).toEqual({ ok: true, value: 1.25 });
    expect(parseQuantity('0,375')).toEqual({ ok: true, value: 0.375 });
    expect(quantityForField(1.25)).toBe('1,25');
  });

  it.each([
    ['', 'Falta la cantidad.'],
    ['0', 'Tiene que ser mayor que cero.'],
    ['1.5', 'Los decimales van con coma: 1,5.'],
    ['1,2345', 'Escribe la cantidad como 3 o 1,25 (hasta tres decimales).'],
    ['-1', 'Escribe la cantidad como 3 o 1,25 (hasta tres decimales).'],
    ['2000000', 'Es demasiado grande (hasta 1.000.000).'],
  ])('refuses %j', (s, message) => {
    expect(parseQuantity(s)).toEqual({ ok: false, message });
  });
});
