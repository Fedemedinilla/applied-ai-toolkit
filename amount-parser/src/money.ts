// parseAmount: one money amount out of a sentence written or dictated in Rioplatense Spanish.
//
// The parser has three answers: a number, no amount at all, or "this sentence has two readings"
// (`ambiguous: true` with a `reason`), and then the app asks instead of guessing. "vendi 5 tortas a
// 8000" means 8.000 each as often as 8.000 for the lot, and a native speaker cannot resolve it either.
//
// The work runs as named steps, in this order. The first step that recognises its shape returns:
//
//   1. readSentence        normalize, spell commas out, split, fold numbers ("dos lucas" -> 2000)
//   2. excludedPhrases     idioms with no amount ("dos mangos"), foreign currency
//   3. applyCorrections    "gaste veinte, no, treinta mil" keeps what follows the correction
//   4. sentenceAmbiguity   ranges, tax added on, net or gross, mixed directions, discounts by %,
//                          "sin interes" instalments
//   5. classifyNumbers     drops numbers that are not money (references, dates, percentages),
//                          separates counts from prices, scores the prices, picks the best one
//   6. openRemainder       "un palo y pico": the unknown part is too large to store a floor
//   7. quantityTimesUnitPrice   "3 docenas a 12 mil la docena" -> 36000
//   8. instalments         "18 cuotas fijas de 40 mil" -> 720000
//   9. countWithoutMarker  "5 tortas a 8000": unit price or total, ask
//  10. discounts           "50 lucas menos el 10 de descuento" -> 45000; any other discount asks
//  11. half                "la mitad de los 80 mil" -> 40000
//  12. sums                "5 mil de luz y 3 mil de gas" -> 8000
//  13. singleAmount        the best-scored figure
//
// Nearly every rule is written against a literal word: "cuotas" near "de", "menos" next to
// "descuento", "mas" before "iva", "entre" for a range, "y" to add up. An adjective, a synonym, a
// comma or the other preposition can switch a rule off, and then the parser stops asking and
// returns a wrong number with full confidence. The corpus (corpus/corpus.json) holds the phrases that proved it, each with
// its control; when adding a rule, ask what one adjective would do to it.

import {
  buildOffsetMap,
  foldLooseScales,
  foldNumbers,
  isNumber,
  splitWords,
  spellOutCommas,
  normalize,
  type OffsetMap,
  type RawWord,
  type Token,
} from './tokens.ts';
import {
  BASE_SCALES,
  CONNECTORS,
  CORRECTION_MARKERS,
  COUNT_NOUNS,
  EXPENSE_VERBS,
  FOREIGN_CURRENCY,
  INCOME_VERBS,
  INSTALMENT_NOUNS,
  JOINERS,
  MONTHS,
  NEUTRAL_UNITS,
  NON_AMOUNT_IDIOMS,
  NOT_THE_MOVEMENT,
  PACK_SIZES,
  PART_OF_THE_WHOLE,
  PRICE_MARKERS,
  REFERENCE_MARKERS,
} from './vocabulary.ts';

// ── Public shape ─────────────────────────────────────────────────────────────────────────────

export type AmbiguityReason =
  | 'unit_or_total'      // "5 tortas a 8000": each, or the lot?
  | 'open_remainder'     // "un palo y pico": the remainder is material
  | 'range'              // "entre 20 y 25 mil"
  | 'discount_unclear'   // "50 mil con 20% de descuento": before or after?
  | 'tax_unclear'        // "100 mil mas iva"
  | 'mixed_directions'   // money in and money out in one sentence
  | 'net_or_gross'       // "me pagaron 100 mil pero me descontaron 10 mil"
  | 'instalments'        // "6 cuotas sin interes de 25 lucas": the item or the payment?
  | 'several_quantities' // "2 cajas de doce gaseosas a 1200 cada una"
  | 'foreign_currency';  // "20 mil dolares": readable, but not storable as the local currency

/** What a span of the input contributed to the result. */
export type SpanRole =
  | 'amount'      // the figure returned, or one of the figures summed
  | 'quantity'    // the count a unit price or an instalment was multiplied by
  | 'unit_price'  // the price of one unit or one instalment
  | 'added'       // a charge added on top: freight, a down payment
  | 'subtracted'  // a discount, as a rate or in pesos
  | 'figure';     // a number in a sentence the parser refused to resolve

