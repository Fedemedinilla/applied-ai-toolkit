import { describe, expect, it } from 'vitest';
import { formatCents, lineTotalCents } from '../src/index.ts';
import { formatCalendarDate, formatQuantity } from '../src/money.ts';

const AR = { locale: 'es-AR', symbol: '$' };

describe('formatCents', () => {
  it('prints whole amounts without decimals and amounts with cents with exactly two', () => {
    expect(formatCents(800_000, AR)).toBe('$8.000');
    expect(formatCents(800_050, AR)).toBe('$8.000,50');
    expect(formatCents(800_005, AR)).toBe('$8.000,05');
    expect(formatCents(0, AR)).toBe('$0');
    expect(formatCents(1, AR)).toBe('$0,01');
  });

  it('puts the sign before the symbol', () => {
    expect(formatCents(-450_000, AR)).toBe('-$4.500');
  });

  it('is exact at the largest accepted amount, where a float division would round', () => {
    expect(formatCents(9_999_999_999_999, AR)).toBe('$99.999.999.999,99');
  });

  it('follows the locale', () => {
    expect(formatCents(123_456_789, { locale: 'en-US', symbol: 'US$' })).toBe('US$1,234,567.89');
  });

  it('uses Latin digits where the locale defaults to others', () => {
    expect(formatCents(150_050, { locale: 'ar-EG', symbol: '$' })).toMatch(/^\$1\D500\D50$/u);
    expect(formatQuantity(1.25, 'fa-IR')).toMatch(/^1\D25$/u);
    expect(formatCalendarDate('2026-11-04', 'ar-EG')).toMatch(/04\D+11\D+2026/u);
  });
});

describe('lineTotalCents', () => {
  it('multiplies exactly and rounds half up once', () => {
    expect(lineTotalCents(3, 900_000)).toBe(2_700_000);
    expect(lineTotalCents(1.25, 123_456)).toBe(154_320);
    // 1.005 x 99999 = 100498.995 cents
    expect(lineTotalCents(1.005, 99_999)).toBe(100_499);
    // 0.001 x 500 = 0.5 cents, half up
    expect(lineTotalCents(0.001, 500)).toBe(1);
    expect(lineTotalCents(1_000_000, 9_999_999)).toBe(9_999_999_000_000);
  });
});

describe('formatQuantity and formatCalendarDate', () => {
  it('formats quantities with up to three decimals', () => {
    expect(formatQuantity(12, 'es-AR')).toBe('12');
    expect(formatQuantity(1.25, 'es-AR')).toBe('1,25');
    expect(formatQuantity(0.375, 'es-AR')).toBe('0,375');
  });

  it('formats a calendar date with no time zone shift, whatever the process zone', () => {
    expect(formatCalendarDate('2026-11-04', 'es-AR')).toBe('04/11/2026');
    expect(formatCalendarDate('2026-01-01', 'en-US')).toBe('01/01/2026');
  });
});
