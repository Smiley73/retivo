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

describe('ageInTaxYear', () => {
  it('should_compute_age_as_taxYear_minus_birth_year', () => {
    expect(ageInTaxYear('1952-06-15', 2025)).toBe(73);
  });

  it.each([
    ['a non-date string', 'not-a-date'],
    ['an empty string', ''],
    ['an out-of-range month', '2000-13-01'],
    ['feb 30', '1950-02-30'],
    ['apr 31', '1950-04-31'],
    ['a non-leap feb 29', '1900-02-29'],
  ])('should_throw_RmdInvalidInputError_for_%s', (_label, isoBirthdate) => {
    expect(() => ageInTaxYear(isoBirthdate, 2025)).toThrow(RmdInvalidInputError);
  });

  it('should_accept_valid_leap_day_2000_02_29', () => {
    expect(ageInTaxYear('2000-02-29', 2025)).toBe(25);
  });
});

describe('computeRmd — malformed snapshot divisor', () => {
  it('should_throw_RmdInvalidInputError_when_snapshot_missing_divisor_for_looked_up_age', () => {
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

describe('computeRmd — year resolution', () => {
  it('should_throw_UnsupportedTaxYearError_with_year_and_code_for_taxYear_2023', () => {
    let err: UnsupportedTaxYearError | undefined;
    try {
      computeRmd(
        {
          isoBirthdate: '1950-01-01',
          taxYear: 2023,
          accounts: [{ id: 'a1', balanceDec31PriorYearCents: 1_000_000, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' }],
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
