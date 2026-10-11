/**
 * Error-path tests for the federal income tax engine.
 * Covers UnsupportedTaxYearError and InvalidTaxInputError.
 */

import { describe, expect, it } from 'vitest';
import {
  computeFederalTax,
  InvalidTaxInputError,
  marginalLtcgRate,
  marginalOrdinaryRate,
  type TaxConfig,
  UnsupportedTaxYearError,
} from './federal-tax';
import type { CalibrationSnapshot } from './calibration';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';

// ---------------------------------------------------------------------------
// UnsupportedTaxYearError
// ---------------------------------------------------------------------------

describe('UnsupportedTaxYearError', () => {
  it('should_throw_for_year_before_supported_range', () => {
    expect(() =>
      computeFederalTax(
        { year: 2023, filingStatus: 'Single', ordinaryIncome: 50000, ltcgAndQdi: 0 },
        FEDERAL_TAX_CONFIG,
      ),
    ).toThrow(UnsupportedTaxYearError);
  });

  it('should_throw_for_year_after_supported_range', () => {
    expect(() =>
      computeFederalTax(
        { year: 2027, filingStatus: 'Single', ordinaryIncome: 50000, ltcgAndQdi: 0 },
        FEDERAL_TAX_CONFIG,
      ),
    ).toThrow(UnsupportedTaxYearError);
  });

  it('should_set_year_on_thrown_error', () => {
    let caught: unknown;
    try {
      computeFederalTax(
        { year: 2023, filingStatus: 'Single', ordinaryIncome: 50000, ltcgAndQdi: 0 },
        FEDERAL_TAX_CONFIG,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedTaxYearError);
    expect((caught as UnsupportedTaxYearError).year).toBe(2023);
    expect((caught as UnsupportedTaxYearError).code).toBe('UNSUPPORTED_TAX_YEAR');
    expect((caught as UnsupportedTaxYearError).name).toBe('UnsupportedTaxYearError');
  });

  it('should_include_year_in_error_message', () => {
    const err = new UnsupportedTaxYearError(1999);
    expect(err.message).toContain('1999');
  });
});

// ---------------------------------------------------------------------------
// InvalidTaxInputError
// ---------------------------------------------------------------------------

describe('InvalidTaxInputError', () => {
  it('should_throw_for_negative_ordinaryIncome', () => {
    expect(() =>
      computeFederalTax(
        { year: 2025, filingStatus: 'Single', ordinaryIncome: -1, ltcgAndQdi: 0 },
        FEDERAL_TAX_CONFIG,
      ),
    ).toThrow(InvalidTaxInputError);
  });

  it('should_throw_for_negative_ltcgAndQdi', () => {
    expect(() =>
      computeFederalTax(
        { year: 2025, filingStatus: 'Single', ordinaryIncome: 50000, ltcgAndQdi: -100 },
        FEDERAL_TAX_CONFIG,
      ),
    ).toThrow(InvalidTaxInputError);
  });

  it('should_throw_for_negative_netInvestmentIncome', () => {
    expect(() =>
      computeFederalTax(
        {
          year: 2025,
          filingStatus: 'Single',
          ordinaryIncome: 50000,
          ltcgAndQdi: 0,
          netInvestmentIncome: -500,
        },
        FEDERAL_TAX_CONFIG,
      ),
    ).toThrow(InvalidTaxInputError);
  });

  it('should_set_field_name_on_thrown_error', () => {
    let caught: unknown;
    try {
      computeFederalTax(
        { year: 2025, filingStatus: 'Single', ordinaryIncome: -1, ltcgAndQdi: 0 },
        FEDERAL_TAX_CONFIG,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidTaxInputError);
    expect((caught as InvalidTaxInputError).field).toBe('ordinaryIncome');
    expect((caught as InvalidTaxInputError).code).toBe('INVALID_TAX_INPUT');
  });

  it('should_include_field_and_value_in_message', () => {
    const err = new InvalidTaxInputError('ltcgAndQdi', -200);
    expect(err.message).toContain('ltcgAndQdi');
    expect(err.message).toContain('-200');
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

  it('should_throw_for_NaN_ordinaryIncome', () => {
    expect(() =>
      computeFederalTax(
        { year: 2025, filingStatus: 'Single', ordinaryIncome: NaN, ltcgAndQdi: 0 },
        FEDERAL_TAX_CONFIG,
      ),
    ).toThrow(InvalidTaxInputError);
    expect(() =>
      computeFederalTax(
        { year: 2025, filingStatus: 'Single', ordinaryIncome: NaN, ltcgAndQdi: 0 },
        FEDERAL_TAX_CONFIG,
      ),
    ).toThrow(expect.objectContaining({ field: 'ordinaryIncome' }));
  });

  it('should_throw_for_Infinity_ltcgAndQdi', () => {
    expect(() =>
      computeFederalTax(
        { year: 2025, filingStatus: 'Single', ordinaryIncome: 0, ltcgAndQdi: Infinity },
        FEDERAL_TAX_CONFIG,
      ),
    ).toThrow(InvalidTaxInputError);
    expect(() =>
      computeFederalTax(
        { year: 2025, filingStatus: 'Single', ordinaryIncome: 0, ltcgAndQdi: Infinity },
        FEDERAL_TAX_CONFIG,
      ),
    ).toThrow(expect.objectContaining({ field: 'ltcgAndQdi' }));
  });

  it('should_throw_for_negative_Infinity_netInvestmentIncome', () => {
    expect(() =>
      computeFederalTax(
        {
          year: 2025,
          filingStatus: 'Single',
          ordinaryIncome: 0,
          ltcgAndQdi: 0,
          netInvestmentIncome: -Infinity,
        },
        FEDERAL_TAX_CONFIG,
      ),
    ).toThrow(InvalidTaxInputError);
    expect(() =>
      computeFederalTax(
        {
          year: 2025,
          filingStatus: 'Single',
          ordinaryIncome: 0,
          ltcgAndQdi: 0,
          netInvestmentIncome: -Infinity,
        },
        FEDERAL_TAX_CONFIG,
      ),
    ).toThrow(expect.objectContaining({ field: 'netInvestmentIncome' }));
  });

  it('should_throw_for_negative_taxpayersAge65Plus', () => {
    expect(() =>
      computeFederalTax(
        {
          year: 2025,
          filingStatus: 'Single',
          ordinaryIncome: 0,
          ltcgAndQdi: 0,
          taxpayersAge65Plus: -1,
        },
        FEDERAL_TAX_CONFIG,
      ),
    ).toThrow(InvalidTaxInputError);
    expect(() =>
      computeFederalTax(
        {
          year: 2025,
          filingStatus: 'Single',
          ordinaryIncome: 0,
          ltcgAndQdi: 0,
          taxpayersAge65Plus: -1,
        },
        FEDERAL_TAX_CONFIG,
      ),
    ).toThrow(expect.objectContaining({ field: 'taxpayersAge65Plus' }));
  });
});

// ---------------------------------------------------------------------------
// Standalone helpers throw UnsupportedTaxYearError BEFORE ≤0 early-return
// ---------------------------------------------------------------------------

describe('standalone helpers: year-throw precedes ≤0 early-return', () => {
  // Snapshot with 2024 removed so 2024 is a missing year.
  const partialSnapshot: CalibrationSnapshot<TaxConfig> = {
    ...FEDERAL_TAX_CONFIG,
    values: {
      2025: FEDERAL_TAX_CONFIG.values[2025]!,
      2026: FEDERAL_TAX_CONFIG.values[2026]!,
    },
  };

  it('marginalOrdinaryRate_should_throw_UnsupportedTaxYearError_for_missing_year_even_when_taxableIncome_is_zero', () => {
    // Year lookup must happen before the ≤0 early-return
    expect(() =>
      marginalOrdinaryRate(2024, 'Single', 0, partialSnapshot),
    ).toThrow(UnsupportedTaxYearError);
  });

  it('marginalLtcgRate_should_throw_UnsupportedTaxYearError_for_missing_year_even_when_totalTaxableIncome_is_zero', () => {
    // Year lookup must happen before the ≤0 early-return
    expect(() =>
      marginalLtcgRate(2024, 'Single', 0, partialSnapshot),
    ).toThrow(UnsupportedTaxYearError);
  });
});
