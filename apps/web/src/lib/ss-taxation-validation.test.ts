/**
 * SS taxation engine — input validation tests (fail-fast rules).
 * Oracle: IRS Pub 915 Worksheet 1 (2024 edition), 26 USC §86.
 */

import { describe, expect, it } from 'vitest';
import {
  computeSsTaxation,
  SsTaxationInvalidInputError,
  UnsupportedTaxYearError,
  type SsTaxThresholds,
} from './ss-taxation';
import { SS_TAX_THRESHOLDS } from './ss-taxation-thresholds';
import { type CalibrationSnapshot } from './calibration';

// ---------------------------------------------------------------------------
// Minimal snapshot for isolation tests (validation-order, clamp, etc.)
// ---------------------------------------------------------------------------
const MINIMAL_SNAPSHOT: CalibrationSnapshot<SsTaxThresholds> = {
  values: {
    2024: SS_TAX_THRESHOLDS.values[2024],
  },
  metadata: {
    source: 'test',
    asOfDate: '2024-01-01',
  },
};

// [title, field, bad value] — each field gets the bad values the cases used.
const BAD_CENTS: ReadonlyArray<readonly [string, string, number]> = [
  ['negative grossSsCents', 'grossSsCents', -1],
  ['NaN otherAgiCents', 'otherAgiCents', NaN],
  ['+Infinity taxExemptInterestCents', 'taxExemptInterestCents', Infinity],
  ['-Infinity grossSsCents', 'grossSsCents', -Infinity],
  ['fractional otherAgiCents (100.5)', 'otherAgiCents', 100.5],
  [
    'unsafe-integer taxExemptInterestCents (MAX_SAFE_INTEGER + 1)',
    'taxExemptInterestCents',
    Number.MAX_SAFE_INTEGER + 1,
  ],
  ['negative otherAgiCents', 'otherAgiCents', -100],
];

// ---------------------------------------------------------------------------
// SsTaxationInvalidInputError — cent field validation
// ---------------------------------------------------------------------------