export interface Span {
  /** UTF-16 offsets into the text passed to parseAmount, end exclusive. */
  start: number;
  end: number;
  /** The input text at those offsets. */
  text: string;
  role: SpanRole;
}

export interface ParsedAmount {
  /** The amount, or null when it cannot be determined safely. */
  value: number | null;
  /** The normalized text it came from, or the arithmetic that produced it ("3 x 12 mil"). */
  literal: string;
  source: 'digits' | 'words' | 'computed';
  /** When the total was computed from a count and a unit price, both are kept. */
  quantity: number | null;
  unitPrice: number | null;
  /**
   * True when the parser refuses to return a number and the app has to ask. Nearly always that is
   * because a native speaker could read the sentence two ways; `foreign_currency` is the one case
   * where the reading is clear and storing it is what cannot be done.
   */
  ambiguous: boolean;
  reason?: AmbiguityReason;
  /** "30 lucas y pico": the value is a floor, not the exact figure. */
  approximate: boolean;
  /** Where in the input the figures behind the result are. Empty when the sentence has no figure, or in the rare case that offsets cannot be mapped (see buildOffsetMap). */
  spans: Span[];
}

// ── The sentence being read ──────────────────────────────────────────────────────────────────

interface Sentence {
  text: string;
  /** Normalized text, before corrections. Undetermined results report it as their literal. */
  clean: string;
  scales: Readonly<Record<string, number>>;
  tokens: Token[];
  words: string[];
  numeric: Token[];
  raw: RawWord[];
  offsets: OffsetMap | null;
}

type Mark = readonly [Token, SpanRole];

function withTokens(s: Sentence, tokens: Token[]): Sentence {
  return { ...s, tokens, words: tokens.map((t) => t.text), numeric: tokens.filter(isNumber) };
}

function has(s: Sentence, a: string, b?: string): boolean {
  return s.words.some((w, i) => w === a && (b === undefined || s.words[i + 1] === b));
}

/** "con 10%", "10 por ciento". The callback's own index: indexOf would only ever see the first "por". */
function percentAt(words: readonly string[]): number {
  return words.findIndex((w, i) => w === '%' || (w === 'por' && words[i + 1] === 'ciento'));
}

