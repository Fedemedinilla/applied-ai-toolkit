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
 * phrase is 'keep'; one that overlaps an edit accepted before it is 'overlap' (the first stands).
 * Edits that only touch at an edge do not overlap.
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
  const keep = (options.keep ?? []).filter((k) => k !== '').flatMap((k) => occurrences(text, k).map((start) => ({ phrase: k, start, end: start + k.length })));
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
    const kept = keep.find((k) => intersects(k, span));
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

/** RewriteResult.diff: one hunk per accepted edit, in the original's coordinates and in text order. */
export function diffHunks(original: string, accepted: readonly AppliedEdit[]): DiffHunk[] {
  return render(original, accepted).accepted.map((a) => ({ span: { start: a.span.start, end: a.span.end }, before: a.before, after: a.after }));
}
