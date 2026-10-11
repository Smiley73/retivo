/**
 * Tests for computeIrmaa — input validation.
 *
 * Coverage:
 *   - All invalid field cases → IrmaaInvalidInputError
 *   - Validation fires BEFORE snapshot lookup
 *   - Error code = 'IRMAA_INVALID_INPUT'
 *   - Boundary and IEEE-754 edge values
 */

import { describe, it, expect } from 'vitest';
import {
  computeIrmaa,
  computeMonthAwareIrmaa,
  IrmaaInvalidInputError,
  UnsupportedTaxYearError,
} from './irmaa';
import type {
  IrmaaInput,
  IrmaaFilingStatus,
  MonthAwareIrmaaInput,
  IrmaaBeneficiaryEnrollment,
} from './irmaa';
import { IRMAA_TIERS } from './irmaa-tiers';

const snap = IRMAA_TIERS;

const BAD_CENTS: ReadonlyArray<readonly [string, number]> = [
  ['negative', -1],
  ['fractional', 1000.5],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['MAX_SAFE_INTEGER + 1', Number.MAX_SAFE_INTEGER + 1],
];

/** Factory for IrmaaInput — defaults to 2025, Single, 1 beneficiary, base MAGI. */
function input(overrides: Partial<IrmaaInput> = {}): IrmaaInput {
  return {
    taxYear: 2025,
    magiTwoYearsPriorCents: 80_000_00,
    filingStatus: 'Single',
    beneficiariesOnMedicareCount: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// taxYear validation
// ---------------------------------------------------------------------------

describe('computeIrmaa — taxYear validation', () => {
  it('throws IrmaaInvalidInputError for non-integer taxYear', () => {
    expect(() => computeIrmaa(input({ taxYear: 2025.5 }), snap)).toThrow(IrmaaInvalidInputError);
  });

  it('throws IrmaaInvalidInputError for taxYear below 2000', () => {
    expect(() => computeIrmaa(input({ taxYear: 1999 }), snap)).toThrow(IrmaaInvalidInputError);
  });

  it('throws IrmaaInvalidInputError for taxYear above 2100', () => {
    expect(() => computeIrmaa(input({ taxYear: 2101 }), snap)).toThrow(IrmaaInvalidInputError);
  });

  it('throws IrmaaInvalidInputError for taxYear = NaN', () => {
    expect(() => computeIrmaa(input({ taxYear: NaN }), snap)).toThrow(IrmaaInvalidInputError);
  });

  it('throws IrmaaInvalidInputError for taxYear = Infinity', () => {
    expect(() => computeIrmaa(input({ taxYear: Infinity }), snap)).toThrow(IrmaaInvalidInputError);
  });
});

// ---------------------------------------------------------------------------
// magiTwoYearsPriorCents validation
// ---------------------------------------------------------------------------

describe('computeIrmaa — magiTwoYearsPriorCents validation', () => {
  it.each(BAD_CENTS)('throws IrmaaInvalidInputError for %s magi', (_label, value) => {
    expect(() =>
      computeIrmaa(input({ magiTwoYearsPriorCents: value }), snap),
    ).toThrow(IrmaaInvalidInputError);
  });
});

// ---------------------------------------------------------------------------
// filingStatus validation
// ---------------------------------------------------------------------------

describe('computeIrmaa — filingStatus validation', () => {
  it('throws IrmaaInvalidInputError for invalid filingStatus string', () => {
    // 'QW' is not a supported status (MFS and QSS ARE supported).
    expect(() =>
      computeIrmaa(input({ filingStatus: 'QW' as unknown as IrmaaFilingStatus }), snap),
    ).toThrow(IrmaaInvalidInputError);
  });

  it('accepts MFS and QSS (tax-unit pipeline)', () => {
    expect(() => computeIrmaa(input({ filingStatus: 'MFS' }), snap)).not.toThrow();
    expect(() => computeIrmaa(input({ filingStatus: 'QSS' }), snap)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// mfsLivedWithSpouse runtime validation
// ---------------------------------------------------------------------------

describe('computeIrmaa — mfsLivedWithSpouse validation', () => {
  it('throws for the STRING "true" instead of selecting the byMfs ladder', () => {
    // "true" is truthy in JS — without validation it would wrongly select the
    // steeper byMfs schedule. Must fail fast.
    expect(() =>
      computeIrmaa(
        input({ filingStatus: 'MFS', mfsLivedWithSpouse: 'true' as unknown as boolean }),
        snap,
      ),
    ).toThrow(IrmaaInvalidInputError);
  });

  it('throws for a numeric mfsLivedWithSpouse (1)', () => {
    expect(() =>
      computeIrmaa(
        input({ filingStatus: 'MFS', mfsLivedWithSpouse: 1 as unknown as boolean }),
        snap,
      ),
    ).toThrow(IrmaaInvalidInputError);
  });

  it('accepts genuine boolean and absent mfsLivedWithSpouse', () => {
    expect(() =>
      computeIrmaa(input({ filingStatus: 'MFS', mfsLivedWithSpouse: true }), snap),
    ).not.toThrow();
    expect(() =>
      computeIrmaa(input({ filingStatus: 'MFS', mfsLivedWithSpouse: false }), snap),
    ).not.toThrow();
    expect(() => computeIrmaa(input({ filingStatus: 'MFS' }), snap)).not.toThrow();
  });

  it('validation runs before the field is consulted — invalid mfsLivedWithSpouse + bad year → input error', () => {
    expect(() =>
      computeIrmaa(
        input({ taxYear: 2030, filingStatus: 'MFS', mfsLivedWithSpouse: 'yes' as unknown as boolean }),
        snap,
      ),
    ).toThrow(IrmaaInvalidInputError);
  });
});

// ---------------------------------------------------------------------------
// beneficiariesOnMedicareCount validation
// ---------------------------------------------------------------------------

describe('computeIrmaa — beneficiariesOnMedicareCount validation', () => {
  it('throws IrmaaInvalidInputError for negative count', () => {
    expect(() =>
      computeIrmaa(input({ beneficiariesOnMedicareCount: -1 as unknown as IrmaaInput['beneficiariesOnMedicareCount'] }), snap),
    ).toThrow(IrmaaInvalidInputError);
  });

  it('throws IrmaaInvalidInputError for count > 2', () => {
    expect(() =>
      computeIrmaa(input({ beneficiariesOnMedicareCount: 3 as unknown as IrmaaInput['beneficiariesOnMedicareCount'] }), snap),
    ).toThrow(IrmaaInvalidInputError);
  });

  it('throws IrmaaInvalidInputError for fractional count', () => {
    expect(() =>
      computeIrmaa(input({ beneficiariesOnMedicareCount: 1.5 as unknown as IrmaaInput['beneficiariesOnMedicareCount'] }), snap),
    ).toThrow(IrmaaInvalidInputError);
  });

  it('throws IrmaaInvalidInputError for NaN count', () => {
    expect(() =>
      computeIrmaa(input({ beneficiariesOnMedicareCount: NaN as unknown as IrmaaInput['beneficiariesOnMedicareCount'] }), snap),
    ).toThrow(IrmaaInvalidInputError);
  });
});

// ---------------------------------------------------------------------------
// Validation fires BEFORE snapshot resolution
// ---------------------------------------------------------------------------

describe('computeIrmaa — validation order', () => {
  it('throws IrmaaInvalidInputError (not UnsupportedTaxYearError) when both taxYear=2030 and magiCents=NaN', () => {
    expect(() =>
      computeIrmaa(input({ taxYear: 2030, magiTwoYearsPriorCents: NaN }), snap),
    ).toThrow(IrmaaInvalidInputError);
  });

  it('IrmaaInvalidInputError has code IRMAA_INVALID_INPUT', () => {
    let err: IrmaaInvalidInputError | undefined;
    try {
      computeIrmaa(input({ magiTwoYearsPriorCents: -1 }), snap);
    } catch (e) {
      err = e as IrmaaInvalidInputError;
    }
    expect(err?.code).toBe('IRMAA_INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// Typed error fields — .year and .reason
// ---------------------------------------------------------------------------

describe('computeIrmaa — typed error fields', () => {
  it('UnsupportedTaxYearError exposes .year === 2030', () => {
    let err: UnsupportedTaxYearError | undefined;
    try {
      computeIrmaa(input({ taxYear: 2030 }), snap);
    } catch (e) {
      err = e as UnsupportedTaxYearError;
    }
    expect(err).toBeInstanceOf(UnsupportedTaxYearError);
    expect(err?.year).toBe(2030);
    expect(err?.code).toBe('UNSUPPORTED_TAX_YEAR');
  });

  it('IrmaaInvalidInputError exposes .reason naming the offending field', () => {
    let err: IrmaaInvalidInputError | undefined;
    try {
      computeIrmaa(input({ magiTwoYearsPriorCents: -1 }), snap);
    } catch (e) {
      err = e as IrmaaInvalidInputError;
    }
    expect(err).toBeInstanceOf(IrmaaInvalidInputError);
    expect(err?.reason).toContain('magiTwoYearsPriorCents');
  });
});

// ---------------------------------------------------------------------------
// computeMonthAwareIrmaa input validation — the month-aware engine inlines
// its own taxYear / magiCents / filingStatus / mfsLivedWithSpouse / beneficiary
// validation. It is the engine both projection runners
// charge.
// ---------------------------------------------------------------------------

/** Default full-year enrollment for one beneficiary (both parts, 12 months). */
const FULL_YEAR_BOTH: readonly IrmaaBeneficiaryEnrollment[] = [{ partBMonths: 12, partDMonths: 12 }];

/** Month-aware input factory — 2025 Single tier1 ($110k lookback), overridable. */
function mInput(overrides: Partial<MonthAwareIrmaaInput> = {}): MonthAwareIrmaaInput {
  return {
    taxYear: 2025,
    lookback: { magiCents: 110_000_00, filingStatus: 'Single' },
    beneficiaries: FULL_YEAR_BOTH,
    ...overrides,
  };
}

describe('computeMonthAwareIrmaa — validation', () => {
  it('throws UnsupportedTaxYearError when enrolled but year missing', () => {
    expect(() =>
      computeMonthAwareIrmaa(mInput({ taxYear: 2030 }), snap),
    ).toThrow(UnsupportedTaxYearError);
  });

  it('throws IrmaaInvalidInputError for out-of-range months', () => {
    expect(() =>
      computeMonthAwareIrmaa(mInput({ beneficiaries: [{ partBMonths: 13, partDMonths: 0 }] }), snap),
    ).toThrow(IrmaaInvalidInputError);
  });

  it('throws IrmaaInvalidInputError for a non-integer month count', () => {
    expect(() =>
      computeMonthAwareIrmaa(mInput({ beneficiaries: [{ partBMonths: 6.5, partDMonths: 0 }] }), snap),
    ).toThrow(IrmaaInvalidInputError);
  });

  it('throws IrmaaInvalidInputError for more than 2 beneficiaries', () => {
    expect(() =>
      computeMonthAwareIrmaa(
        mInput({
          beneficiaries: [
            { partBMonths: 12, partDMonths: 12 },
            { partBMonths: 12, partDMonths: 12 },
            { partBMonths: 12, partDMonths: 12 },
          ],
        }),
        snap,
      ),
    ).toThrow(IrmaaInvalidInputError);
  });

  // The month-aware engine inlines its own taxYear / magiCents /
  // filingStatus / mfsLivedWithSpouse validation; exercise each path (not just
  // the beneficiary-months path above).
  it('throws IrmaaInvalidInputError for an out-of-range taxYear', () => {
    expect(() => computeMonthAwareIrmaa(mInput({ taxYear: 1999 }), snap)).toThrow(
      IrmaaInvalidInputError,
    );
  });

  it('throws IrmaaInvalidInputError for a negative lookback magiCents', () => {
    expect(() =>
      computeMonthAwareIrmaa(
        mInput({ lookback: { magiCents: -1, filingStatus: 'Single' } }),
        snap,
      ),
    ).toThrow(IrmaaInvalidInputError);
  });

  it('throws IrmaaInvalidInputError for an unsupported lookback filingStatus', () => {
    expect(() =>
      computeMonthAwareIrmaa(
        mInput({ lookback: { magiCents: 110_000_00, filingStatus: 'BOGUS' as never } }),
        snap,
      ),
    ).toThrow(IrmaaInvalidInputError);
  });

  it('throws IrmaaInvalidInputError for a non-boolean mfsLivedWithSpouse', () => {
    expect(() =>
      computeMonthAwareIrmaa(
        mInput({
          lookback: { magiCents: 110_000_00, filingStatus: 'MFS', mfsLivedWithSpouse: 'yes' as never },
        }),
        snap,
      ),
    ).toThrow(IrmaaInvalidInputError);
  });
});