/** True when the words between two figures join them and none says the second one never moved. */
function joinedAsOneMovement(between: readonly string[]): boolean {
  return JOINERS.some((j) => between.includes(j)) && !between.some((w) => NOT_THE_MOVEMENT.has(w));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function spanOf(s: Sentence, token: Token, role: SpanRole): Span | null {
  const first = s.raw[token.from];
  const last = s.raw[token.to - 1];
  if (!s.offsets || !first || !last) return null;
  const start = s.offsets.start[first.start];
  const end = s.offsets.end[last.end - 1];
  if (start === undefined || end === undefined) return null;
  return { start, end, text: s.text.slice(start, end), role };
}

function spansOf(s: Sentence, marks: readonly Mark[]): Span[] {
  return marks
    .map(([token, role]) => spanOf(s, token, role))
    .filter((x): x is Span => x !== null)
    .sort((a, b) => a.start - b.start);
}

function undetermined(s: Sentence, reason: AmbiguityReason, literal: string, figures = s.numeric): ParsedAmount {
  return {
    value: null,
    literal,
    source: 'digits',
    quantity: null,
    unitPrice: null,
    ambiguous: true,
    reason,
    approximate: false,
    spans: spansOf(s, figures.map((t) => [t, 'figure'] as const)),
  };
}

function computed(
  s: Sentence,
  value: number,
  literal: string,
  marks: readonly Mark[],
  extra: { quantity?: number; unitPrice?: number; approximate?: boolean } = {},
): ParsedAmount {
  return {
    value,
    literal,
    source: 'computed',
    quantity: extra.quantity ?? null,
    unitPrice: extra.unitPrice ?? null,
    ambiguous: false,
    approximate: extra.approximate ?? false,
    spans: spansOf(s, marks),
  };
}

// ── 1. Reading the sentence ──────────────────────────────────────────────────────────────────

function readSentence(text: string, clean: string, scales: Readonly<Record<string, number>>): Sentence {
  const listed = spellOutCommas(clean);
  const raw = splitWords(listed);
  const tokens = foldLooseScales(foldNumbers(raw.map((w) => w.text), scales), scales);
  const offsets = buildOffsetMap(text, clean, listed);
  return withTokens({ text, clean, scales, tokens, words: [], numeric: [], raw, offsets }, tokens);
}

// ── 2. Phrases with no storable amount ───────────────────────────────────────────────────────

/**
 * null: the sentence has no storable amount, and that is the final answer. undefined: nothing was
 * excluded, keep reading. A result: the sentence must be asked about (foreign currency).
 */
function excludedPhrases(s: Sentence): ParsedAmount | null | undefined {
  // "dos mangos" is "next to nothing", not two pesos, and no native speaker reads it literally.
  for (const idiom of NON_AMOUNT_IDIOMS) {
    if (s.clean.includes(idiom)) return null;
  }
  // Checked on the text and not on the tokens, because the tokenizer splits "u$s" into three pieces.
  if (FOREIGN_CURRENCY.test(s.clean)) return undetermined(s, 'foreign_currency', s.clean);
  return undefined;
}

// ── 3. Self-corrections ──────────────────────────────────────────────────────────────────────

/** "gaste veinte no pera treinta mil": a marker with a figure on each side wipes what came before. */
function applyCorrections(s: Sentence): Sentence {
  const { tokens } = s;
  const at = tokens.findIndex(
    (t, i) => CORRECTION_MARKERS.has(t.text) && tokens.slice(0, i).some(isNumber) && tokens.slice(i).some(isNumber),
  );
  return at > 0 ? withTokens(s, tokens.slice(at + 1)) : s;
}

// ── 4. Whole-sentence shapes that make the amount undeterminable ─────────────────────────────

function sentenceAmbiguity(s: Sentence): ParsedAmount | undefined {
  const { tokens, words, numeric, clean } = s;

  // "entre 20 y 25 mil": a range is not a number.
  if (has(s, 'entre') && numeric.length >= 2) return undetermined(s, 'range', clean);

  // "de 80 mil a 100 mil": the same range with the other pair of prepositions. Both figures have to
  // sit right against their preposition, so "3 cuotas de 40 mil a partir de marzo" stays a
  // purchase. At least one end has to look like money: "de 8 a 12" is a shift, not a budget.
  const looksLikeMoney = (t: Token | undefined) => t?.value !== undefined && (t.scaled === true || t.value >= 100);
  const fromTo = tokens.some(
    (t, i) =>
      t.text === 'de' &&
      isNumber(tokens[i + 1]) &&
      tokens[i + 2]?.text === 'a' &&
      isNumber(tokens[i + 3]) &&
      (looksLikeMoney(tokens[i + 1]) || looksLikeMoney(tokens[i + 3])),
  );
  if (fromTo) return undetermined(s, 'range', clean);

  // "40 o 50 mil"
  if (numeric.length >= 2 && (has(s, 'o') || has(s, 'u'))) {
    const orIndex = words.findIndex((w) => w === 'o' || w === 'u');
    const before = tokens.slice(0, orIndex).some(isNumber);
    const after = tokens.slice(orIndex).some(isNumber);
    if (before && after) return undetermined(s, 'range', clean);
  }

  // "100 mil mas iva": net or invoiced, the user chooses. What makes it a question is that the tax
  // is ADDED ON, so the connector is looked for anywhere before the word ("mas el 21 de iva").
  // "pague 20 mil de iva" is the tax bill itself, and "con el iva incluido" states the total.
  const ivaAt = words.indexOf('iva');
  if (
    ivaAt >= 0 &&
    words.slice(0, ivaAt).some((w) => w === 'mas' || w === 'con' || w === '+') &&
    !words.some((w) => w === 'incluido' || w === 'incluida' || w === 'adentro')
  ) {
    return undetermined(s, 'tax_unclear', clean);
  }

  // "me pagaron 100 mil pero me descontaron 10 mil": gross or net.
  if (has(s, 'pero') && numeric.length >= 2) return undetermined(s, 'net_or_gross', clean);
  if (words.some((w) => w.startsWith('descontar') || w === 'descontaron' || w === 'descuentan')) {
    if (numeric.length >= 2) return undetermined(s, 'net_or_gross', clean);
  }

  // Money in and money out in the same sentence: two entries, not one amount.
  const hasIncome = words.some((w) => INCOME_VERBS.has(w));
  const hasExpense = words.some((w) => EXPENSE_VERBS.has(w));
  if (hasIncome && hasExpense && numeric.length >= 2) return undetermined(s, 'mixed_directions', clean);

  // "con 20% de descuento": is the amount before or after the discount? "menos el 10" is an
  // explicit subtraction, handled in step 10.
  if (percentAt(words) > 0 && !has(s, 'menos')) return undetermined(s, 'discount_unclear', clean);

  // "6 cuotas sin interes de 25 lucas": the price of the thing, or what leaves this month? The noun
  // is not required ("12 sin interes de 8000"). Two figures are, so that a lone "pague 20 mil sin
  // interes" keeps its total.
  if (has(s, 'sin', 'interes') && numeric.length >= 2) return undetermined(s, 'instalments', clean);

  return undefined;
}

// ── 5. Which numbers are money ───────────────────────────────────────────────────────────────

interface Candidate {
  index: number;
  token: Token;
  /** The word right before the number: "a 8000" reads differently from "por 8000". */
  previousWord: string;
  score: number;
  perUnit: boolean;
  isTotalMarked: boolean;
}

interface Quantity {
  index: number;
  value: number;
  noun: string;
}

interface Reading {
  s: Sentence;
  quantities: Quantity[];
  /** Price candidates, best first. */
  pool: Candidate[];
  best: Candidate;
}

/** "cada una", "c/u", "por unidad", "la docena", "el kilo": the price is for ONE of something. */
function perUnitAt(tokens: readonly Token[], i: number): { yes: boolean; noun: string } {
  const a = tokens[i + 1]?.text ?? '';
  const b = tokens[i + 2]?.text ?? '';

  // "cada una" refers to the thing being counted: three dozen at 8500 "cada una" is 8500 per
  // DOZEN. Only an explicit "la unidad" / "por unidad" means the price of one single item.
  if (a === 'cada') return { yes: true, noun: COUNT_NOUNS.has(b) ? b : 'same' };
  if (a === 'c/u' || a === 'cu') return { yes: true, noun: 'same' };
  if ((a === 'por' || a === 'el' || a === 'la' || a === 'x') && COUNT_NOUNS.has(b)) {
    return { yes: true, noun: b };
  }
  return { yes: false, noun: '' };
}

function totalMarkedAt(tokens: readonly Token[], i: number): boolean {
  const a = tokens[i + 1]?.text ?? '';
  const b = tokens[i + 2]?.text ?? '';
  return (a === 'en' && b === 'total') || (a === 'por' && (b === 'todo' || b === 'el'));
}

/** A number that is certainly not money, whatever else the sentence says. */
function isNotMoney(s: Sentence, i: number): boolean {
  const { tokens, words } = s;
  const t = tokens[i]!;
  const prev = tokens[i - 1]?.text ?? '';
  const next = tokens[i + 1]?.text ?? '';
  const next2 = tokens[i + 2]?.text ?? '';

  // A reference: "pedido 88 lo cobre 12.500".
  if (REFERENCE_MARKERS.has(prev)) return true;

  // "de los 80 mil me devolvieron 20 mil": a sentence that OPENS by naming a sum names the context,
  // and the movement is the figure after it. Only at the very start, only with the article, and only
  // when another figure follows, so "me pagaron 50 mil de los 120 que me debian" keeps its 50 mil.
  if (
    i === 2 &&
    words[0] === 'de' &&
    (words[1] === 'los' || words[1] === 'las') &&
    tokens.some((o, j) => j > i && o.value !== undefined)
  ) {
    return true;
  }

  // A date: "el 20 de junio", "el 15 gaste 20 mil".
  if (next === 'de' && MONTHS.has(next2)) return true;
  if (prev === 'el' && !t.scaled && t.value! <= 31 && !NEUTRAL_UNITS.has(next)) {
    const elsewhere = tokens.some(
      (o, j) => j !== i && o.value !== undefined && (o.scaled || NEUTRAL_UNITS.has(tokens[j + 1]?.text ?? '')),
    );
    if (elsewhere) return true;
  }

  // A percentage.
  return next === '%' || (next === 'por' && next2 === 'ciento');
}

function classifyNumbers(s: Sentence): Reading | null {
  const { tokens } = s;
  const candidates: Candidate[] = [];
  const quantities: Quantity[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.value === undefined) continue;
    if (isNotMoney(s, i)) continue;

    const prev = tokens[i - 1]?.text ?? '';
    const prev2 = tokens[i - 2]?.text ?? '';
    const next = tokens[i + 1]?.text ?? '';

    // A price carrying a per-unit marker is a price, whatever noun follows it. Decided before the
    // counting test, or "1500 c/u" reads as fifteen hundred somethings.
    const perUnit = perUnitAt(tokens, i);

    // Counting something: "3 docenas", "2 kilos", "5 tortas".
    const countsPlainNoun = next !== '' && !NEUTRAL_UNITS.has(next) && !CONNECTORS.has(next) && !MONTHS.has(next);
    // "vendi 4 a 15 mil": nothing between the count and the price except the "a".
    const countsBeforePrice = next === 'a' && isNumber(tokens[i + 2]);
    // A count in front of a unit noun may be fractional ("2,5 kilos"). The integer requirement only
    // belongs on the shapes that compete with dates, where a fraction would be nonsense.
    const countsSomething =
      !perUnit.yes &&
      !t.scaled &&
      t.value > 0 &&
      t.value <= 10_000 &&
      ((countsPlainNoun && COUNT_NOUNS.has(next)) ||
        (countsPlainNoun && Number.isInteger(t.value)) ||
        (countsBeforePrice && Number.isInteger(t.value)));

    if (countsSomething) {
      quantities.push({ index: i, value: t.value, noun: countsBeforePrice ? '' : next });
      continue;
    }

    candidates.push({
      index: i,
      token: t,
      previousWord: prev,
      perUnit: perUnit.yes,
      isTotalMarked: totalMarkedAt(tokens, i),
      score:
        (t.scaled ? 2 : 0) +
        (NEUTRAL_UNITS.has(next) ? 2 : 0) +
        (prev === '$' || prev2 === '$' ? 1 : 0) +
        (PRICE_MARKERS.has(prev) ? 1 : 0) +
        (perUnit.yes ? 2 : 0),
    });
  }

  // A lone "un"/"una" is not an amount: "vendi una mesa" has no money in it.
  const pool = candidates.filter((c) => !(c.token.fromWords && c.token.value === 1 && !c.token.scaled));
  if (!pool.length) return null;

  pool.sort((a, b) => b.score - a.score || a.index - b.index);
  return { s, quantities, pool, best: pool[0]! };
}

