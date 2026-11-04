/**
 * Guards on the prose. Every "$N" in a reply has to be a published price, or a sum the reply
 * itself can be checked against: the rows it shows, each as many times as it writes or names it
 * or as the quantity it writes. And a figure stated as the price of a named service has to be
 * that service's price.
 *
 * The prompt requires a total from three services on, so a guard that only knew single rows
 * punished the prompt's own instruction: in the source, five of six two-service totals were
 * replaced by the apology. A bare total with no itemisation still dies on purpose, because the
 * sum is trusted only when the parts are on screen next to it.
 */
import { pesosEn, pesosEs, time12, type Lang } from './lang.ts';
import type { Card } from './decide.ts';
import { ALLOWED_MONEY, foldKeepingLength, SALON_SERVICES, SALON_STAFF, serviceName, servicesNamedIn, type Mention, type Service } from './salon.ts';

/**
 * es-AR: the dot groups thousands and a final comma with one or two digits opens the decimals.
 * "$16.000,00" is sixteen thousand; the source's first reader dropped the separators and read it
 * as 1,600,000, which killed a true reply. The sentence's own full stop is trimmed first.
 */
function toAmount(raw: string): number {
  let s = raw.replace(/[^\d.,]/g, '').replace(/[.,]+$/, '');
  const dec = /,(\d{1,2})$/.exec(s);
  if (dec) s = s.slice(0, -dec[0].length);
  const whole = Number(s.replace(/[.,]/g, '') || '0');
  return dec ? whole + Number((dec[1] ?? '').padEnd(2, '0')) / 100 : whole;
}

/** English: either separator with one or two digits at the end is decimals; "$16k" is 16,000. */
function toAmountEn(raw: string): number {
  const thousands = /k$/i.test(raw.trim());
  let s = raw.replace(/[^\d.,]/g, '').replace(/[.,]+$/, '');
  const dec = /[.,](\d{1,2})$/.exec(s);
  if (dec) s = s.slice(0, -dec[0].length);
  const whole = Number(s.replace(/[.,]/g, '') || '0');
  const n = dec ? whole + Number((dec[1] ?? '').padEnd(2, '0')) / 100 : whole;
  return thousands ? Math.round(n * 1000) : n;
}

/**
 * `\s*` and not `\s?`: with one optional space, "$  99.999" matched nothing, no match meant no
 * figures, and an invented price with two spaces after the sign went straight through. The minus
 * is read only between the sign and the digits; "- $16.000" is a bullet, not a negative.
 */
const MONEY = /\$\s*(?:-\s*)?[\d.,]+/g;
const MONEY_EN = /\$\s*(?:-\s*)?[\d.,]+(?:\s*k\b)?/gi;

/* Quantities the reply writes: "dos cortes", "three blow-dries", "2 x". Capped at twenty. What is
   not a quantity: an hour ("a las once"), a date ("sábado 10", "el doce de octubre"), a duration
   ("dos horas"). "once" is eleven only on the Spanish path. */
