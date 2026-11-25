/**
 * The shape of a text against its channel guide (style-refs/channels/), measured by code so the
 * diagnosis never asks a model to count: the body's words, its paragraphs and the sentences in
 * each, and what falls outside the guide's ranges. The body is the text minus its subject line,
 * greeting and sign-off (edits.ts textParts); a paragraph is a run of lines between blank lines.
 * The opening and the closing are prose rules, which the diagnosis stage judges.
 */
import { countWords, type Channel } from '../../style-refs/src/index.ts';
import { splitSentences, textParts } from './edits.ts';
import type { Lang } from './types.ts';

export type ShapeProblemKind = 'too-short' | 'too-long' | 'too-many-paragraphs' | 'long-paragraph';

export interface ShapeProblem {
  readonly kind: ShapeProblemKind;
  readonly message: string;
}

export interface Shape {
  /** The ids of the sentences inside the measured paragraphs, in reading order. */
  readonly bodySentenceIds: readonly number[];
  /** Words of the body. */
  readonly words: number;
  /** Sentences in each paragraph of the body, in reading order. */
  readonly paragraphs: readonly number[];
  readonly greeting: boolean;
  readonly signature: boolean;
  /** The guide measured against, by id, or null when the text's channel has none. */
  readonly guide: string | null;
  /** What falls outside the guide; empty without a guide. */
  readonly problems: readonly ShapeProblem[];
}

const SIGNATURE_MAX_WORDS = 4;

function isBareSignature(paragraph: string): boolean {
  const lines = paragraph.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.length <= 2 && lines.every((l) => countWords(l) <= SIGNATURE_MAX_WORDS && !/[.!?…:]$/u.test(l));
}

export function measureShape(text: string, lang: Lang, guide: Channel | undefined): Shape {
  const parts = textParts(text, lang);
  const body = parts.filter((p) => p.part === 'body');
  const sentences = splitSentences(text, lang).filter((s) => s.part === 'body');
  // Paragraph spans inside the body parts: split at blank lines.
  const spans: Array<{ start: number; end: number }> = [];
  for (const part of body) {
    const slice = text.slice(part.start, part.end);
    let at = 0;
    for (const chunk of slice.split(/\n[ \t]*\n/)) {
      const start = part.start + slice.indexOf(chunk, at);
      at = start - part.start + chunk.length;
      if (chunk.trim() !== '') spans.push({ start, end: start + chunk.length });
    }
  }
  // A name on its own at the end ("Valeria Sosa") is a signature even with no sign-off before it,
  // which textParts() needs: a last paragraph of at most two short lines with no sentence end.
  const last = spans.at(-1);
  const bareName = last !== undefined && spans.length > 1 && isBareSignature(text.slice(last.start, last.end));
  if (bareName) spans.pop();
  const inside = (p: { start: number; end: number }) => sentences.filter((s) => s.start >= p.start && s.start < p.end);
  const paragraphs = spans.map((p) => inside(p).length);
  const words = spans.reduce((n, p) => n + countWords(text.slice(p.start, p.end)), 0);
  const problems: ShapeProblem[] = [];
  if (guide !== undefined) {
    const { words: range, paragraphs: per } = guide.shape;
    if (words < range.min) problems.push({ kind: 'too-short', message: `${words} words; the channel wants ${range.min} to ${range.max}` });
    if (words > range.max) problems.push({ kind: 'too-long', message: `${words} words; the channel wants ${range.min} to ${range.max}` });
    if (paragraphs.length > per.max) problems.push({ kind: 'too-many-paragraphs', message: `${paragraphs.length} paragraphs; the channel wants at most ${per.max}` });
    paragraphs.forEach((n, i) => {
      if (n > per.maxSentences) problems.push({ kind: 'long-paragraph', message: `paragraph ${i + 1} has ${n} sentences; the channel wants at most ${per.maxSentences}` });
    });
  }
  return {
    bodySentenceIds: spans.flatMap((p) => inside(p).map((x) => x.id)),
    words,
    paragraphs,
    greeting: parts.some((p) => p.part === 'greeting'),
    signature: bareName || parts.some((p) => p.part === 'signature'),
    guide: guide?.id ?? null,
    problems,
  };
}

/** The shape as data lines for a prompt. */
export function shapeLines(s: Shape): string[] {
  const per = s.paragraphs.length === 0 ? '' : `, with ${s.paragraphs.length === 1 ? String(s.paragraphs[0]) : `${s.paragraphs.slice(0, -1).join(', ')} and ${String(s.paragraphs.at(-1))}`} sentences`;
  return [
    `words in the body: ${s.words}`,
    `paragraphs: ${s.paragraphs.length}${per}`,
    `greeting: ${s.greeting ? 'yes' : 'no'}; signature: ${s.signature ? 'yes' : 'no'}`,
    ...(s.problems.length === 0 ? [s.guide === null ? 'outside the guide: nothing to measure against' : 'outside the guide: nothing'] : s.problems.map((p) => `outside the guide: ${p.message}`)),
  ];
}