// ── 6. An open remainder too large to store a floor ──────────────────────────────────────────

/** "un palo y pico": on a million the unknown part is material. On "30 lucas y pico" the floor is fair. */
function openRemainder({ s, best }: Reading): ParsedAmount | undefined {
  if (best.token.approximate && best.token.value! >= 1_000_000) {
    return undetermined(s, 'open_remainder', best.token.literal ?? s.clean, [best.token]);
  }
  return undefined;
}

// ── 7. Quantity times unit price ─────────────────────────────────────────────────────────────

/** Figures after `from` joined to it by "y"/"mas", that are part of the same movement. */
function extrasAfter(r: Reading, from: number, skip: readonly number[]): Candidate[] {
  return r.pool.filter(
    (c) => c.index > from && !skip.includes(c.index) && joinedAsOneMovement(r.s.words.slice(from, c.index)),
  );
}

function quantityTimesUnitPrice(r: Reading): ParsedAmount | undefined {
  const { s, pool, quantities } = r;
  const { tokens } = s;
  const priced = pool.find((c) => c.perUnit);
  if (!priced) return undefined;

  const usable = quantities.filter((q) => q.index !== priced.index);
  if (usable.length > 1) return undetermined(s, 'several_quantities', s.clean);

  let quantity = usable[0]?.value ?? null;
  let quantityNoun = usable[0]?.noun ?? '';
  let quantityIndex = usable[0]?.index ?? -1;

  // The count can come after the price, with nothing behind it: "20 lucas la caja de vino, lleve
  // 6". A bare integer that is not the price is the only thing it can be.
  if (quantity === null) {
    const loose = tokens.filter(
      (t, j) =>
        j !== priced.index &&
        t.value !== undefined &&
        // the "uno" of "cada uno" is grammar, not a count
        !(t.fromWords && t.value === 1) &&
        !t.scaled &&
        t.value > 0,
      // No ceiling here on purpose: a per-unit marker has already established that something is
      // counted, and a bakery does sell ten thousand facturas.
    );
    if (loose.length === 1) {
      quantity = loose[0]!.value!;
      quantityIndex = tokens.indexOf(loose[0]!);
    } else if (loose.length === 0) {
      // "vendi 2 mil empanadas a 1200 cada una": a count can carry a scale word. Only here, where a
      // per-unit marker already proved a count is expected.
      const counted = tokens.filter((t, j) => {
        if (j === priced.index || t.value === undefined || !t.scaled) return false;
        const next = tokens[j + 1]?.text ?? '';
        return next !== '' && !CONNECTORS.has(next) && !NEUTRAL_UNITS.has(next) && !MONTHS.has(next);
      });
      if (counted.length === 1) {
        quantity = counted[0]!.value!;
        quantityNoun = tokens[tokens.indexOf(counted[0]!) + 1]?.text ?? '';
        quantityIndex = tokens.indexOf(counted[0]!);
      }
    }
  }

  // "kilo y medio de jamon a 18 mil el kilo": the count is the unit itself, with no number in front.
  // That reads as one only when the unit is singular. A plural unit with no number means the count
  // was said in a way the parser failed to read, and assuming one would turn 30.000 into 12.000.
  if (quantity === null) {
    const unitIndex = tokens.findIndex((t, j) => COUNT_NOUNS.has(t.text) && !isNumber(tokens[j - 1]) && j !== priced.index + 2);
    if (unitIndex >= 0) {
      const unit = tokens[unitIndex]!.text;
      const half = tokens[unitIndex + 1]?.text === 'y' && tokens[unitIndex + 2]?.text === 'medio';
      if (!unit.endsWith('s') || half) {
        quantity = half ? 1.5 : 1;
        quantityNoun = unit;
        quantityIndex = unitIndex;
      }
    }
  }

  // A per-unit price with a count nobody could read is the third answer, not a guess.
  if (quantity === null) return undetermined(s, 'unit_or_total', s.clean);

  // "3 docenas de empanadas a 1500 la unidad": the price is per single item, so open the dozens.
  const marker = perUnitAt(tokens, priced.index).noun;
  const pack = PACK_SIZES[quantityNoun];
  const units = marker === 'unidad' && pack ? quantity * pack : quantity;
  const unitPrice = priced.token.value!;
  // Anything joined on after the price is part of the same movement: freight on top of the goods.
  const extras = extrasAfter(r, priced.index, [priced.index, quantityIndex]);
  const total = round2(units * unitPrice + extras.reduce((sum, c) => sum + c.token.value!, 0));

  const marks: Mark[] = [[priced.token, 'unit_price'], ...extras.map((c) => [c.token, 'added'] as const)];
  const quantityToken = tokens[quantityIndex];
  if (quantityToken) marks.push([quantityToken, 'quantity']);
  return computed(s, total, `${units} x ${priced.token.literal ?? unitPrice}`, marks, {
    quantity: units,
    unitPrice,
    approximate: Boolean(priced.token.approximate),
  });
}

