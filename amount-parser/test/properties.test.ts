// Properties checked with fast-check over generated inputs, on top of the fixed corpus.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalize, parseAmount } from '../src/index.ts';
import { corpus } from './corpus-data.ts';

const argentine = new Intl.NumberFormat('es-AR', { useGrouping: true });
const argentineCents = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const UNITS = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce',
  'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno',
  'veintidos', 'veintitres', 'veinticuatro', 'veinticinco', 'veintiseis', 'veintisiete', 'veintiocho', 'veintinueve'];
const TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const HUNDREDS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos',
  'setecientos', 'ochocientos', 'novecientos'];

/** 1..999 in words. `beforeMil` turns a final "uno" into "un", as in "veintiun mil". */
function spellBelowThousand(n: number, beforeMil = false): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(n === 100 ? 'cien' : HUNDREDS[h]!);
  if (rest > 0 && rest < 30) {
    parts.push(UNITS[rest]!);
  } else if (rest >= 30) {
    const u = rest % 10;
    const tens = TENS[Math.floor(rest / 10)]!;
    parts.push(u ? `${tens} y ${UNITS[u]}` : tens);
  }
  const words = parts.join(' ');
  return beforeMil ? words.replace(/uno$/u, 'un') : words;
}

/** 1..999.999 in Rioplatense words: "doscientos treinta y un mil cuatrocientos". */
function spell(n: number): string {
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const head = thousands === 0 ? '' : thousands === 1 ? 'mil' : `${spellBelowThousand(thousands, true)} mil`;
  return [head, rest ? spellBelowThousand(rest) : ''].filter(Boolean).join(' ');
}

function withoutSpans(r: ReturnType<typeof parseAmount>) {
  if (r === null) return null;
  const { spans: _spans, ...rest } = r;
  return rest;
}

describe('numbers written the Argentine way', () => {
  it('a formatted integer parses back to the integer', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), (n) => {
        expect(parseAmount(`pague $${argentine.format(n)} de luz`)?.value).toBe(n);
      }),
      { numRuns: 2000 },
    );
  });

  it('a formatted amount with cents parses back to the amount', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000_000 }), (cents) => {
        const value = cents / 100;
        expect(parseAmount(`pague ${argentineCents.format(value)} de luz`)?.value).toBe(value);
      }),
      { numRuns: 2000 },
    );
  });

  it('"mil" multiplies by a thousand', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999 }), (n) => {
        expect(parseAmount(`gaste ${n} mil en el mayorista`)?.value).toBe(n * 1000);
      }),
    );
  });

  it('an integer spelled out in words parses back to the integer', () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 999_999 }), (n) => {
        const phrase = `pague ${spell(n)} de luz`;
        expect(parseAmount(phrase)?.value, phrase).toBe(n);
      }),
      { numRuns: 3000 },
    );
  });
});

describe('approximations', () => {
  it('"y pico" never returns an exact value', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5000 }), fc.constantFrom('lucas', 'mil', 'palos'), (n, scale) => {
        const r = parseAmount(`me salio ${n} ${scale} y pico`);
        expect(r).not.toBeNull();
        // a floor with the flag, or a question when the unknown part is too large
        expect(r!.approximate || (r!.ambiguous && r!.reason === 'open_remainder')).toBe(true);
      }),
    );
  });
});

describe('arbitrary input', () => {
  it('never throws, and a value is always finite', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 80 }), (text) => {
        const r = parseAmount(text);
        if (r && r.value !== null) expect(Number.isFinite(r.value)).toBe(true);
      }),
      { numRuns: 3000 },
    );
  });

  it('upper case and extra spaces do not change the result', () => {
    const shout = (p: string) => `  ${p.toUpperCase().split(' ').join('   ')}  `;
    for (const c of corpus) {
      expect(withoutSpans(parseAmount(shout(c.phrase))), c.phrase).toStrictEqual(withoutSpans(parseAmount(c.phrase)));
    }
  });

  it('normalize is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (s) => {
        expect(normalize(normalize(s))).toBe(normalize(s));
      }),
    );
  });
});
