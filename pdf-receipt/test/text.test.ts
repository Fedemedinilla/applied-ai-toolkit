import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { isWinAnsi } from '../src/index.ts';
import { clip, fitSize, wrap } from '../src/text.ts';

const doc = await PDFDocument.create();
const regular = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const width = (s: string, size = 10) => regular.widthOfTextAtSize(s, size);

/** Helvetica, counting how often and how much text is measured. */
function counting() {
  const font = {
    calls: 0,
    characters: 0,
    longestAfterFirst: 0,
    widthOfTextAtSize(text: string, size: number): number {
      if (font.calls > 0) font.longestAfterFirst = Math.max(font.longestAfterFirst, text.length);
      font.calls++;
      font.characters += text.length;
      return regular.widthOfTextAtSize(text, size);
    },
  };
  return font;
}

describe('the 0.1 em bound behind the search limits', () => {
  it('holds for every WinAnsi character in both faces', () => {
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      if (!isWinAnsi(ch) || ch === ' ' || ch === ' ') continue;
      expect(regular.widthOfTextAtSize(ch, 1), ch).toBeGreaterThanOrEqual(0.1);
      expect(bold.widthOfTextAtSize(ch, 1), ch).toBeGreaterThanOrEqual(0.1);
    }
  });
});

describe('clip', () => {
  it('leaves text that fits alone', () => {
    expect(clip(regular, 'Maceta', 10, 100)).toEqual({ text: 'Maceta', clipped: false });
  });

  it('cuts to the longest prefix that fits with an ellipsis, without a space before it', () => {
    const c = clip(regular, 'Maceta de barro grande', 10, width('Maceta de…'));
    expect(c).toEqual({ text: 'Maceta de…', clipped: true });
    const tight = clip(regular, 'Maceta de barro grande', 10, width('Maceta d…') + 0.5);
    expect(tight.text).toBe('Maceta d…');
  });

  it('clips a 10,000-character word with a bounded number of measurements', () => {
    const font = counting();
    const c = clip(font, 'x'.repeat(10_000), 10, 200);
    // One measurement of the whole word, then a binary search over at most 200 / (0.1 * 10) + 1
    // characters, and one more for the ellipsis alone at most.
    expect(font.calls).toBeLessThanOrEqual(Math.ceil(Math.log2(201)) + 2);
    expect(font.longestAfterFirst).toBeLessThanOrEqual(202);
    expect(width(c.text)).toBeLessThanOrEqual(200);
    expect(c.text.endsWith('…')).toBe(true);
  });

  it('returns an ellipsis or nothing when even one character does not fit', () => {
    expect(clip(regular, 'Maceta', 10, width('…'))).toEqual({ text: '…', clipped: true });
    expect(clip(regular, 'Maceta', 10, 1)).toEqual({ text: '', clipped: true });
  });
});

describe('wrap', () => {
  it('breaks between words and keeps every word', () => {
    const w = wrap(regular, 'sin frutos secos por alergia, tocar el timbre B', 10, 90);
    expect(w.clipped).toBe(false);
    expect(w.lines.join(' ')).toBe('sin frutos secos por alergia, tocar el timbre B');
    for (const l of w.lines) expect(width(l)).toBeLessThanOrEqual(90);
    expect(w.lines.length).toBeGreaterThan(1);
  });

  it('breaks a word wider than the line instead of losing it', () => {
    const ref = 'https://pedidos.example/seguimiento/ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const w = wrap(regular, ref, 10, 80);
    expect(w.lines.join('')).toBe(ref);
    for (const l of w.lines) expect(width(l)).toBeLessThanOrEqual(80);
  });

  it('clips the last allowed line and says so', () => {
    const w = wrap(regular, 'uno dos tres cuatro cinco seis siete ocho nueve diez', 10, 40, 2);
    expect(w.lines).toHaveLength(2);
    expect(w.clipped).toBe(true);
    expect(w.lines[1]?.endsWith('…')).toBe(true);
    expect(width(w.lines[1] ?? '')).toBeLessThanOrEqual(40);
  });

  it('wraps 10,000 characters of prose to three lines without measuring the rest repeatedly', () => {
    const font = counting();
    const w = wrap(font, 'palabra '.repeat(1250), 10, 215, 3);
    // Word by word for two lines, then the rest is measured whole once and clipped by binary
    // search. Measuring the 10,000-character rest at every step would pass 100,000 characters.
    expect(font.calls).toBeLessThan(40);
    expect(font.characters).toBeLessThan(2 * 10_000);
    expect(w.lines).toHaveLength(3);
    expect(w.clipped).toBe(true);
  });

  it('always advances, even when no glyph fits the width', () => {
    expect(wrap(regular, 'abc', 10, 0.5).lines).toEqual(['a', 'b', 'c']);
  });

  it('returns one empty line for empty text', () => {
    expect(wrap(regular, '', 10, 100)).toEqual({ lines: [''], clipped: false });
  });
});

describe('fitSize', () => {
  it('keeps the size when the text fits and scales it exactly when it does not', () => {
    expect(fitSize(bold, '$1.234.567', 15, 80)).toBe(15);
    const size = fitSize(bold, '$148.000,50', 15, 80);
    expect(size).toBeLessThan(15);
    expect(bold.widthOfTextAtSize('$148.000,50', size)).toBeCloseTo(80, 6);
  });
});
