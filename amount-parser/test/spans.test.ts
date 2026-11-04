// Spans point back at the caller's text: offsets into the original string, accents, capitals and
// double spaces included, so a UI can highlight what the number came from.

import { describe, expect, it } from 'vitest';
import { normalize, parseAmount, type Span } from '../src/index.ts';
import { corpus } from './corpus-data.ts';

const brief = (spans: Span[]) => spans.map((s) => [s.role, s.text]);

describe('spans', () => {
  it('a unit price, its count and nothing else', () => {
    expect(brief(parseAmount('Vendí 3 docenas a 12 mil la docena')!.spans)).toEqual([
      ['quantity', '3'],
      ['unit_price', '12 mil'],
    ]);
  });

  it('a charge added on top', () => {
    expect(brief(parseAmount('compre 3 bolsas de cemento a 9500 cada una mas 4 mil de flete')!.spans)).toEqual([
      ['quantity', '3'],
      ['unit_price', '9500'],
      ['added', '4 mil'],
    ]);
  });

  it('instalments and a down payment', () => {
    expect(brief(parseAmount('me lo dieron en 3 cuotas de 20 mil más un anticipo de 50 mil')!.spans)).toEqual([
      ['quantity', '3'],
      ['unit_price', '20 mil'],
      ['added', '50 mil'],
    ]);
  });

  it('a discount', () => {
    expect(brief(parseAmount('gasté 80 mil menos el 20%')!.spans)).toEqual([
      ['amount', '80 mil'],
      ['subtracted', '20'],
    ]);
  });

  it('a sum across a comma, with the original accents and spacing', () => {
    const text = 'Pagué la luz  45 MIL, el gas 12 mil';
    const r = parseAmount(text)!;
    expect(r.value).toBe(57_000);
    expect(brief(r.spans)).toEqual([
      ['amount', '45 MIL'],
      ['amount', '12 mil'],
    ]);
    expect(r.spans[0]!.start).toBe(text.indexOf('45'));
  });

  it('a folded slang number covers every word it took', () => {
    expect(brief(parseAmount('se me fueron 30 y pico de lucas en el chino')!.spans)).toEqual([['amount', '30 y pico de lucas']]);
    expect(brief(parseAmount('cobré dos palos y medio')!.spans)).toEqual([['amount', 'dos palos y medio']]);
  });

  it('a refused sentence marks every figure it saw', () => {
    const r = parseAmount('vendí 5 tortas a 8000')!;
    expect(r.ambiguous).toBe(true);
    expect(brief(r.spans)).toEqual([
      ['figure', '5'],
      ['figure', '8000'],
    ]);
  });

  it('after a self-correction, only what follows it', () => {
    expect(brief(parseAmount('eh gaste veinte no pera treinta mil en nafta')!.spans)).toEqual([['amount', 'treinta mil']]);
  });

  it('every span of every corpus result is a slice of the input, in order, without overlap', () => {
    for (const c of corpus) {
      const r = parseAmount(c.phrase);
      if (!r) continue;
      let lastEnd = 0;
      for (const s of r.spans) {
        expect(s.text).toBe(c.phrase.slice(s.start, s.end));
        expect(s.start).toBeGreaterThanOrEqual(lastEnd);
        expect(s.end).toBeGreaterThan(s.start);
        lastEnd = s.end;
      }
      // a single figure's span is the literal it reports, up to spacing
      if (!r.ambiguous && r.source !== 'computed') {
        expect(r.spans).toHaveLength(1);
        expect(normalize(r.spans[0]!.text).replace(/\s/gu, '')).toBe(r.literal.replace(/\s/gu, ''));
      }
    }
  });
});
