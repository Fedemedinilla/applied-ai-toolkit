/**
 * The edits of design 4.4, in code. Stage S0 splits the text into numbered sentences, with the
 * subject, the greeting, the body and the signature kept apart; the model then proposes edits
 * against those sentences, and code applies them, rejects the ones it cannot place and builds the
 * diff from the ones it accepted (RewriteResult.diff, 4.3).
 *
 * Every span is in the coordinates of the text it was cut from: [start, end), as String#slice.
 *
 * Pure: no I/O, no model, no gateway.
 */
import type { DiffHunk, Edit, Lang } from './types.ts';
import { isGreetingLine, signOffIndex } from './voice.ts';

interface Span {
  start: number;
  end: number;
  text: string;
}

// The splitter below is a copy of slop-lint's (slop-lint/src/text.ts), which is not on the public
// surface prose-rewriter may import (import-fences/repo.config.ts, LIBRARY_USES). The sentences the
// model edits have to be the sentences slop-lint reports on, so test/sentences.test.ts compares
// the copy with the original as text.

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
 * Splits plain text into sentences with their offsets, as slop-lint does.
 */
function splitSpans(text: string): Span[] {
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

export type TextPart = 'subject' | 'greeting' | 'body' | 'signature';

/** One part of the text. The parts follow each other without gaps and cover the whole text. */
export interface PartSpan {
  readonly part: TextPart;
  readonly start: number;
  readonly end: number;
}

/** A numbered sentence: Edit.sentenceId is its id. */
export interface Sentence {
  readonly id: number;
  readonly part: TextPart;
  readonly start: number;
  readonly end: number;
  /** Always text.slice(start, end). */
  readonly text: string;
}

/** A mail's subject line, in either language: "Asunto: ..." or "Subject: ...". */
const SUBJECT = /^(?:asunto|subject)\s*:/iu;

/**
 * The subject (a first line that opens with "Asunto:" or "Subject:"), the greeting (the next line,
 * when it is a short greeting), the signature (from a short sign-off among the last two lines to
 * the end) and the body between them. Greeting and sign-off are read with voice.ts's own tests, so
 * the voice profile and S0 agree on where the frame is. A part that is not there is left out.
 *
 * `lang` is part of the S0 signature; the frame is read the same way in both languages.
 */
export function textParts(text: string, _lang: Lang): PartSpan[] {
  const lines: { start: number; text: string }[] = [];
  let at = 0;
  for (const line of text.split('\n')) {
    if (line.trim() !== '') lines.push({ start: at, text: line });
    at += line.length + 1;
  }
  const starts: { part: TextPart; start: number }[] = [];
  let next = 0;
  if (SUBJECT.test(lines[0]?.text.trim() ?? '')) {
    starts.push({ part: 'subject', start: 0 });
    next = 1;
  }
  const greeting = lines[next];
  if (greeting !== undefined && isGreetingLine(greeting.text)) {
    starts.push({ part: 'greeting', start: greeting.start });
    next++;
  }
  const rest = lines.slice(next);
  const signOff = signOffIndex(rest.map((l) => l.text), false);
  const bodyLines = signOff === -1 ? rest : rest.slice(0, signOff);
  if (bodyLines.length > 0) starts.push({ part: 'body', start: bodyLines[0]?.start ?? 0 });
  if (signOff !== -1) starts.push({ part: 'signature', start: rest[signOff]?.start ?? 0 });
  if (starts.length === 0) return [{ part: 'body', start: 0, end: text.length }];
  return starts.map((s, i) => ({ part: s.part, start: i === 0 ? 0 : s.start, end: starts[i + 1]?.start ?? text.length }));
}

/**
 * Stage S0: the text's sentences, numbered from 0 in reading order, each inside one part. The
 * split is slop-lint's, run part by part, so a greeting never joins the body.
 */
export function splitSentences(text: string, lang: Lang): Sentence[] {
  const out: Sentence[] = [];
  for (const part of textParts(text, lang)) {
    for (const span of splitSpans(text.slice(part.start, part.end))) {
      const start = part.start + span.start;
      out.push({ id: out.length, part: part.part, start, end: start + span.text.length, text: span.text });
    }
  }
  return out;
}

/** A [start, end) range: in the original text, or in the rewritten one for AppliedEdit.newSpan. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** An edit code placed and applied. */
export interface AppliedEdit {
  readonly id: string;
  readonly edit: Edit;
  /** Where `before` sits in the original text. */
  readonly span: TextRange;
  /** Where `after` sits in the text the accepted edits produce, so a finding there names its edit. */
  readonly newSpan: TextRange;
  /** The edit's quote and replacement, in NFC. */
  readonly before: string;
  readonly after: string;
}

/**
 * Why code refused an edit: its quote is not in its sentence (or there is no such sentence), it is
 * there more than once, it starts or ends inside a character (half an emoji, a letter without its
 * accent), it overlaps an edit accepted before it, it touches a keep[] phrase, or it changes nothing.
 */
export type RejectReason = 'not-found' | 'ambiguous' | 'boundary' | 'overlap' | 'keep' | 'no-op';

export interface RejectedEdit {
  readonly id: string;
  readonly edit: Edit;
  readonly reason: RejectReason;
  readonly message: string;
  /** Where the edit would have applied, when its quote was placed. */
  readonly span?: TextRange;
  /** The accepted edit it overlaps (reason 'overlap'). */
  readonly conflictsWith?: string;
}

export interface ApplyOptions {
  /** RewriteInput.keep: phrases no edit may touch. */
  readonly keep?: readonly string[];
  /** Ids are `${idPrefix}${n}`, n counting the edits from 1 in the order given. Default 'e'. */
  readonly idPrefix?: string;
}

export interface ApplyResult {
  readonly text: string;
  /** In text order. */
  readonly accepted: AppliedEdit[];
  /** In the order the edits were given. */
  readonly rejected: RejectedEdit[];
}

const intersects = (a: TextRange, b: TextRange): boolean => a.start < b.end && b.start < a.end;

/** Where each character the reader sees (a grapheme: an emoji, a flag, a letter and its accents) starts, and the end. */
function graphemeBoundaries(text: string): Set<number> {
  const out = new Set<number>([text.length]);
  for (const g of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)) out.add(g.index);
  return out;
}

