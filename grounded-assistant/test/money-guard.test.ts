// The money guard case by case, ported from the source's scripts, with each known gap written as
// a passing case so nobody rediscovers it.

import { describe, expect, it } from 'vitest';
import { ALLOWED_MONEY, cardInWords, misstatedRows, moneyIsOurs, moneyToEn, moneyVerdict, plainText, quantityMentioned, reachable, SALON_SERVICES, withoutControls } from '../src/index.ts';

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

describe('decomposed accents (NFD)', () => {
  const nfd = (t: string) => t.normalize('NFD');
  it('a service name with a decomposed accent is still named', () => {
    expect(misstatedRows(nfd('El color de raíz sale $52.000.')).map((r) => r.id)).toEqual(['color-raiz']);
  });
  it('the verdict is the same as on composed text', () => {
    const reply = 'Listo, el color de raíz sale $52.000. Te lo paso al local.';
    expect(moneyVerdict(nfd(reply), { service: 'Color de raíz, un solo tono' })).toBe(moneyVerdict(reply, { service: 'Color de raíz, un solo tono' }));
    expect(moneyVerdict(nfd(reply), { service: 'Color de raíz, un solo tono' })).toBe('card');
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

// Cases added after the mutation run of 2026-11-14 (see "Mutation testing" in the README): each one
// fails against a mutant that the tests above let through. Before them, no test read an English
// figure with decimals or with "k" through the guard.
describe('reading a figure, Spanish path', () => {
  it('zero cents followed by an ellipsis is still the row', () => expect(moneyIsOurs('El corte de hombre sale $16.000,00...')).toBe(true));
  it('a comma as the thousands separator is the same number', () => expect(moneyIsOurs('El corte de hombre sale $16,000.')).toBe(true));
  it('cents are hundredths: $15.000,10 is not $16.000', () => expect(moneyIsOurs('El corte de hombre sale $15.000,10.')).toBe(false));
  it('"k" is not read in Spanish: $25k is $25', () => expect(moneyIsOurs('Papá e hijo sale $25k.')).toBe(false));
  it('a minus after the sign and a space is still a negative figure', () => expect(moneyIsOurs('El corte sale $16.000 y te descuento $- 5.000.')).toBe(false));
  it('a sign with punctuation and no digits is not a figure', () => expect(moneyIsOurs('Se paga en $, no en dólares.')).toBe(true));
});

describe('invisible characters and Unicode minus signs after the sign', () => {
  // A reader sees "$99.999"; a guard that reads nothing between "$" and the digits sees no figure.
  const cases: Array<[string, string]> = [
    ['a zero-width space', 'El corte de hombre sale $\u200B99.999.'],
    ['a word joiner', 'El corte de hombre sale $\u206099.999.'],
    ['a soft hyphen', 'El corte de hombre sale $\u00AD99.999.'],
  ];
  it.each(cases)('%s does not hide an invented figure', (_label, reply) => expect(moneyIsOurs(reply)).toBe(false));
  it.each(cases)('%s does not hide an invented figure in English', (_label, reply) => expect(moneyIsOurs(reply.replace('99.999', '99,999'), 'en')).toBe(false));
  it('a real price behind a zero-width space is still the row', () => expect(moneyIsOurs('El corte de hombre sale $\u200B16.000.')).toBe(true));
  it('U+2212 after the sign is a negative figure', () => expect(moneyIsOurs('El corte sale $16.000 y te descuento $\u22125.000.')).toBe(false));
  it('an en dash after the sign is a negative figure', () => expect(moneyIsOurs("A men's cut is $16,000, and I take off $\u2013 5,000.", 'en')).toBe(false));
});

describe('reading a figure, English path', () => {
  const ours = (reply: string) => moneyIsOurs(reply, 'en');
  it('zero cents before a comma is still the row', () => expect(ours("A men's cut is $16,000.00, and takes 30 minutes.")).toBe(true));
  it('zero cents before an ellipsis is still the row', () => expect(ours("A men's cut is $16,000.00...")).toBe(true));
  it('real cents are not the row', () => expect(ours("A men's cut is $16,000.50.")).toBe(false));
  it('cents are hundredths: $15,000.10 is not $16,000', () => expect(ours("A men's cut is $15,000.10.")).toBe(false));
  it('"k" is thousands', () => expect(ours('Father and son is $25k.')).toBe(true));
  it('"k" after a space is thousands too', () => expect(ours('Father and son is $25 k.')).toBe(true));
  it('a minus right after the sign is a negative figure', () => expect(ours("A men's cut is $16,000, and I take off $-5,000.")).toBe(false));
  it('a minus after the sign and a space is a negative figure', () => expect(ours("A men's cut is $16,000, and I take off $- 5,000.")).toBe(false));
});

describe('reachable, pruning', () => {
  it('a sum above the cap is not kept', () => {
    expect(reachable([16_000, 9_000], 20_000)).toEqual(new Set([0, 9_000, 16_000]));
  });
});

describe('cardInWords', () => {
  const card = { service: 'Balayage', price: 78_000, minutes: 180, stylist: 'Carla', candidates: null, date: '2026-11-07', dayLabel: 'sábado, 7 de noviembre', time: '09:30' };

  it('Spanish: the row, its price, the day, the time and the person', () => {
    expect(cardInWords(card, 'es')).toBe('Balayage: $78.000. Te lo paso como pedido para el sábado, 7 de noviembre a las 09:30 con Carla, y del local te confirman el horario.');
    expect(cardInWords({ ...card, time: null, stylist: null }, 'es')).toBe('Balayage: $78.000. Te lo paso como pedido para el sábado, 7 de noviembre, y del local te confirman el horario.');
  });

  it('English: the same card, with a 12-hour time', () => {
    const en = { ...card, dayLabel: 'Saturday, November 7' };
    expect(cardInWords(en, 'en')).toBe("Balayage is $78,000. I'm sending it to the salon as a request for Saturday, November 7 at 9:30 am with Carla, and someone there confirms the time.");
    expect(cardInWords({ ...en, time: null, stylist: null }, 'en')).toBe("Balayage is $78,000. I'm sending it to the salon as a request for Saturday, November 7, and someone there confirms the time.");
  });
});

describe('moneyToEn, the edges of a figure', () => {
  it('a figure with nothing after it keeps what follows', () => expect(moneyToEn('$16.000 for a cut')).toBe('$16,000 for a cut'));
  it('an ellipsis after a figure is kept whole', () => expect(moneyToEn('It is $16.000...')).toBe('It is $16,000...'));
  it('a sign with no digits is left alone', () => expect(moneyToEn('We take $, not cards.')).toBe('We take $, not cards.'));
});

describe('withoutControls and plainText', () => {
  it('a reply with no control character is returned untouched, double spaces included', () => {
    expect(withoutControls('two  spaces stay')).toBe('two  spaces stay');
  });

  it('a control outside a name becomes one space, also next to other spaces', () => {
    expect(withoutControls('one\ttwo')).toBe('one two');
    expect(withoutControls('one \t two')).toBe('one two');
  });

  it('a run of controls inside a name is mended, every time the name appears', () => {
    expect(withoutControls('Rub\t\ten')).toBe('Rubén');
    expect(withoutControls('Rub\ten on Tuesday, Rub\ten on Friday')).toBe('Rubén on Tuesday, Rubén on Friday');
  });

  it('plainText keeps the label of a link and drops schemes and www', () => {
    expect(plainText('See [the site](https://www.salon.example/a), http://www.salon.example or HTTPS://salon.example')).toBe('See the site, salon.example or salon.example');
  });
});
