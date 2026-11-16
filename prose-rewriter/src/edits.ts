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
import type { Lang } from './types.ts';
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
