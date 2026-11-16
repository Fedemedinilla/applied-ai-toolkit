import { B, compile, E } from './regex.ts';
import type { Lang } from './types.ts';

export interface Span {
  start: number;
  end: number;
  text: string;
}

/** Abbreviations whose period never ends a sentence, lowercased and without the final period. */
const ABBREVIATIONS = new Set([
  'sr', 'sra', 'sres', 'srta', 'dr', 'dra', 'lic', 'ing', 'prof', 'arq', 'cdor', 'cra',
  'mr', 'mrs', 'ms', 'st', 'vs', 'e.g', 'i.e', 'nro', 'núm', 'av', 'pág', 'págs',
  'ej', 'cf', 'rr', 'ee',
]);

/**
 * Abbreviations that can also close a sentence, lowercased and without the final period: their
 * period ends the sentence when the next word starts in uppercase ("etc. Después", "EE. UU. Ahora")
 * and stays inside it otherwise. Read as ends, a capitalized word after them mid-sentence (a proper
 * noun after "etc.") is cut, which is rarer than a sentence that ends on them.
 */
const CLOSING_ABBREVIATIONS = new Set(['etc', 'inc', 'ltd', 'jr', 'hh', 'uu', 'aprox', 'approx']);

/**
 * Nouns that name a thing with a single capital letter ("plan B.", "vitamina C."), lowercased: after
 * one of them the letter closes like "etc.". After any other word a capital and a period are an
 * initial ("el señor J. Pérez"), because a name always continues in uppercase and cannot be told
 * apart from a new sentence.
 */
const LETTER_NAMES = new Set([
  'plan', 'vitamina', 'vitamin', 'tipo', 'type', 'opción', 'option', 'grupo', 'group', 'clase',
  'class', 'categoría', 'category', 'fase', 'phase', 'anexo', 'appendix', 'modelo', 'model',
]);

/** What the opening punctuation of a sentence may be: «Después», "Then", ¿Cuál?, (Then). */
const OPENERS = '¿¡«"“‘(\'';

const TERMINATORS = '.!?…';
const CLOSERS = '"”’»)\'';

function isLowercaseLetter(ch: string | undefined): boolean {
  return ch !== undefined && /\p{Ll}/u.test(ch);
}

function isUppercaseLetter(ch: string | undefined): boolean {
  return ch !== undefined && /\p{Lu}/u.test(ch);
}

/**
 * How the period after `token` (the letters and periods before it) behaves: 'holds' never ends the
 * sentence, 'closes' ends it only before a word in uppercase, 'none' is not an abbreviation.
 *
 * Letters joined by periods hold when they hold a lowercase letter ("e.g.", "p.ej.") or are single
 * letters ("J.R.", "U.S.", which often comes before a capitalized noun, as in "U.S. Army"); groups
 * of two capitals ("EE.UU.", "RR.HH.") close. A single capital is an initial and holds ("J.",
 * "John F. Kennedy", "el señor J. Pérez") unless one of LETTER_NAMES comes before it: then it is a
 * letter used as a name ("plan B.", "vitamina C.") and closes.
 */
function abbreviationKind(token: string, previousWord: string): 'holds' | 'closes' | 'none' {
  const bare = token.replace(/\.$/u, '').toLowerCase();
  if (ABBREVIATIONS.has(bare)) return 'holds';
  if (CLOSING_ABBREVIATIONS.has(bare)) return 'closes';
  if (/^(?:\p{L}{1,2}\.)+\p{L}{1,2}$/u.test(token)) {
    return /\p{Ll}/u.test(token) || /^(?:\p{L}\.)+\p{L}$/u.test(token) ? 'holds' : 'closes';
  }
  if (/^\p{Lu}$/u.test(token)) {
    return LETTER_NAMES.has(previousWord.toLowerCase()) ? 'closes' : 'holds';
  }
  return 'none';
}

/** Whether the next word after `from` starts in uppercase, past spaces and opening punctuation. */
function nextWordIsCapitalized(text: string, from: number): boolean {
  let k = nextNonSpace(text, from);
  while (k < text.length && OPENERS.includes(text[k] ?? '')) k++;
  return isUppercaseLetter(text[k]);
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
 * A sentence ends at . ! ? or … followed by whitespace, unless the next word starts
 * in lowercase or the period closes an abbreviation (abbreviationKind): one that never
 * ends a sentence ("Sr.", "pág.", "p. ej.", "e.g.", "U.S.", an initial), or one that
 * can ("etc.", "aprox.", "EE. UU.", "Inc.", "plan B.") and is not followed by a word
 * in uppercase. A line break also ends a sentence, so salutations, signatures and
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
        const head = text.slice(start, i);
        const token = /([\p{L}.]+)$/u.exec(head)?.[1] ?? '';
        const previousWord = /(\p{L}+)\P{L}*$/u.exec(head.slice(0, head.length - token.length))?.[1] ?? '';
        const kind = token === '' ? 'none' : abbreviationKind(token, previousWord);
        if (kind === 'holds' || (kind === 'closes' && !nextWordIsCapitalized(text, j))) {
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
 * The anchors in a sentence, as the words or phrases that hold them, in order: numbers (digits or
 * number words), proper nouns (a capitalized word that is not the sentence's first word, and not
 * "I"), acronyms (two or more capitals, anywhere), and the extra terms given by the caller.
 * "una", "one", "half" and "medio" are not anchors: they are articles or pronouns far more often
 * than figures. A multi-word extra term is one more anchor, as the sentence writes it, on top of
 * the words in it that are anchors on their own.
 */
export function extractAnchors(sentence: string, lang: Lang, extra: readonly string[] = []): string[] {
  const ws = words(sentence);
  const numberWords = new Set(NUMBER_WORDS[lang].filter((w) => w !== 'una' && w !== 'one' && w !== 'half' && w !== 'medio'));
  // Extra terms are trimmed, as --anchors trims them, and a blank one is dropped: it would match everywhere.
  const extras = extra.map((t) => t.trim()).filter(Boolean);
  const terms = [...LOWERCASE_TOOLS, ...extras].map((t) => t.toLowerCase());
  const found: string[] = [];
  ws.forEach((w, index) => {
    const lower = w.text.toLowerCase();
    if (/\p{N}/u.test(w.text)) found.push(w.text);
    else if (numberWords.has(lower)) found.push(w.text);
    else if (/^\p{Lu}{2,}/u.test(w.text)) found.push(w.text);
    else if (index > 0 && /^\p{Lu}/u.test(w.text) && !(lang === 'en' && FIRST_PERSON_EN.has(w.text))) found.push(w.text);
    else if (terms.includes(lower)) found.push(w.text);
  });
  // Multi-word extra terms ("Power BI", "SQL Server") are matched on the whole sentence, as whole
  // words: "power bill" is not "Power BI". Any run of whitespace stands for the spaces in the term.
  for (const term of extras) {
    if (!/\s/u.test(term)) continue;
    const source = term.split(/\s+/u).map((part) => part.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&')).join(String.raw`\s+`);
    const match = compile(`${B}${source}${E}`, 'iu').exec(sentence);
    if (match !== null) found.push(match[0]);
  }
  return found;
}

/** How many anchors a sentence holds: always extractAnchors(...).length, so the two cannot drift. */
export function countAnchors(sentence: string, lang: Lang, extra: readonly string[] = []): number {
  return extractAnchors(sentence, lang, extra).length;
}
