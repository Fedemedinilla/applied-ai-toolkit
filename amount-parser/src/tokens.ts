// From raw text to number tokens: normalize, spell commas out, split into words, fold numbers.
// Every token remembers which raw words it covers, so a result can point back at the input.

import { readWordNumber, parseNumber } from './numbers.ts';
import { COUNT_NOUNS, NUMBER_WORDS, PACK_SIZES } from './vocabulary.ts';

/** Lower case, no accents, single spaces. "GASTÉ 20  MIL" and "gaste 20 mil" are the same string. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    // NFD splits the letter from its accent; this drops the accent. `\s` already covers the
    // non-breaking space.
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * A comma between two things is the conjunction of an enumeration: it is what a voice transcription
 * writes when somebody lists what they paid, and the summing rule hangs off the word "y". So the
 * comma is spelled out as " y " here, rather than emitted as a token, which would shift every rule
 * that reads the next or previous word. A comma between two digits is a decimal separator and stays.
 *
 * Written without a lookbehind on purpose: Safari before 16.4 rejects a lookbehind when it parses
 * the file, and then no line of the module runs. The first branch consumes the digit in front of a
 * comma that also has a digit after it and gives the pair back untouched; every other comma falls to
 * the second branch.
 */
export function spellOutCommas(clean: string): string {
  return clean.replace(/(\d),(?=\d)|,/gu, (m: string, d: string | undefined) => (d ? m : ' y '));
}

const TOKEN = /\$|%|[a-z]+\/[a-z]+|[a-z]+|\d[\d.,]*/gu;

/** A word of the prepared sentence, with its position in that string. */
export interface RawWord {
  text: string;
  start: number;
  end: number;
}

export function splitWords(listed: string): RawWord[] {
  return [...listed.matchAll(TOKEN)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
}

/**
 * Maps positions in the prepared sentence back to the caller's text. Built alongside `normalize`
 * and `spellOutCommas` and checked against them; when the rebuilt string differs (an exotic Unicode
 * sequence), there is no map and results carry no spans. The parse itself never depends on it.
 */
export interface OffsetMap {
  /** For each code unit of the prepared sentence, the [start, end) it came from in the input. */
  start: readonly number[];
  end: readonly number[];
}

export function buildOffsetMap(text: string, clean: string, listed: string): OffsetMap | null {
  // normalize, one input code point at a time
  const chars: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const ch of text) {
    const piece = ch.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    for (const unit of piece.split('')) {
      chars.push(unit);
      from.push(at);
      to.push(at + ch.length);
    }
    at += ch.length;
  }

  // collapse whitespace runs into one space, then trim
  const c2: string[] = [];
  const f2: number[] = [];
  const t2: number[] = [];
  for (let k = 0; k < chars.length; k++) {
    const isSpace = /\s/u.test(chars[k]!);
    if (isSpace && c2[c2.length - 1] === ' ') {
      t2[t2.length - 1] = to[k]!;
      continue;
    }
    c2.push(isSpace ? ' ' : chars[k]!);
    f2.push(from[k]!);
    t2.push(to[k]!);
  }
  let lo = 0;
  let hi = c2.length;
  if (c2[lo] === ' ') lo++;
  if (hi > lo && c2[hi - 1] === ' ') hi--;
  if (c2.slice(lo, hi).join('') !== clean) return null;
  const cf = f2.slice(lo, hi);
  const ct = t2.slice(lo, hi);

  // spell out commas the way spellOutCommas does
  const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
  const out: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  for (let k = 0; k < clean.length; k++) {
    const c = clean[k]!;
    const replaced = c === ',' && !(isDigit(clean[k - 1]) && isDigit(clean[k + 1]));
    for (const unit of replaced ? ' y ' : c) {
      out.push(unit);
      start.push(cf[k]!);
      end.push(ct[k]!);
    }
  }
  if (out.join('') !== listed) return null;
  return { start, end };
}

export interface Token {
  /** The first raw word of the token. */
  text: string;
  /** Raw words [from, to) this token covers. */
  from: number;
  to: number;
  /** Set on number tokens. */
  value?: number;
  literal?: string;
  fromWords?: boolean;
  /** A scale word ("mil", "lucas") was folded into the value. */
  scaled?: boolean;
  /** Which scale, so "dos palos y medio" adds half a palo and not half of two palos. */
  scaleUsed?: number | undefined;
  /** "y pico" / "y monedas" followed it. */
  approximate?: boolean | undefined;
}

export function isNumber(t: Token | undefined): boolean {
  return Boolean(t && t.value !== undefined);
}

/**
 * Collapses raw words into number tokens with their scale applied, so that "veinte mil",
 * "20 mil", "20k", "medio palo" and "dos palos y medio" are each one token with a value.
 */
