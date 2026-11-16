// A copy of specifics() from apps/writer/evals/specifics.ts, with its patterns. prose-rewriter is a
// library and no library imports an app (import-fences/repo.config.ts, design 4.2), so the function
// is copied here instead of imported. test/specifics.test.ts reads both files as text and fails if
// the body of specifics() or one of its patterns stops matching the original.
//
// The copy keeps the original's placeholder handling: every `[COMPLETAR ...]` is blanked out before
// anything is read, so a marker that asks for a fact never counts as one. Only what facts.ts needs is
// exported; scoreDraft() and supported() stay in the app, since they read the writer's protocol.
//
// Pure: no I/O.

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

/** "08:00" and "8.00" as "8:00"; "3:00pm" and "3:00 p.m." as "15:00"; "12:30am" as "0:30". */
export const asTime = (s: string): string => {
  const m = /^(\d{1,2})[:.](\d{2})\s?(?:([ap])\.?\s?m\.?)?$/iu.exec(s);
  if (!m) return s;
  const hour = Number(m[1]);
  const half = m[3]?.toLowerCase();
  const h24 = half === undefined ? hour : (hour % 12) + (half === 'p' ? 12 : 0);
  return `${h24}:${m[2] ?? ''}`;
};

/** The original's patterns, for facts.ts to read the same spans specifics() reads. */
export const SPECIFIC_PATTERNS = { TIME, EMAIL, URL_LIKE, NUMBER, PLACEHOLDER_ANY } as const;
