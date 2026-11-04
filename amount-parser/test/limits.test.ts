// Known limits, pinned as they behave today. These are not the goal: each one is a wrong or
// questionable answer that the README lists. A test here fails when the behaviour changes, so a fix
// has to move the case into the corpus with a note and a control, which is how every other rule in
// this parser was added.

import { describe, expect, it } from 'vitest';
import { parseAmount } from '../src/index.ts';

const value = (text: string) => parseAmount(text)?.value;

describe('known limits', () => {
  it('"para" is a correction marker, so it can wipe a real amount', () => {
    // "para" is also "for". The first figure is dropped and the sum is lost.
    expect(value('gaste 5 mil para la fiesta y 3 mil de envio')).toBe(3_000);
  });

  it('"no" is a correction marker, so a negation reads as a correction', () => {
    // Meant: 20 mil, not 30 mil. Read: the figure after "no".
    expect(value('pague 20 mil de luz y no 30 mil')).toBe(30_000);
  });

  it('idioms match inside longer numbers', () => {
    // "doscientos dos pesos" contains the idiom "dos pesos" (next to nothing).
    expect(parseAmount('pague doscientos dos pesos')).toBeNull();
  });

  it('a zero amount comes back as a value', () => {
    expect(value('gaste 0 pesos en el mayorista')).toBe(0);
  });

  it('a minus sign is dropped', () => {
    expect(value('gaste -5000')).toBe(5_000);
  });

  it('scientific notation splits on the "e", which is also a conjunction', () => {
    expect(value('gaste 1e5')).toBe(6);
  });

  it('fullwidth digits are not read as digits', () => {
    // The tokenizer matches ASCII digits only, so "２０" is skipped and the bare "mil" is the amount.
    expect(value('gaste ２０ mil')).toBe(1_000);
  });

  it('"x" is not read as multiplication', () => {
    expect(value('pague 2 mil x 3')).toBe(2_000);
  });

  it('"cuotas a" and "pagos a" disagree', () => {
    // Step 8 needs "de" after the count. Step 9 then skips "cuota(s)" but not "pago(s)", so the
    // same shape returns one instalment for one noun and asks for the other.
    expect(value('lo pague en 4 cuotas a 90 mil')).toBe(90_000);
    expect(parseAmount('lo pague en 4 pagos a 90 mil')).toMatchObject({ ambiguous: true, reason: 'unit_or_total' });
  });
});