const QUANTITIES: Readonly<Record<string, number>> = {
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, docena: 12, ambos: 2, ambas: 2,
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, dozen: 12, both: 2, twice: 2,
};
export const MAX_QUANTITY = 20;
const NOT_BEFORE = new Set(['las', 'la', 'el', 'at', 'on', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'dia', 'day', 'enero', 'febrero', 'marzo', 'abril',
  'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre', 'january', 'february', 'march',
  'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
const TIME_UNIT = /^(horas?|hs|hrs?|minutos?|mins?|hours?|minutes?|am|pm|anos?|years?|meses|months?|dias|days|semanas|weeks)$/;
const MONTH = /^(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)$/;
const NOT_A_NOUN = new Set(['this', 'plus', 'tenes', 'antes', 'despues', 'ademas', 'menos', 'apenas', 'pues', 'does', 'goes', 'takes', 'lleva', 'llevas']);
const HOUR_AFTER_ARTICLE = /^(a|de|desde|hasta|entre|y)$/;

/** The largest quantity the reply writes, from 1 (none) to MAX_QUANTITY. */
export function quantityMentioned(reply: string, lang: Lang = 'es'): number {
  const folded = foldKeepingLength(reply);
  const words = folded.match(/\p{L}+(?:'s)?|\d+/gu) ?? [];
  let max = 1;
  for (const [i, w] of words.entries()) {
    let n = /^\d+$/.test(w) ? 0 : (QUANTITIES[w] ?? 0);
    if (!n || (w === 'once' && lang === 'en')) continue;
    if ((w === 'docena' && words[i - 1] === 'media') || (w === 'dozen' && words[i - 1] === 'a' && words[i - 2] === 'half')) n = 6;
    // "a las dos" is an hour; "las dos" on its own is both of them.
    const prev = words[i - 1] ?? '';
    if (prev === 'las' || prev === 'la' ? HOUR_AFTER_ARTICLE.test(words[i - 2] ?? '') : NOT_BEFORE.has(prev)) continue;
    if (words.slice(i + 1, i + 5).some((x) => TIME_UNIT.test(x))) continue;
    if (words[i + 1] === 'de' && MONTH.test(words[i + 2] ?? '')) continue;
    if (n > max) max = n;
  }
  // A digit: never inside a figure, an hour or a date, and only before "x", "people" or a plural
  // noun, or after "los", "las", "the", "por" or "for".
  for (const m of folded.matchAll(/(?<![\d$.,:/])(1\d|20|[2-9])(?![\d:/]|[.,]\d)/g)) {
    const [, before2 = '', before = ''] = /(?:(\p{L}+)\s+)?(\p{L}+)\s*$/u.exec(folded.slice(0, m.index)) ?? [];
    const after = /^\s*(\p{L}+(?:'s)?)/u.exec(folded.slice(m.index + m[0].length))?.[1] ?? '';
    const hour = before === 'las' || before === 'la' ? HOUR_AFTER_ARTICLE.test(before2) : NOT_BEFORE.has(before);
    if (hour || TIME_UNIT.test(after) || NOT_A_NOUN.has(after)) continue;
    if (!/^(los|las|the|por|for)$/.test(before) && !/^(x|people|personas)$|'s$|^\p{L}{3,}s$/u.test(after)) continue;
    max = Math.max(max, Number(m[1]));
  }
  for (const m of folded.matchAll(/[x×]\s?(1\d|20|[2-9])(?!\d)/g)) max = Math.max(max, Number(m[1]));
  return Math.min(max, MAX_QUANTITY);
}

interface Figure {
  readonly at: number;
  readonly raw: string;
  readonly n: number;
}

function figuresIn(reply: string, lang: Lang): Figure[] {
  return [...reply.matchAll(lang === 'en' ? MONEY_EN : MONEY)]
    .filter((m) => /\d/.test(m[0]))
    // Without the punctuation the pattern swallows after the number: in "A $24,000, B $38,000" the
    // swallowed comma made B read as a price stated before its name.
    .map((m) => ({ at: m.index, raw: m[0].replace(/[.,]+$/, ''), n: (lang === 'en' ? toAmountEn : toAmount)(m[0]) }));
}

/** The rows a reply shows, as uses: each price as many times as it is written, named or multiplied. */
function shownRows(reply: string, found: readonly number[], lang: Lang): number[] {
  const written = new Map<number, number>();
  for (const n of found) if (ALLOWED_MONEY.has(n)) written.set(n, (written.get(n) ?? 0) + 1);
  const named = new Map<number, number>();
  for (const service of new Set(servicesNamedIn(reply).map((m) => m.service))) named.set(service.price, (named.get(service.price) ?? 0) + 1);
  const qty = quantityMentioned(reply, lang);
  const uses: number[] = [];
  for (const p of new Set([...written.keys(), ...named.keys()])) {
    const k = Math.max(written.get(p) ?? 0, named.get(p) ?? 0, qty);
    for (let i = 0; i < k; i++) uses.push(p);
  }
  return uses;
}

/**
 * Reachable sums by dynamic programming, not by enumerating subsets. The source first gave up
 * past 8 rows and fell back to "each figure is a row", which killed the full price list with a
 * total. Sums above the largest figure in the reply are pruned, and every price is a multiple of
 * 1,000 over a table that adds up to 530,000, so the set never holds more than 531 sums.
 */
export function reachable(uses: readonly number[], cap: number): Set<number> {
  const sums = new Set<number>([0]);
  for (const r of uses) {
    for (const s of Array.from(sums)) if (s + r <= cap) sums.add(s + r);
  }
  return sums;
}

export function moneyIsOurs(reply: string, lang: Lang = 'es'): boolean {
  const figures = figuresIn(reply, lang);
  if (!figures.length) return true;
  // No published price is negative, and this salon publishes no discounts.
  if (figures.some((f) => f.raw.includes('-'))) return false;
  const found = figures.map((f) => f.n);
  const sums = reachable(shownRows(reply, found, lang), Math.max(...found));
  // n > 0: the set is seeded at 0, and "te lo dejo en $0" must not be ours.
  return found.every((n) => ALLOWED_MONEY.has(n) || (n > 0 && sums.has(n)));
}

/* A STRONG word says the figure is the price of that one service ("Balayage: $78.000", "$65.000 el
   balayage"); a WEAK one may introduce a total ("los dos son $28.000"). */
const STRONG_AFTER = /^\s*(?:\([^)]*\))?[\s,(]*(?::|sale|cuesta|vale|es|esta|es de|a|por|te lo dejo en|te la dejo en|lo dejo en|la dejo en|seria|is|costs?|runs|at|for|would be|'s)?[\s:]*$/;
const WEAK_AFTER = /^\s*(?:\([^)]*\))?[\s,(]*(?:son|salen|cuestan|valen|queda en|quedan en|queda|da|dan|suma|suman|en total|total|todo junto|are|come to|comes to|add up to|adds up to|in total|would come to)[\s:]*$/;
const STRONG_BEFORE = /^\s*(?:el|la|los|las|del|de la|por el|por la|cada|for|for the|for a|for his|for her|for your|for my|per)?\s*$/;
const JOINER = /^\s*(?:,|y|e|con|mas|\+|and|with|plus|&)\s*(?:el|la|los|las|un|una|the|a|an)?\s*$/;

/**
 * The rows whose price the reply states wrong: "<row> is $N" or "$N for <row>" where $N is not that
 * row's price (or a multiple by a written quantity; after a weak word, also a total that starts
 * from it). In the source's red team the model wrote "Boy's cut (up to age 12) is $16,000" over a
 * $12,000 card; $16,000 is a real row, so moneyIsOurs passed it. Only these two shapes are judged:
 * judging any figure after a name read corrections and alternatives as contradictions.
 */
export function misstatedRows(reply: string, lang: Lang = 'es'): Service[] {
  const figures = figuresIn(reply, lang);
  if (!figures.length) return [];
  const folded = foldKeepingLength(reply);
  const mentions = servicesNamedIn(reply);
  const found = figures.map((f) => f.n);
  const qty = quantityMentioned(reply, lang);
  const joined = (a: Mention, b: Mention) => JOINER.test(folded.slice(a.end, b.start));
  const out: Service[] = [];
  for (const [i, m] of mentions.entries()) {
    const p = m.service.price;
    const multiple = (n: number) => n === p || (n % p === 0 && n / p >= 2 && n / p <= qty);
    const total = (n: number) => {
      const uses = shownRows(reply, found, lang);
      const own = uses.indexOf(p);
      if (own >= 0) uses.splice(own, 1);
      return multiple(n) || (n > p && reachable(uses, n).has(n - p));
    };
    const before = mentions[i - 1];
    const after = mentions[i + 1];
    const inGroup = (before !== undefined && joined(before, m)) || (after !== undefined && joined(m, after));
    const next = figures.find((f) => f.at >= m.end);
    const prev = [...figures].reverse().find((f) => f.at + f.raw.length <= m.start);
    let wrong = false;
    if (next && !mentions.some((o) => o.start >= m.end && o.start < next.at)) {
      const between = folded.slice(m.end, next.at);
      if (STRONG_AFTER.test(between)) wrong = inGroup ? !total(next.n) : !multiple(next.n);
      else if (WEAK_AFTER.test(between)) wrong = !total(next.n);
    }
    if (!wrong && prev && !mentions.some((o) => o.start >= prev.at && o.end <= m.start)) {
      const between = folded.slice(prev.at + prev.raw.length, m.start);
      if (!between.includes('\n') && STRONG_BEFORE.test(between)) wrong = inGroup ? !total(prev.n) : !multiple(prev.n);
    }
    if (wrong && !out.includes(m.service)) out.push(m.service);
  }
  return out;
}

/**
 * What the handler does with the money in a reply. 'apology' replaces the reply and withdraws any
 * card; 'card' keeps the card and says it in words (the prose put a wrong price on the card's own
 * service); 'ok' lets the reply through.
 */
export function moneyVerdict(reply: string, card: Pick<Card, 'service'> | null, lang: Lang = 'es'): 'ok' | 'apology' | 'card' {
  const misstated = misstatedRows(reply, lang);
  const cardRow = card ? SALON_SERVICES.find((x) => serviceName(x, lang) === card.service) : undefined;
  if (!moneyIsOurs(reply, lang) || misstated.some((r) => r !== cardRow)) return 'apology';
  return card && misstated.length ? 'card' : 'ok';
}

/** What goes out instead of prose that contradicts its own card: the card, in words. */
export function cardInWords(card: Card, lang: Lang): string {
  return lang === 'en'
    ? `${card.service} is ${pesosEn(card.price)}. I'm sending it to the salon as a request for ${card.dayLabel}${card.time ? ` at ${time12(card.time)}` : ''}${card.stylist ? ` with ${card.stylist}` : ''}, and someone there confirms the time.`
    : `${card.service}: ${pesosEs(card.price)}. Te lo paso como pedido para el ${card.dayLabel}${card.time ? ` a las ${card.time}` : ''}${card.stylist ? ` con ${card.stylist}` : ''}, y del local te confirman el horario.`;
}

/** English path, on a reply the guard accepted: "$16.000" or "$25k" is rewritten as "$16,000". */
export function moneyToEn(reply: string): string {
  return reply.replace(MONEY_EN, (m) => {
    if (!/\d/.test(m)) return m;
    const tail = /k$/i.test(m) ? '' : (/[.,]+$/.exec(m)?.[0] ?? '');
    return pesosEn(toAmountEn(m)) + tail;
  });
}

/* A reply with control characters in it: in the source's red team, a tab replaced the "é" in a
   staff name. The names are put back whole and any other control becomes a space. */
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const CONTROL_RUN = /[\u0000-\u0009\u000B-\u001F\u007F]+/g;
const BROKEN_LINE = / \n(?=\p{Ll})/gu;
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const garbled = (reply: string): boolean => CONTROL.test(reply) || / \n(?=\p{Ll})/u.test(reply);

export function withoutControls(reply: string): string {
  if (!garbled(reply)) return reply;
  let out = reply;
  for (const { name } of SALON_STAFF) {
    const i = name.search(/[^\x00-\x7F]/);
    if (i < 0) continue;
    out = out.replace(new RegExp(`${escapeRe(name.slice(0, i))}${CONTROL_RUN.source}[a-z]?${escapeRe(name.slice(i + 1))}`, 'g'), name);
  }
  return out.replace(BROKEN_LINE, ' ').replace(CONTROL_RUN, ' ').replace(/ {2,}/g, ' ');
}

/** Links and schemes out of the prose: the address is written as plain text, never a link. */
export function plainText(s: string): string {
  return s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\//gi, '').replace(/\bwww\./gi, '');
}