export function foldNumbers(raw: readonly string[], scales: Readonly<Record<string, number>>): Token[] {
  const out: Token[] = [];
  let i = 0;

  while (i < raw.length) {
    const t = raw[i]!;
    const from = i;

    // "medio palo": half of the scale that follows.
    if (t === 'medio' || t === 'media') {
      const scale = scales[raw[i + 1] ?? ''];
      if (scale !== undefined) {
        out.push({ text: t, from, to: i + 2, value: scale / 2, literal: `${t} ${raw[i + 1]}`, scaled: true, scaleUsed: scale });
        i += 2;
        continue;
      }
    }

    let value: number | null = null;
    let literal = t;
    let fromWords = false;
    let consumed = 1;
    let wordScale = 1;

    if (/^\d/u.test(t)) {
      value = parseNumber(t);
    } else if (NUMBER_WORDS[t] !== undefined || scales[t] !== undefined) {
      const words = readWordNumber(raw, i, scales);
      if (words) {
        value = words.value;
        literal = raw.slice(i, i + words.consumed).join(' ');
        fromWords = true;
        consumed = words.consumed;
        wordScale = words.lastScale;
      }
    }

    if (value === null) {
      out.push({ text: t, from, to: i + 1 });
      i += 1;
      continue;
    }

    const token: Token = {
      text: t,
      from,
      to: from,
      value,
      literal,
      fromWords,
      scaled: fromWords && value >= 1000,
      scaleUsed: fromWords ? wordScale : undefined,
    };
    i += consumed;

    // A scale word right after the digits: "20 mil", "20 k", "2 palos".
    const scale = scales[raw[i] ?? ''];
    if (scale !== undefined && !token.scaled) {
      token.value = value * scale;
      token.literal = `${literal} ${raw[i]}`;
      token.scaled = true;
      token.scaleUsed = scale;
      i += 1;
    } else if (raw[i] === '1000' || raw[i] === '1000000') {
      // A transcriber writing "mil" as digits mid-number: "gaste sesenta 1000 en el mayorista".
      if (token.fromWords) {
        token.value = value * Number(raw[i]);
        token.literal = `${literal} ${raw[i]}`;
        token.scaled = true;
        i += 1;
      }
    }

    // "2 kilos y medio": the half sits after the unit noun, so it has to be reached across it.
    // Without this, two and a half kilos become two.
    if (
      raw[i] !== undefined &&
      COUNT_NOUNS.has(raw[i]!) &&
      raw[i + 1] === 'y' &&
      (raw[i + 2] === 'medio' || raw[i + 2] === 'media')
    ) {
      token.value = token.value! + 0.5;
      token.literal = `${token.literal} ${raw[i]} y medio`;
      i += 3;
      token.to = i;
      out.push(token);
      continue;
    }

    // "y medio" / "y pico" / "y monedas" riding on the number.
    if (raw[i] === 'y' && (raw[i + 1] === 'medio' || raw[i + 1] === 'media')) {
      // "dos palos y medio" is two and a half palos, not one and a half times two palos.
      token.value = token.value! + (token.scaleUsed ?? 1) / 2;
      token.literal = `${token.literal} y medio`;
      i += 2;
    } else if (raw[i] === 'y' && (raw[i + 1] === 'pico' || raw[i + 1] === 'monedas')) {
      token.approximate = true;
      token.literal = `${token.literal} y ${raw[i + 1]}`;
      i += 2;
    }

    token.to = i;
    out.push(token);
  }

  return out;
}

/**
 * "30 y pico de lucas", "un par de palos": a scale word and the count it belongs to, with something
 * in between that `foldNumbers` cannot reach across (the "y pico" that rode onto the number, or the
 * "de" of "un par de"). Left alone, the bare scale word is worth 1 x scale and outscores the count it
 * was the scale of: "se me fueron 30 y pico de lucas" came back as 1.000.
 *
 * A second pass instead of a change inside `foldNumbers`, because the shape is narrow enough to be
 * recognised from outside: a scale word that folded to exactly its own scale, with a count behind it.
 */
export function foldLooseScales(tokens: readonly Token[], scales: Readonly<Record<string, number>>): Token[] {
  const out: Token[] = [];

  for (const t of tokens) {
    const scale = scales[t.text];
    // One word, folded to exactly its own scale: a bare "lucas". Not "dos lucas", not "mil
    // quinientos", not "medio palo"; those already carry their number.
    const bare = scale !== undefined && t.fromWords === true && t.value === scale && t.literal === t.text;
    if (!bare) {
      out.push(t);
      continue;
    }

    let at = out.length - 1;
    if (out[at]?.text === 'de') at -= 1; // "30 y pico DE lucas"
    const head = out[at];
    const article = out[at - 1];

    // "un par de lucas" is two thousand: the count is the noun itself. Only this word and only
    // with its article, so that "3 docenas de ..." stays the sentence it is.
    const isPair =
      (head?.text === 'par' || head?.text === 'pares') && article?.fromWords === true && article.value === 1;
    const count = isPair ? PACK_SIZES['par']! : head?.value;

    // Nothing to fold into, or a count that already carries a scale of its own.
    if (count === undefined || (!isPair && head!.scaled === true)) {
      out.push(t);
      continue;
    }

    const eaten = out.splice(isPair ? at - 1 : at);
    out.push({
      text: eaten[0]!.text,
      from: eaten[0]!.from,
      to: t.to,
      value: count * scale,
      literal: [...eaten.map((e) => e.literal ?? e.text), t.literal ?? t.text].join(' '),
      fromWords: isPair ? true : head!.fromWords === true,
      scaled: true,
      scaleUsed: scale,
      // The "y pico" was folded onto the count, and it belongs to the number that comes out here.
      approximate: isPair ? undefined : head!.approximate,
    });
  }

  return out;
}