/** A replacement that would join the character before it: a combining mark, a joiner or a variation selector. */
const JOINS_PREVIOUS = /^[\p{M}\u200D\uFE0E\uFE0F]/u;

/**
 * Where each keep[] phrase sits in the text. A phrase is matched as the text writes it: in NFC,
 * with any run of whitespace (a line break, two spaces) standing for each space in it, as
 * slop-lint matches a multi-word anchor. A blank phrase is ignored: it would match everywhere.
 */
function keepSpans(text: string, phrases: readonly string[]): Array<TextRange & { phrase: string }> {
  return phrases.flatMap((raw) => {
    const phrase = raw.normalize('NFC').trim();
    if (phrase === '') return [];
    const source = phrase.split(/\s+/u).map((part) => part.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&')).join(String.raw`\s+`);
    return [...text.matchAll(new RegExp(source, 'gu'))].map((m) => ({ phrase: raw, start: m.index, end: m.index + m[0].length }));
  });
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/**
 * Whether an edit that only touches a kept phrase at its edge would glue text onto it, so the
 * phrase no longer stands as a word ("Power BI" followed by "X mucho" reads "Power BIX").
 */
function gluesOnto(text: string, kept: TextRange, span: TextRange, after: string): boolean {
  if (span.start === kept.end) {
    const next = (after + text.slice(span.end))[0] ?? '';
    return WORD_CHAR.test(text[kept.end - 1] ?? '') && WORD_CHAR.test(next);
  }
  if (span.end === kept.start) {
    const previous = (text.slice(0, span.start) + after).at(-1) ?? '';
    return WORD_CHAR.test(text[kept.start] ?? '') && WORD_CHAR.test(previous);
  }
  return false;
}

/** Every place `needle` starts in `haystack`, overlapping places included ("aa" twice in "aaa"). */
function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) out.push(at);
  return out;
}

