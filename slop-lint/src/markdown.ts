import { splitSentences, type Span } from './text.ts';

/**
 * A block of a Markdown document, by the offsets of its first and last character.
 * A paragraph is running prose; a list item, a heading and a quote are not.
 */
export interface Block {
  kind: 'paragraph' | 'list' | 'heading' | 'quote';
  start: number;
  end: number;
}

export interface MarkdownView {
  /**
   * The input with every removed span replaced by spaces. Newlines are kept, so the
   * text has the same length and every offset, line and column of the input.
   */
  text: string;
  blocks: Block[];
  /** Offsets of the inline code spans that were masked, as [start, end). */
  code: Array<[number, number]>;
}

export const DISABLE = 'slop-lint-disable';
export const ENABLE = 'slop-lint-enable';
export const DISABLE_NEXT_LINE = 'slop-lint-disable-next-line';

const FENCE = /^[ \t]*(`{3,}|~{3,})/u;
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/u;
const HEADING = /^ {0,3}#{1,6}(?=[ \t]|$)[ \t]*/u;
const HEADING_CLOSE = /[ \t]+#+[ \t]*$/u;
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/u;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u;
const QUOTE = /^(?:[ \t]*>[ \t]?)+/u;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?(?=[ \t]|$)[ \t]*/u;
const LINK_DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]*\S.*$/u;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/gu;
const INLINE_HTML = /<\/?[a-z][a-z0-9-]*(?:\s[^<>\n]*)?\/?>|<(?:https?|mailto):[^<>\s]+>/gu;
const IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/gu;
const LINK = /\[([^\]\n]+)\](\([^)\n]*\)|\[[^\]\n]*\])/gu;
const EMPHASIS = /\*\*|__|(?<![\p{L}\p{N}*\\])\*(?=[^\s*])|(?<=[^\s*\\])\*(?![\p{L}\p{N}*])|(?<![\p{L}\p{N}_\\])_(?=[^\s_])|(?<=[^\s_\\])_(?![\p{L}\p{N}_])/gu;
const ESCAPE = /\\(?=[!-/:-@[-`{-~])/gu;

interface Line {
  start: number;
  /** Offset of the line's last character plus one, before the newline. */
  end: number;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      lines.push({ start, end: i });
      start = i + 1;
    }
  }
  return lines;
}

/**
 * Prepares a Markdown document for lint(). Fenced code blocks, tables, HTML comments,
 * inline HTML, inline code, images, link URLs (the link text stays), emphasis markers
 * and heading, quote and list markers are replaced by spaces. So is everything between
 * <!-- slop-lint-disable --> and <!-- slop-lint-enable -->, or to the end of the file
 * when the enable is missing, and the line after <!-- slop-lint-disable-next-line -->.
 * Directives inside a code block are code, not directives.
 *
 * Indented code blocks are not recognized: a four-space indent is far more often a
 * list item's continuation in these documents, and reading it as code would hide prose.
 */
