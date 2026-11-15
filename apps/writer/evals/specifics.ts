// The score of one draft, computed in code with no judge: did it follow the protocol, how many
// [COMPLETAR] gaps did it leave, and which specifics (numbers, times, emails, links) does it state
// that appear nowhere in the fact sheet. A number is the kind of invention a family acts on: a
// time to show up, a day, an amount to pay.
//
// What this cannot see: an invented procedure or promise in words ("traer una vianda"), a weekday
// that does not match its date, or a fact left out with no gap marked. Those need a reader or the
// line-by-line judge (evals/src/judge.ts), which is not wired to this target.

import { parseReply, placeholders } from '../src/protocol.ts';

export type SpecificKind = 'time' | 'number' | 'email' | 'url';

export interface Specific {
  readonly kind: SpecificKind;
  readonly text: string;
}

/**
 * A time ends at its last digit, so a suffix touching it ("15:00hs", "8:30h") does not split it
 * into two numbers. A 12-hour suffix ("3:00pm", "3:00 p.m.") is kept with it, for asTime.
 */
const TIME = /\b([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)(?:\s?[ap]\.?\s?m\b\.?)?/giu;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu;
const URL_LIKE = /\bhttps?:\/\/\S+|\bwww\.\S+/gu;
const NUMBER = /\d+(?:[.,]\d+)*/gu;
const PLACEHOLDER_ANY = /\[COMPLETAR[^\]\n]*\]/gu;

/** Every specific in the text, in order. Times are read first, so "8:30" is one time, not 8 and 30. */
export function specifics(text: string): Specific[] {
  const out: Specific[] = [];
  let rest = text.replace(PLACEHOLDER_ANY, ' ');
  for (const [kind, pattern] of [
    ['url', URL_LIKE],
    ['email', EMAIL],
    ['time', TIME],
  ] as const) {
    rest = rest.replace(pattern, (m) => {
      out.push({ kind, text: m.replace(/[.,;:)]+$/u, '') });
      return ' ';
    });
  }
  for (const m of rest.matchAll(NUMBER)) out.push({ kind: 'number', text: m[0] });
  return out;
}

const digits = (s: string): string => s.replace(/\D/gu, '');
const asInt = (s: string): string => String(Number(digits(s)));
/** "08:00" and "8.00" as "8:00"; "3:00pm" and "3:00 p.m." as "15:00"; "12:30am" as "0:30". */
const asTime = (s: string): string => {
  const m = /^(\d{1,2})[:.](\d{2})\s?(?:([ap])\.?\s?m\.?)?$/iu.exec(s);
  if (!m) return s;
  const hour = Number(m[1]);
  const half = m[3]?.toLowerCase();
  const h24 = half === undefined ? hour : (hour % 12) + (half === 'p' ? 12 : 0);
  return `${h24}:${m[2] ?? ''}`;
};

/**
 * Whether the sheet supports one specific. A time is supported by the same time, or by its hour
 * alone when the minutes are 00 ("a las 18" supports "18:00", as the style guide asks). A number
 * is supported by the same number in the sheet, ignoring separators ("1.200" by "1200"), or by
 * the hour of a time in the sheet ("a las 8" by "8:00").
 */
export function supported(s: Specific, sheet: string): boolean {
  if (s.kind === 'email' || s.kind === 'url') return sheet.toLocaleLowerCase('es').includes(s.text.toLocaleLowerCase('es'));
  const found = specifics(sheet);
  const numbers = new Set(found.filter((x) => x.kind === 'number').map((x) => asInt(x.text)));
  const times = found.filter((x) => x.kind === 'time').map((x) => asTime(x.text));
  if (s.kind === 'time') {
    const time = asTime(s.text);
    return times.includes(time) || (time.endsWith(':00') && numbers.has(time.slice(0, -3)));
  }
  return numbers.has(asInt(s.text)) || times.some((t) => t.split(':')[0] === asInt(s.text));
}

export interface DraftScore {
  readonly protocol: boolean;
  readonly gaps: number;
  readonly unsupported: readonly Specific[];
}

export function scoreDraft(reply: string, sheet: string): DraftScore {
  const parsed = parseReply(reply);
  const text = parsed.kind === 'draft' ? [parsed.es, parsed.en ?? ''].join('\n') : parsed.kind === 'text' ? parsed.text : parsed.titles.join('\n');
  const seen = new Set<string>();
  const unsupported = specifics(text).filter((s) => {
    if (supported(s, sheet) || seen.has(`${s.kind}:${s.text}`)) return false;
    seen.add(`${s.kind}:${s.text}`);
    return true;
  });
  return { protocol: parsed.kind === 'draft', gaps: placeholders(text).length, unsupported };
}