/**
 * The text the given edits produce from the original, applied right to left so each span stays
 * valid, with each edit's span in the new text. The edits must not overlap.
 */
function render(original: string, edits: readonly AppliedEdit[]): { text: string; accepted: AppliedEdit[] } {
  const ordered = [...edits].sort((a, b) => a.span.start - b.span.start);
  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i] as AppliedEdit;
    if (original.slice(e.span.start, e.span.end) !== e.before) {
      throw new Error(`edit ${e.id}: "${e.before}" is no longer at ${e.span.start}-${e.span.end} of the original`);
    }
    const prev = ordered[i - 1];
    if (prev !== undefined && intersects(prev.span, e.span)) throw new Error(`edits ${prev.id} and ${e.id} overlap`);
  }
  let text = original;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const e = ordered[i] as AppliedEdit;
    text = text.slice(0, e.span.start) + e.after + text.slice(e.span.end);
  }
  let shift = 0;
  const accepted = ordered.map((e) => {
    const start = e.span.start + shift;
    shift += e.after.length - e.before.length;
    return { ...e, newSpan: { start, end: start + e.after.length } };
  });
  return { text, accepted };
}

/**
 * Places each edit by its exact quote inside its sentence, refuses what it cannot place, and
 * applies the rest. In the order given: an edit whose `before` is not in its sentence, exactly as
 * written, is 'not-found'; one whose `before` is there more than once is 'ambiguous', since code
 * would have to guess which; one that starts or ends inside a character is 'boundary'; one that
 * changes nothing is 'no-op'; one that overlaps a keep[]
 * phrase, or touches one at its edge in a way that glues text onto it, is 'keep'; one that
 * overlaps an edit accepted before it is 'overlap' (the first stands). Edits that only touch at an
 * edge do not overlap.
 *
 * The text must be in NFC (S0
 * normalizes it); each edit's quote and replacement are normalized to NFC before they are placed,
 * so a quote matches the same way whatever form the model wrote it in.
 *
 * `sentences` must be the ones splitSentences cut from `text`; a sentence that does not slice the
 * text exactly is a caller's mistake and throws, and so does a text that is not in NFC.
 */
export function applyEdits(text: string, sentences: readonly Sentence[], edits: readonly Edit[], options: ApplyOptions = {}): ApplyResult {
  if (text !== text.normalize('NFC')) throw new Error('the text is not in NFC: normalize it in S0, before splitting it');
  const boundaries = graphemeBoundaries(text);
  for (const s of sentences) {
    if (text.slice(s.start, s.end) !== s.text) throw new Error(`sentence ${s.id} was not cut from this text`);
  }
  const keep = keepSpans(text, options.keep ?? []);
  const prefix = options.idPrefix ?? 'e';
  const accepted: AppliedEdit[] = [];
  const rejected: RejectedEdit[] = [];
  edits.forEach((edit, i) => {
    const id = `${prefix}${i + 1}`;
    const reject = (reason: RejectReason, message: string, extra: { span?: TextRange; conflictsWith?: string } = {}) =>
      rejected.push({ id, edit, reason, message, ...extra });
    const sentence = sentences.find((s) => s.id === edit.sentenceId);
    if (sentence === undefined) return reject('not-found', `there is no sentence ${edit.sentenceId}`);
    const before = edit.before.normalize('NFC');
    const after = edit.after.normalize('NFC');
    const places = occurrences(sentence.text, before);
    if (places.length === 0) return reject('not-found', `"${edit.before}" is not in sentence ${edit.sentenceId}`);
    if (places.length > 1) return reject('ambiguous', `"${edit.before}" appears ${places.length} times in sentence ${edit.sentenceId}`);
    const start = sentence.start + (places[0] as number);
    const span = { start, end: start + before.length };
    if (!boundaries.has(span.start) || !boundaries.has(span.end) || JOINS_PREVIOUS.test(after)) {
      return reject('boundary', 'the edit starts or ends inside a character', { span });
    }
    if (after === before) return reject('no-op', 'the edit changes nothing', { span });
    const kept = keep.find((k) => intersects(k, span) || gluesOnto(text, k, span, after));
    if (kept !== undefined) return reject('keep', `the edit touches "${kept.phrase}", which is kept as written`, { span });
    const other = accepted.find((a) => intersects(a.span, span));
    if (other !== undefined) return reject('overlap', `the edit overlaps ${other.id}, accepted before it`, { span, conflictsWith: other.id });
    accepted.push({ id, edit, span, newSpan: span, before, after });
  });
  return { ...render(text, accepted), rejected };
}

