import { describe, expect, it } from 'vitest';
import { computeFederalTax, marginalOrdinaryRate, type TaxConfig } from './federal-tax';
import type { CalibrationSnapshot } from './calibration';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';

describe('UnsupportedTaxYearError', () => {
  it.each([2023, 2027])('should_throw_with_year_and_code_for_year_%i', (year) => {
    expect(() =>
      computeFederalTax(
        { year, filingStatus: 'Single', ordinaryIncome: 50000, ltcgAndQdi: 0 },
        FEDERAL_TAX_CONFIG,
      ),
    ).toThrow(
      expect.objectContaining({
        name: 'UnsupportedTaxYearError',
        code: 'UNSUPPORTED_TAX_YEAR',
        year,
        message: expect.stringContaining(String(year)),
      }),
    );
  });
});

describe('InvalidTaxInputError', () => {
  it.each([
    ['ordinaryIncome', -1],
    ['ltcgAndQdi', -100],
    ['netInvestmentIncome', -500],
    ['ordinaryIncome', NaN],
    ['ltcgAndQdi', Infinity],
    ['netInvestmentIncome', -Infinity],
    ['taxpayersAge65Plus', -1],
  ] as const)('should_throw_for_%s_%f', (field, value) => {
    expect(() =>
      computeFederalTax(
        { year: 2025, filingStatus: 'Single', ordinaryIncome: 0, ltcgAndQdi: 0, [field]: value },
        FEDERAL_TAX_CONFIG,
      ),
    ).toThrow(
      expect.objectContaining({
        name: 'InvalidTaxInputError',
        code: 'INVALID_TAX_INPUT',
        field,
        message: expect.stringContaining(String(value)),
      }),
    );
  });

  it('should_not_throw_for_zero_values', () => {
    expect(() =>
      computeFederalTax(
        {
          year: 2025,
          filingStatus: 'Single',
          ordinaryIncome: 0,
          ltcgAndQdi: 0,
          netInvestmentIncome: 0,
        },
        FEDERAL_TAX_CONFIG,
      ),
    ).not.toThrow();
  });
});

describe('standalone helpers: year-throw precedes ≤0 early-return', () => {
  const partialSnapshot: CalibrationSnapshot<TaxConfig> = {
    ...FEDERAL_TAX_CONFIG,
    values: {
      2025: FEDERAL_TAX_CONFIG.values[2025]!,
      2026: FEDERAL_TAX_CONFIG.values[2026]!,
    },
  };

  it('marginalOrdinaryRate_should_throw_UnsupportedTaxYearError_for_missing_year_even_when_taxableIncome_is_zero', () => {
    expect(() => marginalOrdinaryRate(2024, 'Single', 0, partialSnapshot)).toThrow(
      expect.objectContaining({ name: 'UnsupportedTaxYearError' }),
    );
  });
});
