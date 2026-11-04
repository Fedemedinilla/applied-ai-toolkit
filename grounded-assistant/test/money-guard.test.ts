// The money guard case by case, ported from the source's scripts, with each known gap written as
// a passing case so nobody rediscovers it.

import { describe, expect, it } from 'vitest';
import { ALLOWED_MONEY, misstatedRows, moneyIsOurs, moneyToEn, moneyVerdict, quantityMentioned, reachable, SALON_SERVICES, withoutControls } from '../src/index.ts';

const LIST = SALON_SERVICES.map((s) => `${s.name}: $${s.price.toLocaleString('es-AR')}`).join('\n');

describe('preconditions', () => {
  it('the table is what the cases assume', () => {
    for (const n of [15_000, 5_000, 24_000, 9_000, 16_000]) expect(ALLOWED_MONEY.has(n)).toBe(true);
    for (const n of [20_000, 44_000, 90_000, 32_000, 41_000, 48_000, 112_000]) expect(ALLOWED_MONEY.has(n)).toBe(false);
  });
});

describe('what passes', () => {
  const pass: Array<[string, string]> = [
    ['a single price from the table', 'El balayage sale $78.000 y lleva 180 min.'],
    ['a sum of two with the parts shown', 'Lavado y brushing: $15.000. Perfilado de cejas con navaja: $5.000. En total, $20.000.'],
    ['a sum of three, which the prompt requires', 'Corte de mujer (lavado, corte y secado): $24.000\nLavado y brushing: $15.000\nPerfilado de cejas con navaja: $5.000\nTotal: $44.000.'],
    ['no figure at all', 'Los sábados abrimos de 9 a 18.'],
    ['the 19-price list alone', LIST],
    ['the 19-price list and a total that is nobody’s row', `${LIST}\nCorte de mujer con lavado y brushing: $24.000 + $15.000 = $39.000.`],
    ['a bullet list: a hyphen before the sign is not a minus', '- Corte de hombre: $16.000\n- Perfilado de barba: $9.000'],
    ['cents that are zero', 'El corte de hombre sale $16.000,00.'],
    ['two cuts, unit price not written', 'Dos cortes de hombre salen $32.000.'],
    ['two cuts plus a beard trim', 'Corte de hombre $16.000 y barba $9.000: dos cortes y una barba, $41.000 en total.'],
    ['seven, inside the cap of twenty', 'Siete cortes de hombre: $112.000.'],
    ['English, two cuts', "Two men's cuts come to $32,000."],
    ['a total of named rows without their figures', 'Balayage con matizado: $96.000.'],
  ];
  it.each(pass)('%s', (_label, reply) => {
    const lang = /[A-Z][a-z]+ men's/.test(reply) || reply.startsWith('Two') ? 'en' : 'es';
    expect(moneyIsOurs(reply, lang)).toBe(true);
  });
});

describe('what is stopped', () => {
  const stop: Array<[string, string]> = [
    ['an invented price for a service with no row', 'El alisado japonés sale $90.000 y lleva 180 minutos.'],
    ['a sum that does not add up', 'Lavado y brushing: $15.000. Perfilado de cejas: $5.000. Total: $21.000.'],
    ['a discount nobody published', 'El corte de hombre sale $16.000, pero hoy te lo dejo en $10.000.'],
    ['a bare total with nothing shown', 'Te sale $20.000 todo junto.'],
    ['a price below a real row', 'Corte de mujer: $24.000. Con el pack de fidelidad, $19.000.'],
    ['$0, which the seed of the sums used to allow', 'Te lo dejo en $0, cortesía de la casa.'],
    ['two spaces after the sign', 'El alisado japonés sale $  99.999.'],
    ['a negative figure', 'El corte sale $16.000 y te descuento $-5.000.'],
    ['real cents are not the row', 'El corte de hombre sale $16.000,50.'],
    ['$32.000 with no quantity written', 'El corte de hombre sale $32.000.'],
    ['twenty-five is past the cap', 'Veinticinco cortes de hombre: $400.000.'],
    ['the whole list does not save a figure no sum reaches', `${LIST}\nTe hago todo por $40.500.`],
  ];
  it.each(stop)('%s', (_label, reply) => expect(moneyIsOurs(reply)).toBe(false));

  it('English: $32,000 with no quantity', () => expect(moneyIsOurs("A men's cut is $32,000.", 'en')).toBe(false));
});

