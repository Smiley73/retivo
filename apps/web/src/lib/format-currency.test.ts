import { describe, expect, it } from 'vitest';
import {
  formatCurrency,
  formatCurrencyExact,
  formatCurrencyShort,
} from './format-currency';

describe('formatCurrency', () => {
  it('formats a positive value rounded to whole dollars', () => {
    expect(formatCurrency(1234.56)).toBe('$1,235');
  });

  it('formats zero', () => {
    expect(formatCurrency(0)).toBe('$0');
  });

  it('formats a large value with thousands separators', () => {
    expect(formatCurrency(1_234_567)).toBe('$1,234,567');
  });

  it('rounds at the negative half-dollar boundary toward +Infinity', () => {
    // Math.round(-100.5) === -100, so the result is -$100. The old
    // toLocaleString body used ICU halfExpand (away from zero) and
    // produced -$101 — the only observable delta, accepted scope.
    expect(formatCurrency(-100.5)).toBe('-$100');
  });
});

describe('formatCurrencyExact', () => {
  it('keeps two decimal places without rounding to whole dollars', () => {
    expect(formatCurrencyExact(1234.5)).toBe('$1,234.50');
  });

  it('pads whole dollars to two decimals', () => {
    expect(formatCurrencyExact(1234)).toBe('$1,234.00');
  });

  it('formats zero with two decimals', () => {
    expect(formatCurrencyExact(0)).toBe('$0.00');
  });
});

describe('formatCurrencyShort', () => {
  it('formats values ≥ 1M with one decimal and an "M" suffix', () => {
    expect(formatCurrencyShort(1_200_000)).toBe('$1.2M');
  });

  it('formats values ≥ 1k with a rounded "k" suffix', () => {
    expect(formatCurrencyShort(480_000)).toBe('$480k');
  });

  it('formats values < 1k as a rounded dollar amount', () => {
    expect(formatCurrencyShort(842.4)).toBe('$842');
  });

  it('handles negative values', () => {
    expect(formatCurrencyShort(-1_500_000)).toBe('$-1.5M');
    expect(formatCurrencyShort(-2_000)).toBe('$-2k');
  });
});