// ── 8. Instalments ───────────────────────────────────────────────────────────────────────────

/**
 * "3 cuotas de 25 mil": the purchase costs the sum of the instalments. Only when the best amount is
 * the one after "cuotas de": "pague la tele 300 mil en 3 cuotas" names the total, and multiplying
 * would turn 300.000 into 900.000. The noun comes from a set ("4 pagos de 90 mil"), and adjectives
 * may sit before the "de" ("18 cuotas fijas de 40 mil"); a figure or a function word may not.
 */
function instalments(r: Reading): ParsedAmount | undefined {
  const { s, quantities, best } = r;
  const { tokens } = s;
  const count = quantities.find((q) => INSTALMENT_NOUNS.has(q.noun));
  if (!count) return undefined;

  let instalmentAt = -1;
  for (let j = count.index + 2; j <= count.index + 4 && j < tokens.length; j++) {
    const w = tokens[j]!;
    if (w.text === 'de') {
      instalmentAt = j + 1;
      break;
    }
    if (w.value !== undefined || CONNECTORS.has(w.text)) break;
  }
  if (instalmentAt < 0 || tokens[instalmentAt] !== best.token || best.token.value === undefined) return undefined;

  // "3 cuotas de 20 mil mas un anticipo de 50 mil": the down payment is part of what the thing cost.
  const extras = extrasAfter(r, best.index, [count.index]);
  const extra = extras.reduce((sum, c) => sum + c.token.value!, 0);
  const literal = `${count.value} x ${best.token.literal ?? best.token.value}`;
  return computed(
    s,
    round2(count.value * best.token.value + extra),
    extra ? `${literal} + ${extra}` : literal,
    [[tokens[count.index]!, 'quantity'], [best.token, 'unit_price'], ...extras.map((c) => [c.token, 'added'] as const)],
    // The count and the price are of the instalments; anything extra rides on top.
    { quantity: count.value, unitPrice: best.token.value },
  );
}

