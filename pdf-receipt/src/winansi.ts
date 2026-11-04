// The standard PDF fonts (Helvetica and the other thirteen) encode text as WinAnsi, which is
// Windows code page 1252. pdf-lib throws "WinAnsi cannot encode" on any character outside it, so
// one emoji in a customer name would stop the whole document. Every string goes through here
// before it is measured or drawn, and what comes out is guaranteed to encode.
//
// Per code point, after NFC (which composes the separate accents some phone keyboards send):
//   1. Printable ASCII, Latin-1 and the 27 extra CP1252 characters are kept.
//   2. Typographic stand-ins with an exact ASCII equivalent are mapped (minus sign, odd spaces,
//      non-breaking hyphen, primes).
//   3. Otherwise NFKC is tried ("Ａ" to "A", "ﬁ" to "fi"), then NFD with the combining marks
//      removed ("ő" to "o", "ș" to "s"). The first result that encodes is used.
//   4. Anything else is dropped. Format characters and combining marks (zero-width joiners,
//      bidi overrides, variation selectors) are dropped silently; a dropped visible character is
//      counted so the caller can say that something was removed.

/** The CP1252 characters in 0x80 to 0x9F, the ones WinAnsi adds to Latin-1. */
const CP1252_EXTRAS = new Set(
  '\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D' +
    '\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178',
);

const SOFT_HYPHEN = 0xad;

/** Characters outside WinAnsi with an exact stand-in inside it. */
const STAND_INS: ReadonlyMap<string, string> = new Map([
  ['\u2212', '-'], // minus sign
  ['\u2010', '-'], // hyphen
  ['\u2011', '-'], // non-breaking hyphen
  ['\u2012', '-'], // figure dash
  ['\u2015', '-'], // horizontal bar
  ['\u2032', "'"], // prime
  ['\u2033', '"'], // double prime
  ['\u2044', '/'], // fraction slash
  ['\t', ' '],
  ...[0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000].map(
    (c): [string, string] => [String.fromCharCode(c), ' '],
  ),
]);

const LINE_BREAK = /\r\n|[\r\n\f\v\u0085\u2028\u2029]/u;
const SILENT = /^[\p{M}\p{Cf}\p{Cc}\p{Cs}]$/u;
const MARKS = /\p{M}/gu;

/** True when every UTF-16 unit of `s` is a character WinAnsi encodes and the fonts can draw. */
export function isWinAnsi(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) continue;
    if (c >= 0xa0 && c <= 0xff && c !== SOFT_HYPHEN) continue;
    if (CP1252_EXTRAS.has(s.charAt(i))) continue;
    return false;
  }
  return true;
}

export interface Sanitized {
  readonly text: string;
  /** Visible characters that had no WinAnsi form and were removed. */
  readonly dropped: number;
}

function sanitizeRun(run: string): Sanitized {
  let out = '';
  let dropped = 0;
  for (const ch of run) {
    if (isWinAnsi(ch)) {
      out += ch;
      continue;
    }
    const standIn = STAND_INS.get(ch);
    if (standIn !== undefined) {
      out += standIn;
      continue;
    }
    const compat = ch.normalize('NFKC');
    if (compat !== ch && compat.length > 0 && isWinAnsi(compat)) {
      out += compat;
      continue;
    }
    const bare = ch.normalize('NFD').replace(MARKS, '');
    if (bare !== ch && bare.length > 0 && isWinAnsi(bare)) {
      out += bare;
      continue;
    }
    if (!SILENT.test(ch)) dropped++;
  }
  return { text: out.replace(/ {2,}/g, ' ').trim(), dropped };
}

/**
 * One line of text, safe to draw. Line breaks become `separator` (" · " by default), so a
 * multi-line value pasted into a one-line field still reads as separate parts.
 */
export function toWinAnsiLine(value: string, separator = ' \u00B7 '): Sanitized {
  const parts = value.normalize('NFC').split(LINE_BREAK).map(sanitizeRun);
  const text = parts
    .map((p) => p.text)
    .filter((t) => t.length > 0)
    .join(separator);
  return { text, dropped: parts.reduce((n, p) => n + p.dropped, 0) };
}

/** Paragraphs of text, safe to draw, split on line breaks. Empty paragraphs are kept as ''. */
export function toWinAnsiParagraphs(value: string): { paragraphs: string[]; dropped: number } {
  const parts = value.normalize('NFC').split(LINE_BREAK).map(sanitizeRun);
  const paragraphs = parts.map((p) => p.text);
  while (paragraphs.length > 0 && paragraphs[paragraphs.length - 1] === '') paragraphs.pop();
  while (paragraphs.length > 0 && paragraphs[0] === '') paragraphs.shift();
  return { paragraphs, dropped: parts.reduce((n, p) => n + p.dropped, 0) };
}
