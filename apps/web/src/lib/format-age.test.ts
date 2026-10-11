import { describe, expect, it } from 'vitest';
import { formatAgeYearsMonths } from './format-age';

describe('formatAgeYearsMonths', () => {
  it('emits just the number for a whole-year age', () => {
    expect(formatAgeYearsMonths({ years: 65, months: 0 })).toBe('65');
  });

  it('spells both units out when months are present', () => {
    expect(formatAgeYearsMonths({ years: 65, months: 6 })).toBe(
      '65 years 6 months',
    );
  });

  it('uses singular agreement for one year and one month', () => {
    expect(formatAgeYearsMonths({ years: 1, months: 1 })).toBe(
      '1 year 1 month',
    );
  });

  it('pluralises years while keeping a singular month', () => {
    expect(formatAgeYearsMonths({ years: 2, months: 1 })).toBe(
      '2 years 1 month',
    );
  });

  it('keeps a singular year while pluralising months', () => {
    expect(formatAgeYearsMonths({ years: 1, months: 2 })).toBe(
      '1 year 2 months',
    );
  });

  it('emits just the number for a zero age', () => {
    expect(formatAgeYearsMonths({ years: 0, months: 0 })).toBe('0');
  });
});