// ── 9. A count and a price with nothing tying them ───────────────────────────────────────────

/**
 * "5 tortas a 8000", "3 remeras de 12 mil": each, or the lot? In Rioplatense Spanish both readings
 * are common. "por 5000" prices the lot, a per-unit marker multiplies (step 7), and a price simply
 * next to a count ("10 bolsas de cemento 145 mil") is the total.
 */
function countWithoutMarker({ s, quantities, best }: Reading): ParsedAmount | undefined {
  // Only the literal "cuota(s)", as in the source, and not the wider INSTALMENT_NOUNS that step 8
  // uses. Widening it would change which sentences ask: today "4 pagos a 90 mil" asks and
  // "4 cuotas a 90 mil" returns 90000 (README, Limits; pinned in test/limits.test.ts).
  const countRelated = quantities.filter((q) => q.noun !== 'cuotas' && q.noun !== 'cuota' && q.index < best.index);
  if (
    countRelated.length &&
    (best.previousWord === 'a' || best.previousWord === 'de') &&
    !best.isTotalMarked &&
    !best.perUnit
  ) {
    return undetermined(s, 'unit_or_total', s.clean);
  }
  return undefined;
}

// ── 10. Discounts ────────────────────────────────────────────────────────────────────────────

function discounts({ s, best }: Reading): ParsedAmount | undefined {
  const { tokens, words, numeric } = s;

  // "pague 50 lucas menos el 10 de descuento": "menos" is an operator and "el 10" is 10%. A stated
  // rate counts as much as the noun ("gaste 80 mil menos el 20%").
  if (has(s, 'menos') && (has(s, 'descuento') || percentAt(words) > 0)) {
    const after = tokens.slice(words.indexOf('menos')).filter((t) => t.value !== undefined && t !== best.token);
    // "menos el 10" is a percentage; "menos 20 mil" is pesos. Nobody discounts 20.000 percent.
    const pct = after.find((t) => !t.scaled && t.value! <= 100);
    const absolute = after.find((t) => t.scaled || t.value! > 100);

    if (best.token.value !== undefined && (pct || absolute)) {
      const gross = best.token.value;
      const total = pct ? round2(gross * (1 - pct.value! / 100)) : round2(gross - absolute!.value!);
      // A discount bigger than the bill is not a discount, it is a misreading.
      if (total > 0) {
        return computed(
          s,
          total,
          pct ? `${best.token.literal} - ${pct.value}%` : `${best.token.literal} - ${absolute!.literal}`,
          [[best.token, 'amount'], [(pct ?? absolute)!, 'subtracted']],
        );
      }
    }
  }

  // A discount with a figure of its own that no rule above could apply. Returning the gross would
  // answer with the one figure the sentence exists to correct ("un 10 de descuento sobre 45 mil").
  // No rule is written for "puntos" on purpose: every literal-word branch is one adjective away
  // from switching off. With one figure ("45 mil con descuento") there is nothing left open.
  if (numeric.length >= 2 && words.some((w) => w === 'descuento' || w === 'descuentos' || w === 'rebaja')) {
    return undetermined(s, 'discount_unclear', s.clean);
  }
  return undefined;
}

