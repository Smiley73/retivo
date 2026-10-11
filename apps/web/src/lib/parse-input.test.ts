import { describe, expect, it } from 'vitest';
import { parseClampedInt, parseDecimal, stripNonDigits } from './parse-input';

describe('stripNonDigits', () => {
  it('keeps only ASCII digits', () => {
    expect(stripNonDigits('12abc34')).toBe('1234');
    expect(stripNonDigits('  42  ')).toBe('42');
    expect(stripNonDigits('-7')).toBe('7');
    expect(stripNonDigits('')).toBe('');
  });
});

describe('parseClampedInt', () => {
  it('returns 0 for empty / non-digit input', () => {
    expect(parseClampedInt('', 99)).toBe(0);
    expect(parseClampedInt('abc', 99)).toBe(0);
  });

  it('clamps to [0, max]', () => {
    expect(parseClampedInt('5', 11)).toBe(5);
    expect(parseClampedInt('999', 11)).toBe(11);
  });

  it('strips non-digits before parsing', () => {
    expect(parseClampedInt('12a3', 99)).toBe(99);
    expect(parseClampedInt('1-2', 50)).toBe(12);
  });
});

describe('parseDecimal', () => {
  it('returns 0 for empty / garbage', () => {
    expect(parseDecimal('')).toBe(0);
    expect(parseDecimal('abc')).toBe(0);
  });

  it('parses currency-like strings', () => {
    expect(parseDecimal('1234.56')).toBe(1234.56);
    expect(parseDecimal('$1234.56')).toBe(1234.56);
  });

  it('strips non-numeric / non-dot characters', () => {
    expect(parseDecimal('7.5%')).toBe(7.5);
  });
});