describe('SsTaxationInvalidInputError — cent field validation', () => {
  const base = {
    grossSsCents: 10_000_00,
    otherAgiCents: 0,
    taxExemptInterestCents: 0,
    filingStatus: 'Single' as const,
    taxYear: 2024,
  };

  it.each(BAD_CENTS)('%s throws', (_label, field, value) => {
    expect(() =>
      computeSsTaxation({ ...base, [field]: value }, MINIMAL_SNAPSHOT),
    ).toThrow(SsTaxationInvalidInputError);
  });

  it('error.code === SS_TAXATION_INVALID_INPUT and reason names the offending field', () => {
    let caught: unknown;
    try {
      computeSsTaxation({ ...base, grossSsCents: -1 }, MINIMAL_SNAPSHOT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SsTaxationInvalidInputError);
    const err = caught as SsTaxationInvalidInputError;
    expect(err.code).toBe('SS_TAXATION_INVALID_INPUT');
    expect(err.reason).toMatch(/grossSsCents/);
  });
});

// ---------------------------------------------------------------------------
// SsTaxationInvalidInputError — taxYear validation
// ---------------------------------------------------------------------------

describe('SsTaxationInvalidInputError — taxYear validation', () => {
  const base = {
    grossSsCents: 10_000_00,
    otherAgiCents: 0,
    taxExemptInterestCents: 0,
    filingStatus: 'Single' as const,
    taxYear: 2024,
  };

  it('NaN taxYear throws', () => {
    expect(() =>
      computeSsTaxation({ ...base, taxYear: NaN }, MINIMAL_SNAPSHOT),
    ).toThrow(SsTaxationInvalidInputError);
  });

  it('Infinity taxYear throws', () => {
    expect(() =>
      computeSsTaxation({ ...base, taxYear: Infinity }, MINIMAL_SNAPSHOT),
    ).toThrow(SsTaxationInvalidInputError);
  });

  it('fractional taxYear (2025.5) throws', () => {
    expect(() =>
      computeSsTaxation({ ...base, taxYear: 2025.5 }, MINIMAL_SNAPSHOT),
    ).toThrow(SsTaxationInvalidInputError);
  });
});

// ---------------------------------------------------------------------------
// SsTaxationInvalidInputError — filing status validation
// ---------------------------------------------------------------------------

describe('SsTaxationInvalidInputError — filing status validation', () => {
  it("'QW' cast as SsTaxFilingStatus throws (MFS and QSS ARE valid)", () => {
    expect(() =>
      computeSsTaxation(
        {
          grossSsCents: 10_000_00,
          otherAgiCents: 0,
          taxExemptInterestCents: 0,
            filingStatus: 'QW' as any, // deliberate runtime bypass to test validation
          taxYear: 2024,
        },
        MINIMAL_SNAPSHOT,
      ),
    ).toThrow(SsTaxationInvalidInputError);
  });

  it('accepts MFS and QSS (tax-unit pipeline)', () => {
    for (const filingStatus of ['MFS', 'QSS'] as const) {
      expect(() =>
        computeSsTaxation(
          { grossSsCents: 10_000_00, otherAgiCents: 0, taxExemptInterestCents: 0, filingStatus, taxYear: 2024 },
          MINIMAL_SNAPSHOT,
        ),
      ).not.toThrow();
    }
  });

  it('error.code === SS_TAXATION_INVALID_INPUT on invalid filingStatus', () => {
    let caught: unknown;
    try {
      computeSsTaxation(
        {
          grossSsCents: 10_000_00,
          otherAgiCents: 0,
          taxExemptInterestCents: 0,
            filingStatus: 'QW' as any, // deliberate runtime bypass to test validation
          taxYear: 2024,
        },
        MINIMAL_SNAPSHOT,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SsTaxationInvalidInputError);
    const err = caught as SsTaxationInvalidInputError;
    expect(err.code).toBe('SS_TAXATION_INVALID_INPUT'); // assert code on filingStatus branch
    expect(err.reason).toMatch(/QW/);
  });
});

// ---------------------------------------------------------------------------
// mfsLivedWithSpouse runtime validation
// ---------------------------------------------------------------------------

describe('mfsLivedWithSpouse runtime validation', () => {
  const base = {
    grossSsCents: 30_000_00,
    otherAgiCents: 20_000_00,
    taxExemptInterestCents: 0,
    filingStatus: 'MFS' as const,
    taxYear: 2024,
  };

  it('non-boolean mfsLivedWithSpouse (the STRING "false") throws instead of being truthy', () => {
    // "false" is truthy in JS — without validation it would wrongly select the
    // §86(c)(1)(C)(ii) zero-base rule. Must fail fast.
    expect(() =>
      computeSsTaxation(
        { ...base, mfsLivedWithSpouse: 'false' as any }, // deliberate runtime bypass
        MINIMAL_SNAPSHOT,
      ),
    ).toThrow(SsTaxationInvalidInputError);
  });

  it('numeric mfsLivedWithSpouse (1) throws', () => {
    expect(() =>
      computeSsTaxation({ ...base, mfsLivedWithSpouse: 1 as any }, MINIMAL_SNAPSHOT),
    ).toThrow(SsTaxationInvalidInputError);
  });

  it('genuine boolean and absent mfsLivedWithSpouse are accepted', () => {
    expect(() => computeSsTaxation({ ...base, mfsLivedWithSpouse: true }, MINIMAL_SNAPSHOT)).not.toThrow();
    expect(() => computeSsTaxation({ ...base, mfsLivedWithSpouse: false }, MINIMAL_SNAPSHOT)).not.toThrow();
    expect(() => computeSsTaxation({ ...base }, MINIMAL_SNAPSHOT)).not.toThrow();
  });

  it('validation runs before snapshot resolution — invalid mfsLivedWithSpouse + bad year → input error', () => {
    expect(() =>
      computeSsTaxation(
        { ...base, taxYear: 2023, mfsLivedWithSpouse: 'yes' as any }, // deliberate runtime bypass
        SS_TAX_THRESHOLDS,
      ),
    ).toThrow(SsTaxationInvalidInputError);
  });
});

// ---------------------------------------------------------------------------
// Validation order — validation fires before snapshot lookup
// ---------------------------------------------------------------------------

describe('validation order', () => {
  it('taxYear=2023 AND grossSsCents=NaN → SsTaxationInvalidInputError (not UnsupportedTaxYearError)', () => {
    // Validation runs first; the invalid-input error surfaces before year-resolution.
    expect(() =>
      computeSsTaxation(
        {
          grossSsCents: NaN,
          otherAgiCents: 0,
          taxExemptInterestCents: 0,
          filingStatus: 'Single',
          taxYear: 2023,
        },
        SS_TAX_THRESHOLDS,
      ),
    ).toThrow(SsTaxationInvalidInputError);
  });

  it('valid input but taxYear below minimum → UnsupportedTaxYearError (not input error)', () => {
    // Confirms that when inputs ARE valid, the year error is the one thrown.
    expect(() =>
      computeSsTaxation(
        {
          grossSsCents: 10_000_00,
          otherAgiCents: 0,
          taxExemptInterestCents: 0,
          filingStatus: 'Single',
          taxYear: 2023,
        },
        SS_TAX_THRESHOLDS,
      ),
    ).toThrow(UnsupportedTaxYearError);
  });
});
