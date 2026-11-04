// Amounts are integer cents from the input to the paper. Formatting splits whole units and cents
// with integer arithmetic, so no amount is ever divided into a float and rounded back.
//
// Every formatter asks for Latin digits (numberingSystem 'latn'). Locales such as 'ar-EG' and
// 'fa-IR' default to Arabic-Indic digits, which WinAnsi cannot encode, and the sanitizer would
// drop them: "$1.500,50" would reach the paper as "$".

export interface MoneyFormat {
  /** BCP 47 locale for digit grouping and the decimal sign. */
  readonly locale: string;
  /** Printed before the amount, after the minus sign: "-$4.500". */
  readonly symbol: string;
}

const LATIN = 'latn';

const grouping = new Map<string, Intl.NumberFormat>();
const decimalSigns = new Map<string, string>();

function groupFormat(locale: string): Intl.NumberFormat {
  let f = grouping.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: true, numberingSystem: LATIN });
    grouping.set(locale, f);
  }
  return f;
}

function decimalSign(locale: string): string {
  let sign = decimalSigns.get(locale);
  if (sign === undefined) {
    sign = new Intl.NumberFormat(locale, { numberingSystem: LATIN }).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.';
    decimalSigns.set(locale, sign);
  }
  return sign;
}

/**
 * "$8.000" when whole, "$8.000,50" with cents: never one decimal ("$8.000,5"), and never a
 * rounding artifact, because the cents are printed from the integer.
 */
export function formatCents(cents: number, { locale, symbol }: MoneyFormat): string {
  const abs = Math.abs(cents);
  const units = Math.trunc(abs / 100);
  const rest = abs - units * 100;
  const sign = cents < 0 ? '-' : '';
  const whole = groupFormat(locale).format(units);
  return rest === 0 ? `${sign}${symbol}${whole}` : `${sign}${symbol}${whole}${decimalSign(locale)}${String(rest).padStart(2, '0')}`;
}

const quantities = new Map<string, Intl.NumberFormat>();

/** A quantity with up to three decimals: "12", "1,25", "0,375". */
export function formatQuantity(quantity: number, locale: string): string {
  let f = quantities.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale, { maximumFractionDigits: 3, numberingSystem: LATIN });
    quantities.set(locale, f);
  }
  return f.format(quantity);
}

/**
 * quantity x unit price, rounded half up to the cent once. The quantity is taken in thousandths
 * and the product is computed in BigInt, so 1.005 kg at $999.99 is exact before rounding.
 */
export function lineTotalCents(quantity: number, unitPriceCents: number): number {
  const thousandths = BigInt(Math.round(quantity * 1000));
  const product = thousandths * BigInt(unitPriceCents);
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs + 500n) / 1000n;
  return Number(negative ? -rounded : rounded);
}

/** A calendar date "YYYY-MM-DD" in the locale's short form, with no time zone involved. */
export function formatCalendarDate(isoDate: string, locale: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const utc = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    numberingSystem: LATIN,
  }).format(utc);
}
