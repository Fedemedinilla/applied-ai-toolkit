// Hand-written cases kept from the source project, outside the corpus.
//
// HAND_CASES: the 39 cases of the parser's own test table, identical in both source versions. Each
// regression group names the audit that found it; every one of those silently returned a wrong
// number before it was fixed. Each row expects one of the three answers: a number, 'ask'
// (ambiguous, with a reason) or 'none' (no amount in the sentence).
//
// RED_TEAM: fourteen phrases a red-team session used to break an earlier copy of the parser, with
// what that copy returned. The rule they enforce: a correct number or a question, never a confident
// wrong number.

import { describe, expect, it } from 'vitest';
import { parseAmount } from '../src/index.ts';

type Expected = number | 'ask' | 'none';

const HAND_CASES: Array<[string, Expected]> = [
  // Ordinary
  ['gasté 20 mil en la verdulería', 20_000],
  ['20k de nafta', 20_000],
  ['pagué $3.500 de luz', 3_500],
  ['1.234,56 de comisión', 1_234.56],
  ['20,50', 20.5],
  ['4500 pesos de fiambre', 4_500],
  ['gasté 20 en la verdulería', 20],

  // Slang
  ['dos lucas de café', 2_000],
  ['2 palos de alquiler', 2_000_000],
  ['una gamba de propina', 100],
  ['veinte mil de harina', 20_000],
  ['dos mil quinientos de fletes', 2_500],
  ['un millón doscientos mil', 1_200_000],

  // Money coming in reads the same way: the parser does not care about direction
  ['cobré 90 mil de un trabajo', 90_000],
  ['entraron $145.500 de la caja', 145_500],

  // Counted goods with a per-unit marker: the code does the multiplication
  ['vendí 5 tortas a 8000 cada una', 40_000],
  ['compré 3 docenas de facturas a 12 mil la docena', 36_000],
  ['pagué 5 mil de luz y 3 mil de gas', 8_000],

  // Sentences a native speaker cannot resolve either
  ['vendí 5 tortas a 8000', 'ask'],
  ['3 kg de harina a 4500 pesos', 'ask'],
  ['entre 20 y 25 mil de flete', 'ask'],

  // First audit
  ['vendi 2 mil empanadas a 1200 cada una', 2_400_000], // the count carried a scale word
  ['pague la tele 300 mil en 3 cuotas', 300_000], // names the total, not the instalment
  ['pague 100 mil menos 20 mil de descuento', 80_000], // a discount in pesos, not percent
  ['pague 50 mil por la mercaderia con 10 por ciento de descuento', 'ask'], // an earlier "por" hid it

  // Second audit
  ['compre 2,5 kilos de carne a 12 mil el kilo', 30_000], // a count may be fractional
  ['compre 2 kilos y medio de carne a 12 mil el kilo', 30_000], // the half sits after the noun
  ['cargue 25,5 litros de nafta a 1200 el litro', 30_600],
  ['pague la mitad de la deuda, 80 mil', 80_000], // "mitad de" something else
  ['me pagaron mil millones', 1_000_000_000], // a bigger scale multiplies
  ['vendi 10001 facturas a 300 cada una', 3_000_300], // a count over ten thousand

  // Money in the sentence that never moved: what the customer handed over, what is still owed,
  // what is left in the till
  ['vendi 12 empanadas a 1500 c/u y me pagaron con 20 mil', 18_000],
  ['gaste 30 mil en harina y todavia debo 50 mil', 30_000],
  ['pague 15 mil de nafta y me quedan 2 mil en la caja', 15_000],

  // Numbers that are not money
  ['el 15 gasté 20 mil', 20_000],
  ['12 docenas de huevos por 48 mil', 48_000],

  // Controls: if any of these returns a number, the parser is inventing money
  ['pagué la luz', 'none'],
  ['', 'none'],
  ['no me acuerdo cuánto', 'none'],
];

interface RedTeamCase {
  phrase: string;
  /** What the earlier copy returned. */
  before: string;
  expected: Exclude<Expected, 'none'>;
}

const RED_TEAM: RedTeamCase[] = [
  // "y pico" and "un par": the scale word was left on its own and returned the scale alone.
  { phrase: 'se me fueron 30 y pico de lucas en el chino', before: 'returned 1000', expected: 30_000 },
  { phrase: 'me salió 40 y pico de lucas el service', before: 'returned 1000', expected: 40_000 },
  { phrase: 'el arreglo me salió un par de lucas', before: 'returned 1000', expected: 2_000 },

  // Two amounts in one sentence: the second was dropped.
  { phrase: 'pagué la luz 45 mil, el gas 12 mil', before: 'dropped the 12 mil', expected: 57_000 },

  // Foreign currency: stored as pesos, an error of about a thousand times.
  { phrase: 'vendí la camioneta en 20 mil dólares', before: 'stored as pesos', expected: 'ask' },
  { phrase: 'pagué 15 mil dólares de la máquina nueva', before: 'stored as pesos', expected: 'ask' },

  // Instalments: the value of ONE instalment came back as the total.
  { phrase: 'compré el horno en 18 cuotas fijas de 40 mil', before: 'returned 40000', expected: 720_000 },
  { phrase: 'el proveedor me lo financia en 4 pagos de 90 mil', before: 'returned 90000', expected: 360_000 },
  { phrase: 'me lo dieron en 3 cuotas de 20 mil más un anticipo de 50 mil', before: 'lost the down payment', expected: 110_000 },

  // Tax: returned without asking a number that depended on a decision.
  { phrase: 'el proveedor me cobró 200 mil más el 21 de IVA', before: 'returned 200000 without asking', expected: 'ask' },

  // Discount: dropped.
  { phrase: 'gasté 80 mil menos el 20%', before: 'dropped the discount', expected: 64_000 },

  // Range: picked the low end without a flag.
  { phrase: 'el gasista me pidió de 80 mil a 100 mil', before: 'picked the low end', expected: 'ask' },

  // Context figure: stored the reference figure instead of the movement.
  { phrase: 'de los 80 mil me devolvieron 20 mil', before: 'stored the context figure', expected: 20_000 },

  // Unit or total, the genuine ambiguity.
  { phrase: 'me devolvieron 3 remeras de 12 mil', before: 'returned 12000 without asking', expected: 'ask' },
];

describe('hand cases', () => {
  it.each(HAND_CASES)('%j -> %s', (phrase, expected) => {
    const r = parseAmount(phrase);
    if (expected === 'ask') {
      expect(r?.ambiguous).toBe(true);
      expect(r?.reason).toBeTypeOf('string');
    } else if (expected === 'none') {
      expect(r === null || r.value === null).toBe(true);
      expect(r?.ambiguous ?? false).toBe(false);
    } else {
      expect(r?.ambiguous).toBe(false);
      expect(r?.value).toBe(expected);
    }
  });
});

describe('red-team phrases', () => {
  it.each(RED_TEAM)('$phrase -> $expected (earlier: $before)', ({ phrase, expected }) => {
    const r = parseAmount(phrase);
    if (expected === 'ask') {
      expect(r?.ambiguous).toBe(true);
    } else {
      expect(r?.ambiguous).toBe(false);
      expect(r?.value).toBe(expected);
    }
  });
});
