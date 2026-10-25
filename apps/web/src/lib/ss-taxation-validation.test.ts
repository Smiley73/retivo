// Oracle: IRS Pub 915 Worksheet 1 (2024 edition), 26 USC §86.

import { describe, expect, it } from 'vitest';
import { computeSsTaxation, type SsTaxThresholds } from './ss-taxation';
import { SS_TAX_THRESHOLDS } from './ss-taxation-thresholds';
import { type CalibrationSnapshot } from './calibration';

const MINIMAL_SNAPSHOT: CalibrationSnapshot<SsTaxThresholds> = {
  values: {
    2024: SS_TAX_THRESHOLDS.values[2024],
  },
  metadata: {
    source: 'test',
    asOfDate: '2024-01-01',
  },
};

const invalidInput = (reason?: RegExp) =>
  expect.objectContaining({
    name: 'SsTaxationInvalidInputError',
    code: 'SS_TAXATION_INVALID_INPUT',
    ...(reason !== undefined ? { reason: expect.stringMatching(reason) } : {}),
  });

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

describe('SsTaxationInvalidInputError — cent field validation', () => {
  const base = {
    grossSsCents: 10_000_00,
    otherAgiCents: 0,
    taxExemptInterestCents: 0,
    filingStatus: 'Single' as const,
    taxYear: 2024,
  };

  it.each(BAD_CENTS)('%s throws and the reason names the field', (_label, field, value) => {
    expect(() => computeSsTaxation({ ...base, [field]: value }, MINIMAL_SNAPSHOT)).toThrow(
      invalidInput(new RegExp(field)),
    );
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['fractional (2025.5)', 2025.5],
  ])('%s taxYear throws', (_label, taxYear) => {
    expect(() => computeSsTaxation({ ...base, taxYear }, MINIMAL_SNAPSHOT)).toThrow(invalidInput());
  });
});

describe('SsTaxationInvalidInputError — filing status validation', () => {
  it("'QW' cast as SsTaxFilingStatus throws and the reason names it (MFS and QSS ARE valid)", () => {
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
    ).toThrow(invalidInput(/QW/));
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
});

describe('mfsLivedWithSpouse runtime validation', () => {
  const base = {
    grossSsCents: 30_000_00,
    otherAgiCents: 20_000_00,
    taxExemptInterestCents: 0,
    filingStatus: 'MFS' as const,
    taxYear: 2024,
  };

  it('non-boolean mfsLivedWithSpouse (the STRING "false") throws instead of being truthy', () => {
    // "false" is truthy in JS, so unvalidated it would wrongly select the §86(c)(1)(C)(ii) zero-base rule.
    expect(() =>
      computeSsTaxation(
        { ...base, mfsLivedWithSpouse: 'false' as any }, // deliberate runtime bypass
        MINIMAL_SNAPSHOT,
      ),
    ).toThrow(invalidInput());
  });

  it('numeric mfsLivedWithSpouse (1) throws', () => {
    expect(() =>
      computeSsTaxation({ ...base, mfsLivedWithSpouse: 1 as any }, MINIMAL_SNAPSHOT),
    ).toThrow(invalidInput());
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
    ).toThrow(invalidInput());
  });
});

describe('validation order', () => {
  it('taxYear=2023 AND grossSsCents=NaN → SsTaxationInvalidInputError (not UnsupportedTaxYearError)', () => {
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
    ).toThrow(invalidInput());
  });

  it('valid input but taxYear below minimum → UnsupportedTaxYearError (not input error)', () => {
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
    ).toThrow(expect.objectContaining({ name: 'UnsupportedTaxYearError' }));
  });
});