export function maskMarkdown(source: string): MarkdownView {
  const out = source.split('');
  const mask = (start: number, end: number): void => {
    for (let i = start; i < end; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  const current = (): string => out.join('');
  const lines = splitLines(source);
  const lineText = (l: Line): string => out.slice(l.start, l.end).join('');

  // Fenced code blocks: the fences and everything between them. An unclosed fence runs to the end.
  let fence: string | null = null;
  for (const line of lines) {
    const t = lineText(line);
    if (fence !== null) {
      mask(line.start, line.end);
      const close = FENCE.exec(t);
      if (close && close[1]?.[0] === fence[0] && (close[1]?.length ?? 0) >= fence.length && t.trim() === close[1]) fence = null;
      continue;
    }
    const open = FENCE.exec(t);
    if (open?.[1]) {
      fence = open[1];
      mask(line.start, line.end);
    }
  }

  // HTML comments, read as directives first. A directive ends at the comment's end.
  const lineIndexAt = (offset: number): number => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lines[mid]?.start ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  let disabledFrom: number | null = null;
  const regions: Array<[number, number]> = [];
  for (const m of current().matchAll(HTML_COMMENT)) {
    const end = m.index + m[0].length;
    const body = m[0].replace(/^<!--|-->$/gu, '').trim();
    if (body === DISABLE && disabledFrom === null) disabledFrom = end;
    else if (body === ENABLE && disabledFrom !== null) {
      regions.push([disabledFrom, m.index]);
      disabledFrom = null;
    } else if (body === DISABLE_NEXT_LINE) {
      const next = lines[lineIndexAt(end) + 1];
      if (next) regions.push([next.start, next.end]);
    }
    regions.push([m.index, end]);
  }
  if (disabledFrom !== null) regions.push([disabledFrom, source.length]);
  for (const [a, b] of regions) mask(a, b);

  // Tables: a row with a pipe, a delimiter row, and the rows with pipes that follow.
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = lines[i];
    const delimiter = lines[i + 1];
    if (!head || !delimiter) continue;
    const t = lineText(delimiter);
    if (!lineText(head).includes('|') || !t.includes('-') || !TABLE_DELIMITER.test(t) || !/\|/u.test(t + lineText(head))) continue;
    let j = i;
    while (j < lines.length) {
      const row = lines[j];
      if (!row || !lineText(row).includes('|') || lineText(row).trim() === '') break;
      mask(row.start, row.end);
      j++;
    }
    i = j - 1;
  }

  // Block markers. kinds[i] is what line i starts, or null when it continues the block above.
  const kinds: Array<Block['kind'] | 'blank' | null> = [];
  let previous: Block['kind'] | 'blank' = 'blank';
  let previousIndent = 0;
  for (const line of lines) {
    let t = lineText(line);
    if (t.trim() === '') {
      kinds.push('blank');
      previous = 'blank';
      continue;
    }
    if (LINK_DEFINITION.test(t) || THEMATIC_BREAK.test(t) || (previous !== 'blank' && SETEXT.test(t))) {
      mask(line.start, line.end);
      kinds.push('blank');
      previous = 'blank';
      continue;
    }
    let kind: Block['kind'] | null = null;
    const quote = QUOTE.exec(t);
    if (quote) {
      mask(line.start, line.start + quote[0].length);
      kind = previous === 'quote' ? null : 'quote';
      t = lineText(line);
    }
    const heading = HEADING.exec(t);
    const item = LIST_ITEM.exec(t);
    if (heading) {
      mask(line.start, line.start + heading[0].length);
      const close = HEADING_CLOSE.exec(lineText(line));
      if (close) mask(line.start + close.index, line.end);
      kind = 'heading';
    } else if (item) {
      mask(line.start, line.start + item[0].length);
      kind = 'list';
      previousIndent = /^[ \t]*/u.exec(t)?.[0].length ?? 0;
    } else if (kind === null && previous === 'heading') {
      kind = 'paragraph';
    } else if (kind === null && previous === 'blank') {
      // After a blank line, an indented line continues the list item above it.
      const indent = /^[ \t]*/u.exec(t)?.[0].length ?? 0;
      const lastStart = [...kinds].reverse().find((k) => k !== null && k !== 'blank');
      kind = lastStart === 'list' && indent > previousIndent ? 'list' : 'paragraph';
    }
    kinds.push(kind);
    if (kind !== null) previous = kind;
  }

  // Inline spans, in an order where an earlier one hides what a later one would match.
  const maskAll = (re: RegExp): void => {
    for (const m of current().matchAll(re)) mask(m.index, m.index + m[0].length);
  };
  const code = maskInlineCode(current(), mask);
  maskAll(INLINE_HTML);
  maskAll(IMAGE);
  for (const m of current().matchAll(LINK)) {
    const label = m[1] ?? '';
    mask(m.index, m.index + 1);
    mask(m.index + 1 + label.length, m.index + m[0].length);
  }
  maskAll(EMPHASIS);
  maskAll(ESCAPE);

  const text = current();
  const blocks: Block[] = [];
  lines.forEach((line, i) => {
    const kind = kinds[i];
    if (kind === 'blank') return;
    if (kind === null && blocks.length > 0 && kinds[i - 1] !== 'blank') {
      const last = blocks[blocks.length - 1];
      if (last) last.end = line.end;
      return;
    }
    // A line after a blank that is not a continuation opens a paragraph (kind null only follows a block).
    blocks.push({ kind: kind ?? 'paragraph', start: line.start, end: line.end });
  });
  return { text, blocks: blocks.filter((b) => text.slice(b.start, b.end).trim() !== ''), code };
}

/** Code spans: a run of backticks up to the next run of the same length, on any line of the paragraph. */
function maskInlineCode(text: string, mask: (start: number, end: number) => void): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const runs = [...text.matchAll(/`+/gu)];
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i];
    if (!open) continue;
    const close = runs.slice(i + 1).find((r) => r[0].length === open[0].length);
    if (!close) continue;
    if (/\n[ \t]*\n/u.test(text.slice(open.index, close.index))) continue;
    mask(open.index, close.index + close[0].length);
    spans.push([open.index, close.index + close[0].length]);
    i = runs.indexOf(close);
  }
  return spans;
}

/**
 * Sentences of a masked document, split block by block, so a sentence never runs from
 * one list item, heading or paragraph into the next. In plain text a line that starts
 * in lowercase continues the sentence above it; in a list, that is the next item.
 *
 * A sentence that opens with inline code ("It runs. `lint` is pure.") would otherwise
 * be glued to the one before it: the code is masked, and the first word left is
 * lowercase. So a sentence also ends at terminal punctuation followed by a code span.
 */
export function blockSentences(view: MarkdownView): Span[] {
  const out: Span[] = [];
  const push = (start: number, end: number): void => {
    while (start < end && /\s/u.test(view.text[start] ?? '')) start++;
    while (end > start && /\s/u.test(view.text[end - 1] ?? '')) end--;
    if (start < end) out.push({ start, end, text: view.text.slice(start, end) });
  };
  for (const b of view.blocks) {
    for (const s of splitSentences(view.text.slice(b.start, b.end))) {
      let start = s.start + b.start;
      const end = s.end + b.start;
      for (const [codeStart] of view.code) {
        if (codeStart <= start || codeStart >= end) continue;
        const before = view.text.slice(start, codeStart);
        if (/[.!?…]["”’»)]*\s+$/u.test(before)) {
          push(start, codeStart);
          start = codeStart;
        }
      }
      push(start, end);
    }
  }
  return out;
}