// ── 11. Half of a figure ─────────────────────────────────────────────────────────────────────

/**
 * "pague la mitad de los 80 mil del alquiler": what left is half. Only when the amount is the one
 * "mitad de" introduces; "pague la mitad de la deuda, 80 mil" names what moved.
 */
function half({ s, best }: Reading): ParsedAmount | undefined {
  const { words } = s;
  const mitadAt = words.findIndex((w, i) => w === 'mitad' && words[i + 1] === 'de');
  const halvesTheAmount =
    mitadAt >= 0 &&
    best.index > mitadAt &&
    best.index <= mitadAt + 5 &&
    // nothing but function words between "mitad de" and the figure
    words.slice(mitadAt + 2, best.index).every((w) => CONNECTORS.has(w));
  if (!halvesTheAmount || best.token.value === undefined) return undefined;
  return computed(s, round2(best.token.value / 2), `la mitad de ${best.token.literal}`, [[best.token, 'amount']]);
}

// ── 12. Several amounts of the same movement ─────────────────────────────────────────────────

/** "pague 5 mil de luz y 3 mil de gas", "15 mil mas 2 mil de envio": what leaves the till is the sum. */
function sums({ s, pool }: Reading): ParsedAmount | undefined {
  if (pool.length < 2) return undefined;
  const { words } = s;
  const chained = (list: readonly Candidate[]) =>
    list.every((c, k) => k === 0 || joinedAsOneMovement(words.slice(list[k - 1]!.index, c.index)));

  // The pool is ordered by score; the sentence order is checked too.
  const sorted = [...pool].sort((a, b) => a.index - b.index);
  // "cobre 120 mil, 40 mil de sena": one figure is a piece of another, not an item beside it.
  const decomposed = sorted.some((c) => words[c.index + 1] === 'de' && PART_OF_THE_WHOLE.has(words[c.index + 2] ?? ''));
  if (!(chained(pool) || chained(sorted)) || decomposed) return undefined;

  return computed(
    s,
    round2(sorted.reduce((sum, c) => sum + c.token.value!, 0)),
    sorted.map((c) => c.token.literal ?? String(c.token.value)).join(' + '),
    sorted.map((c) => [c.token, 'amount'] as const),
    { approximate: sorted.some((c) => c.token.approximate) },
  );
}