describe('known gaps, pinned', () => {
  it('with the whole table shown, any total some subset reaches passes', () => {
    expect(moneyIsOurs(`${LIST}\nTe hago todo por $40.000.`)).toBe(true);
  });
  it('an amount without the $ sign is not read', () => {
    expect(moneyIsOurs('Te sale 25 mil todo junto.')).toBe(true);
  });
  it('a discount that lands on another real row, outside a price phrase, passes moneyIsOurs', () => {
    expect(moneyIsOurs('El corte de hombre sale $16.000, pero hoy te lo dejo en $12.000.')).toBe(true);
  });
});

describe('quantityMentioned', () => {
  const cases: Array<[string, number, 'es' | 'en']> = [
    ['Dos cortes de hombre salen $32.000.', 2, 'es'],
    ['Tres brushings y un corte.', 3, 'es'],
    ['Son 2 x $16.000.', 2, 'es'],
    ['El corte sale $32.000 y abrimos 12:30.', 1, 'es'],
    ["Two men's cuts come to $32,000.", 2, 'en'],
    ['Veinticinco cortes.', 1, 'es'],
    ['Media docena de peinados.', 6, 'es'],
    ['Te espero a las dos.', 1, 'es'],
    ['El sábado 10 tenés lugar.', 1, 'es'],
    ['Son dos horas.', 1, 'es'],
    ['el doce de octubre', 1, 'es'],
    ['Come once a month.', 1, 'en'],
    ['Por los 11, sumando, da $121.000.', 11, 'es'],
    ['$16.000 x2', 2, 'es'],
  ];
  it.each(cases)('%s is %i', (text, n, lang) => expect(quantityMentioned(text, lang)).toBe(n));
});

describe('misstated rows and the verdict', () => {
  it('a real price on the wrong service, in a price phrase', () => {
    expect(misstatedRows('El balayage te lo dejo en $65.000.').map((s) => s.id)).toEqual(['balayage']);
    expect(misstatedRows('$65.000 el balayage.').map((s) => s.id)).toEqual(['balayage']);
  });

  it('a correction is not a contradiction', () => {
    expect(misstatedRows('El balayage no sale $65.000: sale $78.000.')).toEqual([]);
  });

  it('a wrong price on the card’s own service keeps the card and says it in words', () => {
    const card = { service: "Boy's cut (up to age twelve)" };
    expect(moneyVerdict("Boy's cut (up to age twelve) is $16,000 and takes 30 minutes.", card, 'en')).toBe('card');
    expect(moneyVerdict("Boy's cut (up to age twelve) is $12,000 and takes 30 minutes.", card, 'en')).toBe('ok');
  });

  it('a wrong price on another service withdraws the card', () => {
    expect(moneyVerdict('Balayage: $78.000. El matizado sale $15.000.', { service: 'Balayage' })).toBe('apology');
  });
});

describe('reachable', () => {
  it('prunes above the cap and stays small with every row', () => {
    const all = SALON_SERVICES.map((s) => s.price);
    expect(reachable([16_000, 9_000], 25_000)).toEqual(new Set([0, 9_000, 16_000, 25_000]));
    expect(reachable(all, 1_000_000).size).toBeLessThanOrEqual(531);
  });
});

describe('English output and control characters', () => {
  it('es-AR figures and k figures become English ones, keeping sentence punctuation', () => {
    expect(moneyToEn('It is $16.000. Or $25k, or $16,000.')).toBe('It is $16,000. Or $25,000, or $16,000.');
  });

  it('a tab in a staff name is mended, and other controls become spaces', () => {
    expect(withoutControls('With Rub\ten or Dami\tan.')).toBe('With Rubén or Damián.');
    expect(withoutControls('a figure for that \ny check')).toBe('a figure for that y check');
  });
});
