// Measuring, clipping and wrapping text that has already been through winansi.ts. Every input
// here is WinAnsi, so each UTF-16 unit is one character and slicing never splits one.

/** The part of pdf-lib's PDFFont used here, so the functions can be tested with any font. */
export interface Measure {
  widthOfTextAtSize(text: string, size: number): number;
}

const ELLIPSIS = '\u2026';

/**
 * No glyph of the standard Helvetica faces is narrower than 0.1 em, so a prefix longer than
 * maxWidth / (0.1 * size) characters cannot fit. Searches start below that bound, which keeps a
 * 10,000-character name from being measured whole at every step.
 */
function maxChars(maxWidth: number, size: number, length: number): number {
  return Math.min(length, Math.ceil(maxWidth / (size * 0.1)) + 1);
}

/** The longest prefix length n of `text` for which `fits(text.slice(0, n))` holds; 0 when none. */
function longestPrefix(text: string, hi: number, fits: (prefix: string) => boolean): number {
  let lo = 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(text.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Clipped {
  readonly text: string;
  readonly clipped: boolean;
}

/** `text` if it fits in `maxWidth`, otherwise its longest prefix that fits followed by an ellipsis. */
export function clip(font: Measure, text: string, size: number, maxWidth: number): Clipped {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return { text, clipped: false };
  const n = longestPrefix(
    text,
    maxChars(maxWidth, size, text.length),
    (p) => font.widthOfTextAtSize(p.trimEnd() + ELLIPSIS, size) <= maxWidth,
  );
  if (n === 0) return { text: font.widthOfTextAtSize(ELLIPSIS, size) <= maxWidth ? ELLIPSIS : '', clipped: true };
  return { text: text.slice(0, n).trimEnd() + ELLIPSIS, clipped: true };
}

export interface Wrapped {
  readonly lines: string[];
  readonly clipped: boolean;
}

/**
 * Word wrap at `maxWidth`. A word wider than a whole line is broken where it stops fitting, so a
 * long reference or URL is never lost. With `maxLines`, the last allowed line takes everything
 * left over and is clipped with an ellipsis. Always returns at least one line ('' for no text).
 */
export function wrap(font: Measure, text: string, size: number, maxWidth: number, maxLines = Infinity): Wrapped {
  const words = text.split(' ').filter((w) => w.length > 0);
  const lines: string[] = [];
  const fits = (s: string): boolean => font.widthOfTextAtSize(s, size) <= maxWidth;
  let current = '';
  let i = 0;
  while (i < words.length) {
    if (lines.length === maxLines - 1) {
      const rest = [current, ...words.slice(i)].filter((w) => w.length > 0).join(' ');
      const last = clip(font, rest, size, maxWidth);
      lines.push(last.text);
      return { lines, clipped: last.clipped };
    }
    const word = words[i] ?? '';
    const candidate = current ? `${current} ${word}` : word;
    if (fits(candidate)) {
      current = candidate;
      i++;
    } else if (current) {
      lines.push(current);
      current = '';
    } else {
      // A single word wider than the line: break it. At least one character goes on each line,
      // so the loop always advances even when the width is smaller than one glyph.
      const n = Math.max(1, longestPrefix(word, maxChars(maxWidth, size, word.length), fits));
      lines.push(word.slice(0, n));
      words[i] = word.slice(n);
      if (words[i] === '') i++;
    }
  }
  if (current) lines.push(current);
  return { lines: lines.length > 0 ? lines : [''], clipped: false };
}

/**
 * The font size at which `text` fits in `maxWidth`: `size` when it already fits, otherwise the
 * size that makes it exactly that wide. Glyph widths scale linearly with size, so one
 * measurement is enough.
 */
export function fitSize(font: Measure, text: string, size: number, maxWidth: number): number {
  const width = font.widthOfTextAtSize(text, size);
  return width <= maxWidth ? size : (size * maxWidth) / width;
}