// ── 13. One amount ───────────────────────────────────────────────────────────────────────────

function singleAmount({ s, best }: Reading): ParsedAmount {
  return {
    value: best.token.value!,
    literal: best.token.literal ?? String(best.token.value),
    source: best.token.fromWords ? 'words' : 'digits',
    quantity: null,
    unitPrice: null,
    ambiguous: false,
    approximate: Boolean(best.token.approximate),
    spans: spansOf(s, [[best.token, 'amount']]),
  };
}

const READING_STEPS = [openRemainder, quantityTimesUnitPrice, instalments, countWithoutMarker, discounts, half, sums];

/**
 * Reads one money amount from a sentence. Returns null when the sentence holds no amount, a result
 * with `ambiguous: true` and a `reason` when the app should ask, and otherwise the value.
 *
 * `slang` adds scale words on top of the built-in ones and overrides them, for example
 * `{ quina: 500, quinas: 500 }`. Each form, singular and plural, is its own key.
 */
export function parseAmount(text: string, slang: Readonly<Record<string, number>> = {}): ParsedAmount | null {
  const scales: Record<string, number> = { ...BASE_SCALES, ...slang };
  const clean = normalize(text);
  if (!clean) return null;

  const read = readSentence(text, clean, scales);
  const excluded = excludedPhrases(read);
  if (excluded !== undefined) return excluded;

  const s = applyCorrections(read);
  const ambiguous = sentenceAmbiguity(s);
  if (ambiguous) return ambiguous;

  const reading = classifyNumbers(s);
  if (!reading) return null;

  for (const step of READING_STEPS) {
    const result = step(reading);
    if (result) return result;
  }
  return singleAmount(reading);
}
