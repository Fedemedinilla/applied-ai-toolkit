// parseNumber: one number in the Argentine convention, dot for thousands and comma for decimals.

import { describe, expect, it } from 'vitest';
import { parseNumber } from '../src/index.ts';

describe('parseNumber', () => {
  it.each([
    ['3.500', 3500],
    ['1.234,56', 1234.56],
    ['20,5', 20.5],
    ['20,50', 20.5],
    ['145.500', 145500],
    ['1.240.700', 1240700],
    ['2.50.000', 250000], // more than one dot: every dot is a thousands separator
    ['12,500', 12500], // three digits after a lone comma: thousands
    ['1,234.56', 1234.56], // both separators: the rightmost one is the decimal
    // A dot followed by anything other than three digits is a decimal point. The source project
    // found this the hard way: a version that dropped every dot read "1.5" as 15.
    ['1.5', 1.5],
    ['250000.00', 250000],
    ['.5', 0.5],
    ['0', 0],
  ])('%s -> %s', (raw, expected) => {
    expect(parseNumber(raw)).toBe(expected);
  });

  it('returns null when no digit is left', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('.')).toBeNull();
    expect(parseNumber(',')).toBeNull();
    expect(parseNumber('mil')).toBeNull();
  });

  it('drops every other character, a minus sign included', () => {
    expect(parseNumber('-5000')).toBe(5000);
    expect(parseNumber('$3.500')).toBe(3500);
  });
});
