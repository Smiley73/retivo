/**
 * Tests for error handling in the RMD engine:
 * - ageInTaxYear birthdate validation (regex + calendar-invalid dates)
 * - computeRmd malformed isoBirthdate
 * - UnsupportedTaxYearError throw and shape
 * - missing-divisor-snapshot throw
 * - year-resolution clamp behavior
 */

import { describe, it, expect } from 'vitest';
import {
  computeRmd,
  ageInTaxYear,
  UnsupportedTaxYearError,
  RmdInvalidInputError,
} from './rmd';
import { SNAPSHOT } from './rmd.test-helpers';
import type { CalibrationSnapshot } from './calibration';
import type { RmdTable } from './rmd';

// ---------------------------------------------------------------------------
// ageInTaxYear — birthdate validation
// ---------------------------------------------------------------------------

describe('ageInTaxYear', () => {
  it('should_compute_age_as_taxYear_minus_birth_year', () => {
    expect(ageInTaxYear('1952-06-15', 2025)).toBe(73);
  });

  it('should_throw_RmdInvalidInputError_for_non_date_string', () => {
    expect(() => ageInTaxYear('not-a-date', 2025)).toThrow(RmdInvalidInputError);
  });

  it('should_throw_RmdInvalidInputError_for_empty_string', () => {
    expect(() => ageInTaxYear('', 2025)).toThrow(RmdInvalidInputError);
  });

  it('should_throw_RmdInvalidInputError_for_out_of_range_month', () => {
    expect(() => ageInTaxYear('2000-13-01', 2025)).toThrow(RmdInvalidInputError);
  });

  it('should_throw_RmdInvalidInputError_for_feb_30', () => {
    expect(() => ageInTaxYear('1950-02-30', 2025)).toThrow(RmdInvalidInputError);
  });

  it('should_throw_RmdInvalidInputError_for_apr_31', () => {
    expect(() => ageInTaxYear('1950-04-31', 2025)).toThrow(RmdInvalidInputError);
  });

  it('should_throw_RmdInvalidInputError_for_non_leap_feb_29', () => {
    // 1900 is NOT a leap year (divisible by 100 but not 400)
    expect(() => ageInTaxYear('1900-02-29', 2025)).toThrow(RmdInvalidInputError);
  });

  it('should_accept_valid_leap_day_2000_02_29', () => {
    // 2000 IS a leap year (divisible by 400)
    expect(() => ageInTaxYear('2000-02-29', 2025)).not.toThrow();
    expect(ageInTaxYear('2000-02-29', 2025)).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// computeRmd — malformed isoBirthdate
// ---------------------------------------------------------------------------

describe('computeRmd — malformed isoBirthdate', () => {
  it('should_throw_RmdInvalidInputError_for_not_a_date', () => {
    expect(() =>
      computeRmd(
        { isoBirthdate: 'not-a-date', taxYear: 2025, accounts: [] },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });

  it('should_throw_RmdInvalidInputError_for_out_of_range_month', () => {
    expect(() =>
      computeRmd(
        { isoBirthdate: '1950-13-01', taxYear: 2025, accounts: [] },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });

  it('should_throw_RmdInvalidInputError_for_empty_string', () => {
    expect(() =>
      computeRmd({ isoBirthdate: '', taxYear: 2025, accounts: [] }, SNAPSHOT),
    ).toThrow(RmdInvalidInputError);
  });
});

// ---------------------------------------------------------------------------
// computeRmd — malformed snapshot (missing divisor entry)
// ---------------------------------------------------------------------------

describe('computeRmd — malformed snapshot divisor', () => {
  it('should_throw_RmdInvalidInputError_when_snapshot_missing_divisor_for_looked_up_age', () => {
    // Snapshot has only age 73; owner age is 100 → clamped age 100 → missing → throw
    const partialSnapshot: CalibrationSnapshot<RmdTable> = {
      values: {
        2024: {
          uniformLifetime: { 73: 26.5 },
        },
      },
      metadata: {
        source: 'test',
        asOfDate: '2024-01-01',
        jurisdiction: 'US-federal',
      },
    };
    expect(() =>
      computeRmd(
        {
          isoBirthdate: '1925-01-01', // age 100 in 2025
          taxYear: 2025,
          accounts: [
            { id: 'ira', balanceDec31PriorYearCents: 1_000_000, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
          ],
        },
        partialSnapshot,
      ),
    ).toThrow(RmdInvalidInputError);
  });
});

// ---------------------------------------------------------------------------
// computeRmd — year resolution errors
// ---------------------------------------------------------------------------

describe('computeRmd — year resolution', () => {
  it('should_throw_UnsupportedTaxYearError_for_taxYear_2023', () => {
    // 2023 is below the minimum key (2024) in RMD_DIVISORS
    expect(() =>
      computeRmd(
        {
          isoBirthdate: '1950-01-01',
          taxYear: 2023,
          accounts: [{ id: 'a1', balanceDec31PriorYearCents: 1_000_000, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' }],
        },
        SNAPSHOT,
      ),
    ).toThrow(UnsupportedTaxYearError);
  });

  it('should_include_year_and_code_on_UnsupportedTaxYearError', () => {
    let err: UnsupportedTaxYearError | undefined;
    try {
      computeRmd(
        {
          isoBirthdate: '1950-01-01',
          taxYear: 2023,
          accounts: [],
        },
        SNAPSHOT,
      );
    } catch (e) {
      if (e instanceof UnsupportedTaxYearError) err = e;
    }
    expect(err).toBeInstanceOf(UnsupportedTaxYearError);
    expect(err?.year).toBe(2023);
    expect(err?.code).toBe('UNSUPPORTED_TAX_YEAR');
  });

});
