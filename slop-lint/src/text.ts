import type { Lang } from './types.ts';

export interface Span {
  start: number;
  end: number;
  text: string;
}

/** Abbreviations whose period does not end a sentence, lowercased and without the final period. */
const ABBREVIATIONS = new Set([
  'sr', 'sra', 'sres', 'srta', 'dr', 'dra', 'lic', 'ing', 'prof', 'arq', 'cdor', 'cra',
  'mr', 'mrs', 'ms', 'st', 'jr', 'etc', 'vs', 'e.g', 'i.e', 'approx', 'nro', 'av', 'inc', 'ltd',
  'rr', 'hh', 'ee', 'uu',
]);

const TERMINATORS = '.!?…';
const CLOSERS = '"”’»)\'';

function isLowercaseLetter(ch: string | undefined): boolean {
  return ch !== undefined && /\p{Ll}/u.test(ch);
}

function trimSpan(text: string, start: number, end: number): Span | null {
  while (start < end && /\s/u.test(text[start] ?? '')) start++;
  while (end > start && /\s/u.test(text[end - 1] ?? '')) end--;
  return start < end ? { start, end, text: text.slice(start, end) } : null;
}

function nextNonSpace(text: string, from: number): number {
  let k = from;
  while (k < text.length && /[ \t\r]/u.test(text[k] ?? '')) k++;
  return k;
}

/**
 * Splits plain text into sentences with their offsets.
 *
 * A sentence ends at . ! ? or … followed by whitespace, unless the word before the
 * period is a known abbreviation or a single-letter initial, or the next word starts
 * in lowercase. A line break also ends a sentence, so salutations, signatures and
 * one-paragraph-per-line text split where a reader would split them, unless the next
 * line starts in lowercase (a hard-wrapped paragraph).
 */
export function splitSentences(text: string): Span[] {
  const out: Span[] = [];
  let start = 0;
  const push = (end: number): void => {
    const span = trimSpan(text, start, end);
    if (span) out.push(span);
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === '\n') {
      const k = nextNonSpace(text, i + 1);
      const blankLine = text[k] === '\n';
      if (blankLine || !isLowercaseLetter(text[k])) {
        push(i);
        start = i + 1;
      }
      i++;
      continue;
    }
    if (TERMINATORS.includes(ch)) {
      let j = i + 1;
      while (j < text.length && (TERMINATORS.includes(text[j] ?? '') || CLOSERS.includes(text[j] ?? ''))) j++;
      if (j < text.length && !/\s/u.test(text[j] ?? '')) {
        i = j;
        continue;
      }
      if (ch === '.') {
        const before = /([\p{L}.]+)$/u.exec(text.slice(start, i));
        const token = before?.[1] ?? '';
        const bare = token.replace(/\.$/u, '').toLowerCase();
        // A single initial ("J.") or letters joined by periods ("U.S.", "EE.UU.", "e.g.").
        if (ABBREVIATIONS.has(bare) || /^\p{Lu}$/u.test(token) || /^(?:\p{L}{1,2}\.)+\p{L}{1,2}$/u.test(token)) {
          i = j;
          continue;
        }
      }
      const k = nextNonSpace(text, j);
      if (k < text.length && text[k] !== '\n' && isLowercaseLetter(text[k])) {
        i = j;
        continue;
      }
      push(j);
      start = j;
      i = j;
      continue;
    }
    i++;
  }
  push(text.length);
  return out;
}

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

export function words(text: string): Span[] {
  return [...text.matchAll(WORD)].map((m) => ({ start: m.index, end: m.index + m[0].length, text: m[0] }));
}

/** A sentence that reads as prose: ends in terminal punctuation and has at least 3 words. */
export function isProse(sentence: Span): boolean {
  return /[.!?…]["”’»)]*$/u.test(sentence.text) && words(sentence.text).length >= 3;
}

/** Offsets where each line starts, for converting an offset to line and column. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

export function lineColumn(starts: readonly number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - (starts[lo] ?? 0) + 1 };
}

/** Longest quotation that counts as one; a quoted phrase in a letter is a few words. */
const MAX_QUOTE = 80;

/**
 * Ranges inside straight double quotes, curly double quotes or angle quotes. A range
 * stays on one line, inside one sentence (no . ! ? followed by a space) and under
 * MAX_QUOTE characters, so one stray quote mark cannot pair with a later one and
 * exempt the sentences between them.
 */
export function quotedRanges(text: string): Array<[number, number]> {
  const inner = (close: string) => `(?:[^${close}\\n.!?…]|[.!?…](?!\\s))*`;
  const re = new RegExp(`"${inner('"')}"|“${inner('”')}”|«${inner('»')}»`, 'gu');
  return [...text.matchAll(re)].filter((m) => m[0].length <= MAX_QUOTE).map((m) => [m.index, m.index + m[0].length]);
}

export const NUMBER_WORDS: Record<Lang, readonly string[]> = {
  en: [
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'fifteen', 'twenty', 'thirty', 'forty', 'fifty', 'hundred', 'thousand', 'million', 'half',
  ],
  es: [
    'uno', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once',
    'doce', 'quince', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'cien', 'ciento', 'mil', 'millón', 'medio',
  ],
};

/** Tools usually written in lowercase, so the proper-noun test would miss them. */
const LOWERCASE_TOOLS = ['pandas', 'numpy', 'dbt', 'npm', 'git', 'scikit-learn', 'pytorch', 'kubectl', 'bash', 'vim'];

const FIRST_PERSON_EN = new Set(['I', "I'm", "I've", "I'd", "I'll", 'I’m', 'I’ve', 'I’d', 'I’ll']);

/**
 * Counts anchors in a sentence: numbers (digits or number words), proper nouns
 * (a capitalized word that is not the sentence's first word, and not "I"),
 * acronyms (two or more capitals, anywhere), and the extra terms given by the caller.
 * "una", "one", "half" and "medio" are not counted: they are articles or pronouns
 * far more often than figures.
 */
export function countAnchors(sentence: string, lang: Lang, extra: readonly string[] = []): number {
  const ws = words(sentence);
  const numberWords = new Set(NUMBER_WORDS[lang].filter((w) => w !== 'una' && w !== 'one' && w !== 'half' && w !== 'medio'));
  const terms = [...LOWERCASE_TOOLS, ...extra].map((t) => t.toLowerCase());
  let count = 0;
  ws.forEach((w, index) => {
    const lower = w.text.toLowerCase();
    if (/\p{N}/u.test(w.text)) count++;
    else if (numberWords.has(lower)) count++;
    else if (/^\p{Lu}{2,}/u.test(w.text)) count++;
    else if (index > 0 && /^\p{Lu}/u.test(w.text) && !(lang === 'en' && FIRST_PERSON_EN.has(w.text))) count++;
    else if (terms.includes(lower)) count++;
  });
  // Multi-word extra terms ("Power BI", "SQL Server") are matched on the whole sentence.
  for (const term of extra) {
    if (/\s/u.test(term) && sentence.toLowerCase().includes(term.toLowerCase())) count++;
  }
  return count;
}
