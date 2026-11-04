// The money guard against 55 replies written to break it, 30 in Spanish and 25 in English. Two
// agents wrote them in the source project after reading the guard's code, looking for true replies
// it would kill and invented figures it would let through. Each is labelled with what the visitor
// should get, from the salon's facts, not from what the code does. It is judged with
// moneyVerdict(), the function the handler uses.
//
// The guard still gets some wrong. Those are listed below by kind as known misses: each one is
// asserted to still be wrong, so a change that fixes one fails here until it moves out of the
// list, and a change that breaks a case that passes fails too.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { moneyVerdict, type Lang } from '../src/index.ts';

interface Case {
  readonly id: string;
  readonly lang: Lang;
  readonly reply: string;
  readonly card: { readonly service: string; readonly price: number } | null;
  readonly want: 'ok' | 'stop';
  readonly why: string;
}

const cases = JSON.parse(readFileSync(new URL('./corpus/money-guard.json', import.meta.url), 'utf8')) as Case[];

const KNOWN_MISSES: Readonly<Record<string, readonly string[]>> = {
  // True replies that die: the quantity is in the people, not in a number ("por persona",
  // "vos y tus dos amigos", "las mellizas", "twice a month").
  'quantity without a number': [
    'fp-por-persona-tres',
    'fp-tus-dos-amigos',
    'fp-mellizas',
    'fp-vos-y-tu-viejo-combo',
    'card-fp-por-cabeza',
    'en-card-per-person-brother',
    'en-apiece-three-people-named',
    'en-twice-a-month',
  ],
  // Wrong totals that pass: the guard checks that a total can be built from the rows shown, not
  // that it counts each of them the right number of times.
  'reachable but miscounted total': [
    'fn-total-omite-uno',
    'fn-siete-total-de-seis',
    'fn-papa-e-hijo-por-dos',
    'en-bridesmaids-undercount',
    'en-list-total-drops-an-item',
    'en-thirteen-year-old-mixed-total',
  ],
  // A wrong price for a service, but not in a price phrase ("<service> is $N", "$N for the
  // <service>"), so it is not judged ("con Carla: $96.000", "It's $65,000").
  'price outside a price phrase': [
    'card-fn-hs-corta-oracion',
    'card-fn-balayage-96',
    'card-fn-combo-oracion-siguiente',
    'en-card-wrong-price-next-sentence',
    'en-card-each-after-two-names',
  ],
};
const known = new Map(Object.entries(KNOWN_MISSES).flatMap(([kind, ids]) => ids.map((id) => [id, kind] as const)));
const right = (c: Case) => (moneyVerdict(c.reply, c.card, c.lang) === 'ok') === (c.want === 'ok');

describe('the money guard corpus', () => {
  it('has the 55 written cases, half of each language roughly, and every known miss is in it', () => {
    expect(cases).toHaveLength(55);
    expect(cases.filter((c) => c.lang === 'es')).toHaveLength(30);
    expect(new Set(cases.map((c) => c.id)).size).toBe(55);
    for (const id of known.keys()) expect(cases.some((c) => c.id === id), id).toBe(true);
  });

  it('uses only fictional hosts', () => {
    const hosts = cases.flatMap((c) => `${c.reply} ${c.why}`.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi) ?? []).filter((h) => /[a-z]/i.test(h.split('.').pop() ?? ''));
    for (const h of hosts) expect(h.endsWith('.example') || !/\.(com|ar|net|org|io)$/i.test(h), h).toBe(true);
  });

  for (const c of cases.filter((x) => !known.has(x.id))) {
    it(`${c.id} [${c.lang}] wants ${c.want}`, () => {
      expect(moneyVerdict(c.reply, c.card, c.lang) === 'ok' ? 'ok' : 'stop', c.why).toBe(c.want);
    });
  }

  for (const c of cases.filter((x) => known.has(x.id))) {
    it(`known miss (${known.get(c.id)}): ${c.id} still gets the wrong verdict`, () => {
      expect(right(c), `${c.id} is now right: move it out of KNOWN_MISSES`).toBe(false);
    });
  }

  it('the score', () => {
    const passing = cases.filter(right).length;
    expect({ passing, known: known.size }).toEqual({ passing: 55 - 19, known: 19 });
  });
});