/** The text the accepted edits produce from the original: what S5 and S6 re-derive after a revert. */
export function renderEdits(original: string, accepted: readonly AppliedEdit[]): string {
  return render(original, accepted).text;
}

/**
 * Reverts one accepted edit alone (S5, S6) and re-derives the text from the original with the
 * others, so no revert depends on the order of the ones before it. An unknown id reverts nothing.
 */
export function revertEdit(
  original: string,
  accepted: readonly AppliedEdit[],
  id: string,
): { text: string; accepted: AppliedEdit[]; reverted?: AppliedEdit } {
  const reverted = accepted.find((a) => a.id === id);
  const rendered = render(original, accepted.filter((a) => a.id !== id));
  return reverted === undefined ? rendered : { ...rendered, reverted };
}

const BLANK = /[ \t]/u;
/** What may follow a deleted word directly, with no space before it: closing punctuation. */
const CLOSES_AFTER = /[,.;:!?…)\]»”]/u;

/** What may come right before a deleted word, with no space after it: opening punctuation. */
const OPENS_BEFORE = /[(\[{«“‘"'¿¡]/u;

/**
 * The accepted edits with each deletion (an empty `after`) widened over the space it would leave
 * behind, so the text they produce never starts a line with a space, ends one with a space, or
 * keeps two spaces between sentences. Each deletion, in text order, takes one side:
 *   - at the start of a line, the space after it;
 *   - otherwise, when it ends at a space, a line end or closing punctuation, the space before it;
 *   - otherwise the space after it, when an opening mark precedes it ("(Uno. Dos.)") or the
 *     deletion before it in a run already took the space before it.
 * A deletion only takes spaces no other edit holds, and decides on its own sides, so restoring
 * any one deletion of a run (the page lets the user do that) still leaves clean text, except
 * where a run fills a whole line. Tidying twice changes nothing. Spans and quotes stay in the
 * original's coordinates, so the diff still applies; newSpan is computed again.
 *
 * Why: the model deletes a sentence by quoting it without the space after it, and the live eval
 * of 17/11 shipped "Hola Martín,\n\n Te escribo..." in 26 of 147 pieces. Kept out of applyEdits,
 * since the checks match each edit's quote against its sentence; S7 tidies the edits it ships.
 * Each deletion decides alone (review of 17/11): a run widened as one gap glued two sentences
 * ("Hola.Tres") when the user restored one of them.
 *
 * Then whole lines (wholeLines) and the blank lines between paragraphs (blankRuns): a line the
 * deletions empty goes with its line break, a list marker whose item text is all deleted goes
 * with it, and a run of three or more line breaks the deletions leave is cut back to the most the
 * user wrote there, at least two; a deletion at either end of the text takes the line breaks
 * between it and the rest (textEdges). Why: live run 2 of 17/11 (es-email-heavy-4) shipped "1.\n2.\n3."
 * between runs of four line breaks after the lead-in, the items and the paragraph after them were
 * deleted.
 */
export function tidyDeletions(original: string, accepted: readonly AppliedEdit[]): AppliedEdit[] {
  const ordered = [...accepted].sort((a, b) => a.span.start - b.span.start);
  const spans = ordered.map((e) => ({ start: e.span.start, end: e.span.end }));
  const free = (from: number, to: number): boolean => spans.every((s) => to <= s.start || from >= s.end);
  for (const [i, e] of ordered.entries()) {
    if (e.after !== '') continue;
    const span = spans[i] as { start: number; end: number };
    const { start, end } = span;
    let k0 = start;
    while (k0 > 0 && BLANK.test(original[k0 - 1] ?? '')) k0--;
    let k1 = end;
    while (k1 < original.length && BLANK.test(original[k1] ?? '')) k1++;
    const lineStart = k0 === 0 || original[k0 - 1] === '\n';
    const lineEnd = k1 === original.length || /[\r\n]/u.test(original[k1] ?? '');
    const after = k1 > end && !lineEnd && free(end, k1);
    if (lineStart) {
      if (after) span.end = k1;
    } else if (k0 < start && free(k0, start) && (lineEnd || k1 > end || CLOSES_AFTER.test(original[end] ?? ''))) {
      span.start = k0;
    } else if (after && (OPENS_BEFORE.test(original[start - 1] ?? '') || (k0 < start && !free(k0, start)))) {
      span.end = k1;
    }
  }
  wholeLines(original, ordered, spans, free);
  blankRuns(original, ordered, spans, free);
  textEdges(original, ordered, spans, free);
  const widened = ordered.map((e, i) => {
    const span = spans[i] as TextRange;
    return span.start === e.span.start && span.end === e.span.end ? e : { ...e, span, before: original.slice(span.start, span.end) };
  });
  return render(original, widened).accepted;
}

type MutableSpan = { start: number; end: number };
type Free = (from: number, to: number) => boolean;

/** A list item's marker, alone: "1.", "2)", "b)", "iv.", "-", "*" or "•". */
const BARE_MARKER = /^(?:\d{1,2}[.)]|(?:[ivxlc]{1,5}|[IVXLC]{1,5}|\p{L})[.)]|[-*•])$/u;

/**
 * Each line of the original whose content the deletions cover, except at most a list marker that
 * opens it, goes whole: the first deletion on it takes the marker and the blanks before it, each
 * deletion the blanks up to the next one, and the last one the line break after the line (the
 * first one the break before it, on the last line). A line with any other edit on it, or whose
 * break an edit already holds, is left as it is. Restoring one deletion of a line that several
 * fill can glue that line to the next: the page's restore is per change, and a whole line is one
 * break that only one of them can hold.
 */
function wholeLines(original: string, ordered: readonly AppliedEdit[], spans: MutableSpan[], free: Free): void {
  for (let ls = 0; ls < original.length; ) {
    const newline = original.indexOf('\n', ls);
    const le = newline < 0 ? original.length : newline;
    const line = { ls, le };
    ls = le + 1;
    if (original.slice(line.ls, line.le).trim() === '') continue;
    const on = spans
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => (s.start < line.le && s.end > line.ls) || (s.start === s.end && s.start >= line.ls && s.start <= line.le));
    if (on.length === 0 || on.some(({ i, s }) => ordered[i]?.after !== '' || s.start < line.ls || s.end > line.le)) continue;
    // What no deletion covers on the line: nothing but blanks, or a marker before the first deletion.
    const first = on[0]?.s as MutableSpan;
    const last = on[on.length - 1]?.s as MutableSpan;
    let rest = '';
    for (let k = line.ls; k < line.le; k++) if (free(k, k + 1)) rest += original[k] ?? '';
    const head = original.slice(line.ls, first.start);
    if (rest.trim() !== '' && !(BARE_MARKER.test(rest.trim()) && head.trim() === rest.trim())) continue;
    first.start = line.ls;
    for (let j = 0; j + 1 < on.length; j++) (on[j]?.s as MutableSpan).end = (on[j + 1]?.s as MutableSpan).start;
    last.end = line.le;
    if (line.le < original.length && free(line.le, line.le + 1)) last.end = line.le + 1;
    else if (line.le === original.length && line.ls > 0 && free(line.ls - 1, line.ls)) first.start = line.ls - 1;
  }
}

/**
 * Each stretch of the original made only of deletions and the blanks and line breaks between them
 * that leaves three or more line breaks in the text is cut back to the most line breaks the user
 * wrote in a row inside it, at least two: the deletions, in text order, take the breaks after
 * them, then, in reverse order, the ones before them. A stretch with no deletion is the user's
 * own and stays as written.
 */
function blankRuns(original: string, ordered: readonly AppliedEdit[], spans: MutableSpan[], free: Free): void {
  const deletionAt = (k: number): number => spans.findIndex((s, i) => ordered[i]?.after === '' && s.start <= k && k < s.end);
  for (let a = 0; a < original.length; ) {
    let b = a;
    const inside: number[] = [];
    let breaks = 0;
    let own = 0;
    let row = 0;
    while (b < original.length) {
      const d = deletionAt(b);
      if (d >= 0) {
        if (!inside.includes(d)) inside.push(d);
        row = 0;
        b = (spans[d] as MutableSpan).end;
        continue;
      }
      const ch = original[b] ?? '';
      if (!free(b, b + 1) || !/[ \t\r\n]/u.test(ch)) break;
      if (ch === '\n') {
        breaks++;
        own = Math.max(own, ++row);
      }
      b++;
    }
    if (b === a) {
      a++;
      continue;
    }
    let excess = breaks - Math.max(2, own);
    if (inside.length > 0 && excess > 0) {
      for (const d of inside) {
        const span = spans[d] as MutableSpan;
        for (let k = span.end; excess > 0 && k < b && free(k, k + 1) && /[ \t\r\n]/u.test(original[k] ?? ''); k++) {
          if (original[k] === '\n') {
            excess--;
            span.end = k + 1;
          }
        }
      }
      for (const d of [...inside].reverse()) {
        const span = spans[d] as MutableSpan;
        for (let k = span.start - 1; excess > 0 && k >= a && free(k, k + 1) && /[ \t\r\n]/u.test(original[k] ?? ''); k--) {
          if (original[k] === '\n') {
            excess--;
            span.start = k;
          }
        }
      }
    }
    a = b;
  }
}

/**
 * A deletion that starts the text takes the blanks and line breaks after it, and one that ends
 * the text the ones before it, so the text never starts or ends with a line break the deletions
 * left (review of 17/11: a deleted subject line shipped a text that started with "\n").
 */
function textEdges(original: string, ordered: readonly AppliedEdit[], spans: MutableSpan[], free: Free): void {
  for (const [i, span] of spans.entries()) {
    if (ordered[i]?.after !== '') continue;
    if (span.start === 0) while (span.end < original.length && /[ \t\r\n]/u.test(original[span.end] ?? '') && free(span.end, span.end + 1)) span.end++;
    if (span.end === original.length) while (span.start > 0 && /[ \t\r\n]/u.test(original[span.start - 1] ?? '') && free(span.start - 1, span.start)) span.start--;
  }
}

/** RewriteResult.diff: one hunk per accepted edit, in the original's coordinates and in text order. */
export function diffHunks(original: string, accepted: readonly AppliedEdit[]): DiffHunk[] {
  return render(original, accepted).accepted.map((a) => ({ span: { start: a.span.start, end: a.span.end }, before: a.before, after: a.after }));
}
