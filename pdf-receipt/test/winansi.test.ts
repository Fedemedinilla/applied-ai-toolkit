import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import { isWinAnsi, toWinAnsiLine, toWinAnsiParagraphs } from '../src/index.ts';

const fonts: PDFFont[] = await (async () => {
  const doc = await PDFDocument.create();
  return [await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold)];
})();

const line = (s: string) => toWinAnsiLine(s);

describe('toWinAnsiLine', () => {
  it('keeps ASCII, Latin-1 accents and the CP1252 extras', () => {
    const s = 'Ñandú café "x" 50% € – — … ‘a’ “b” • ™ Œ œ Ÿ';
    expect(line(s)).toEqual({ text: s, dropped: 0 });
  });

  it('composes the separate accents some phone keyboards send (NFD to NFC)', () => {
    expect(line('cafe\u0301 an\u0303o').text).toBe('café año');
  });

  it('drops emoji and counts them, including skin tones and ZWJ families', () => {
    expect(line('Torta 😀 ★ de 🍓')).toEqual({ text: 'Torta de', dropped: 3 });
    // The modifier and the joiners are invisible on their own and not counted; the faces are.
    expect(line('👍🏽 ok')).toEqual({ text: 'ok', dropped: 2 });
    expect(line('a👨\u200D👩\u200D👧b')).toEqual({ text: 'ab', dropped: 3 });
  });

  it('drops CJK, Arabic and Hebrew script, which the standard fonts have no glyphs for', () => {
    expect(line('Pavlova 中文')).toEqual({ text: 'Pavlova', dropped: 2 });
    expect(line('شاي tea')).toEqual({ text: 'tea', dropped: 3 });
    expect(line('תה tea')).toEqual({ text: 'tea', dropped: 2 });
  });

  it('removes bidi overrides and zero-width characters silently, without reordering anything', () => {
    // U+202E would display "fed" backwards in a viewer that honours it. It is gone, and the
    // letters keep their logical order.
    expect(line('abc\u202Edef\u202C')).toEqual({ text: 'abcdef', dropped: 0 });
    expect(line('Ma\u200Bce\u200Cta\u2060\uFEFF')).toEqual({ text: 'Maceta', dropped: 0 });
    expect(line('\u200F\u200E\u2066x\u2069')).toEqual({ text: 'x', dropped: 0 });
  });

  it('maps typographic stand-ins with an exact ASCII equivalent', () => {
    expect(line('− 10% ‐ a‑b 5′ 6″ 1⁄2').text).toBe("- 10% - a-b 5' 6\" 1/2");
    expect(line('8 000 a b c　d').text).toBe('8 000 a b c d');
  });

  it('tries NFKC, then the base letter without its marks, before dropping', () => {
    expect(line('ＡＢＣ１２ ﬁn ①').text).toBe('ABC12 fin 1');
    expect(line('Győr Ștefan ţ').text).toBe('Gyor Stefan t');
    // Ł has no decomposition, so it is dropped; ź keeps its base letter.
    expect(line('Łódź')).toEqual({ text: 'ódz', dropped: 1 });
  });

  it('turns line breaks into a visible separator and collapses spaces', () => {
    expect(line('uno\r\ndos\nTRES\u2028cuatro').text).toBe('uno · dos · TRES · cuatro');
    expect(line('  a \t\t b  \n\n  c ').text).toBe('a b · c');
  });

  it('drops control characters, lone surrogates and the soft hyphen', () => {
    expect(line('a\u0000b\u0007c\u007Fd\u0085e\u009Ff').text).toBe('abcd · ef');
    expect(line('x\uD800y\uDFFFz').text).toBe('xyz');
    expect(line('para\u00ADguas').text).toBe('paraguas');
  });

  it('returns encodable text for any string (fast-check over all of Unicode)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (s) => {
        const { text } = line(s);
        expect(isWinAnsi(text)).toBe(true);
        for (const font of fonts) {
          expect(() => font.encodeText(text)).not.toThrow();
          expect(Number.isFinite(font.widthOfTextAtSize(text, 10))).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('accepts every character it calls WinAnsi, all 217 of them', () => {
    const all: string[] = [];
    for (let c = 0; c <= 0xffff; c++) if (isWinAnsi(String.fromCharCode(c))) all.push(String.fromCharCode(c));
    expect(all).toHaveLength(95 + 95 + 27);
    for (const font of fonts) expect(() => font.encodeText(all.join(''))).not.toThrow();
  });
});

describe('toWinAnsiParagraphs', () => {
  it('splits on line breaks, keeps inner blank paragraphs and trims outer ones', () => {
    expect(toWinAnsiParagraphs('\n\nuno\n\ndos 😀\n\n')).toEqual({ paragraphs: ['uno', '', 'dos'], dropped: 1 });
  });
});
