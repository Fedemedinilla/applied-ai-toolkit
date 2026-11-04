// One question per ambiguity reason. The parser refuses to pick a number and says why; this file
// turns the why into the question a shop owner would be asked across the counter, with a button
// per reading. Every number on a button comes from the parser, run again on the words it already
// pointed at. When the figures cannot be recovered that way, the question offers no buttons and
// asks for the amount instead: a question without a guessed answer beats a button with a wrong one.

import { parseAmount, type AmbiguityReason, type ParsedAmount, type Span } from '../../../amount-parser/src/index.ts';
import { money } from './format.ts';

export interface Option {
  /** The button text, in the owner's words. */
  label: string;
  amount: number;
  /** How the amount was obtained, kept on the row ("5 x 8000"). */
  literal: string;
}

export interface Question {
  reason: AmbiguityReason;
  prompt: string;
  options: Option[];
  /** Whether "otro monto" (typing the amount) is offered. False only when no single amount fits. */
  typed: boolean;
  /** A line under the prompt, when the buttons need context. */
  note?: string;
}

/** Two decimals, the precision a cash book keeps. */
const cents = (n: number): number => Math.round(n * 100) / 100;

interface Figure {
  span: Span;
  value: number;
}

/** Figures the parser marked in a sentence it refused, each with the value of its own words. */
function figures(parsed: ParsedAmount): Figure[] {
  const out: Figure[] = [];
  for (const span of parsed.spans) {
    if (span.role !== 'figure') continue;
    const value = parseAmount(span.text)?.value;
    if (typeof value === 'number' && value > 0) out.push({ span, value });
  }
  return out;
}

/**
 * "entre 20 y 25 mil": the scale word is said once, after the second figure. When the first
 * figure is a bare number and the second is a number plus a scale word, the first borrows the
 * scale ("20" + "mil"), and the parser computes it. The borrowed value must stay at or below the
 * second, which is what a range means; otherwise the bare value stands.
 */
export function borrowScale(low: Figure, high: Figure): number {
  const lowWords = low.span.text.trim().split(/\s+/u);
  const highWords = high.span.text.trim().split(/\s+/u);
  if (lowWords.length !== 1 || highWords.length < 2) return low.value;
  const scaled = parseAmount(`${low.span.text} ${highWords.slice(1).join(' ')}`)?.value;
  if (typeof scaled === 'number' && scaled > low.value && scaled <= high.value) return scaled;
  return low.value;
}

