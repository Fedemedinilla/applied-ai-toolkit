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

const TIME = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/gu;
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
const asTime = (s: string): string => {
  const [hour = '', minutes = ''] = s.split(/[:.]/u);
  return `${Number(hour)}:${minutes}`;
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