/** "docenas" -> "docena", "panes" -> "pan", "alfajores" -> "alfajor", "postres" -> "postre". */
export function singular(word: string): string {
  if (/[aeiou][nlrdjz]es$/u.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

const NOT_A_UNIT = new Set(['a', 'de', 'por', 'en', 'x', 'al', 'los', 'las', 'mas', 'más']);

/** The noun after the count ("5 tortas a 8000" -> "torta"), or null ("vendí 4 a 15 mil"). */
function unitNoun(text: string, quantity: Span | undefined): string | null {
  if (!quantity) return null;
  const next = /^\s+(\p{L}+)/u.exec(text.slice(quantity.end));
  const word = next?.[1]?.toLowerCase();
  if (!word || NOT_A_UNIT.has(word)) return null;
  return singular(word);
}

/** Text immediately after a span, for "%", "de iva", "de descuento". */
const after = (text: string, span: Span): string => text.slice(span.end, span.end + 20).toLowerCase();

function unitOrTotal(text: string): Question {
  // The parser refuses "5 tortas a 8000" and returns no quantity or unit price. Appending "c/u"
  // pins the per-unit reading, and then the parser hands over both numbers. No arithmetic or regex
  // of our own decides the amount.
  const each = parseAmount(`${text} c/u`);
  if (each && !each.ambiguous && each.quantity && each.unitPrice && each.value) {
    const priceSpan = each.spans.find((s) => s.role === 'unit_price');
    const said = priceSpan?.text ?? money(each.unitPrice);
    const noun = unitNoun(text, each.spans.find((s) => s.role === 'quantity'));
    const eachWord = noun ? `cada ${noun}` : 'cada uno';
    return {
      reason: 'unit_or_total',
      prompt: `¿${said} ${eachWord} o ${said} en total?`,
      options: [
        { label: `${said} ${eachWord}: ${money(each.value)}`, amount: each.value, literal: each.literal },
        { label: `${said} en total: ${money(each.unitPrice)}`, amount: each.unitPrice, literal: said },
      ],
      typed: true,
    };
  }
  return typedOnly('unit_or_total', '¿Cuánto fue en total?');
}

function range(parsed: ParsedAmount): Question {
  const [first, second] = figures(parsed);
  if (first && second && second.value > first.value) {
    const low = borrowScale(first, second);
    return {
      reason: 'range',
      prompt: 'La frase da un rango. ¿Cuánto fue al final?',
      options: [
        { label: money(low), amount: low, literal: first.span.text },
        { label: money(second.value), amount: second.value, literal: second.span.text },
      ],
      typed: true,
      note: 'Si es un presupuesto y todavía no pagaste, no lo anotes.',
    };
  }
  return typedOnly('range', 'La frase da un rango. ¿Cuánto fue al final?');
}

function discount(text: string, parsed: ParsedAmount): Question {
  const figs = figures(parsed);
  const rate = figs.find(
    (f) => f.value < 100 && /^\s*(%|por\s*ciento|puntos|de\s+descuento)/u.test(after(text, f.span)),
  );
  const base = figs.filter((f) => f !== rate).sort((a, b) => b.value - a.value)[0];
  const prompt = rate && base
    ? `¿Los ${base.span.text} son antes o después del ${rate.value}% de descuento?`
    : '¿Cuánto pagaste, ya con el descuento?';
  if (!rate || !base) return typedOnly('discount_unclear', prompt);
  const net = cents(base.value * (1 - rate.value / 100));
  return {
    reason: 'discount_unclear',
    prompt,
    options: [
      { label: `Antes: con el descuento fueron ${money(net)}`, amount: net, literal: `${base.span.text} - ${rate.value}%` },
      { label: `Después: fueron ${money(base.value)}`, amount: base.value, literal: base.span.text },
    ],
    typed: true,
  };
}

/** The general IVA rate in Argentina. Offered only as a labelled button, never applied silently. */
export const GENERAL_VAT_RATE = 21;

function tax(text: string, parsed: ParsedAmount): Question {
  const figs = figures(parsed);
  const stated = figs.find((f) => f.value <= 100 && /^\s*(%|de\s+iva|por\s*ciento)/u.test(after(text, f.span)));
  const base = figs.filter((f) => f !== stated).sort((a, b) => b.value - a.value)[0];
  if (!base) return typedOnly('tax_unclear', '¿Cuánto fue con el IVA?');
  const rate = stated?.value ?? GENERAL_VAT_RATE;
  const gross = cents(base.value * (1 + rate / 100));
  return {
    reason: 'tax_unclear',
    prompt: `¿El IVA ya está incluido en los ${base.span.text}?`,
    options: [
      { label: `Sí, ya está incluido: ${money(base.value)}`, amount: base.value, literal: base.span.text },
      { label: `No, va aparte (${rate}%): ${money(gross)}`, amount: gross, literal: `${base.span.text} + ${rate}%` },
    ],
    typed: true,
  };
}

function instalments(parsed: ParsedAmount): Question {
  const [count, payment] = figures(parsed);
  if (count && payment && Number.isInteger(count.value) && count.value > 1 && count.value <= 120) {
    const whole = cents(count.value * payment.value);
    return {
      reason: 'instalments',
      prompt: '¿Anotás la compra entera o solo esta cuota?',
      options: [
        { label: `La compra entera: ${money(whole)}`, amount: whole, literal: `${count.span.text} x ${payment.span.text}` },
        { label: `Solo esta cuota: ${money(payment.value)}`, amount: payment.value, literal: payment.span.text },
      ],
      typed: true,
    };
  }
  return typedOnly('instalments', '¿Cuánto anotás?');
}

function netOrGross(parsed: ParsedAmount): Question {
  const [gross, deducted] = figures(parsed);
  if (gross && deducted && deducted.value < gross.value) {
    const net = cents(gross.value - deducted.value);
    return {
      reason: 'net_or_gross',
      prompt: '¿Anotás el monto completo o lo que quedó después del descuento?',
      options: [
        { label: `El monto completo: ${money(gross.value)}`, amount: gross.value, literal: gross.span.text },
        { label: `Lo que quedó: ${money(net)}`, amount: net, literal: `${gross.span.text} - ${deducted.span.text}` },
      ],
      typed: true,
    };
  }
  return typedOnly('net_or_gross', '¿Cuánto anotás?');
}

function typedOnly(reason: AmbiguityReason, prompt: string, note?: string): Question {
  return note === undefined ? { reason, prompt, options: [], typed: true } : { reason, prompt, options: [], typed: true, note };
}

/** The question that resolves an ambiguous parse. `parsed.ambiguous` must be true. */
export function questionFor(text: string, parsed: ParsedAmount): Question {
  const reason: AmbiguityReason = parsed.reason ?? 'unit_or_total';
  switch (reason) {
    case 'unit_or_total':
      return unitOrTotal(text);
    case 'range':
      return range(parsed);
    case 'discount_unclear':
      return discount(text, parsed);
    case 'tax_unclear':
      return tax(text, parsed);
    case 'instalments':
      return instalments(parsed);
    case 'net_or_gross':
      return netOrGross(parsed);
    case 'open_remainder': {
      const said = parsed.spans[0]?.text ?? 'y pico';
      return typedOnly(reason, `"${said}" no dice cuánto. ¿Cuánto fue exactamente?`);
    }
    case 'several_quantities':
      return typedOnly(reason, 'Hay más de una cantidad y no sé cuál multiplicar. ¿Cuánto fue en total?');
    case 'foreign_currency':
      return typedOnly(
        reason,
        'Esta caja anota en pesos y la frase habla de otra moneda. ¿Cuántos pesos fueron?',
        'Si lo anotara tal cual, quedarían como pesos.',
      );
    case 'mixed_directions':
      return {
        reason,
        prompt: 'En la frase entra plata y también sale. Cargá cada movimiento por separado.',
        options: [],
        typed: false,
      };
  }
}
