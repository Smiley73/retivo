import { describe, it, expect } from 'vitest';
import { computeIrmaa, computeMonthAwareIrmaa } from './irmaa';
import type { IrmaaBeneficiaryEnrollment } from './irmaa';
import { IRMAA_TIERS } from './irmaa-tiers';

type IrmaaInput = Parameters<typeof computeIrmaa>[0];
type MonthAwareIrmaaInput = Parameters<typeof computeMonthAwareIrmaa>[0];

const snap = IRMAA_TIERS;

const invalidInput = (reason?: string) =>
  expect.objectContaining({
    name: 'IrmaaInvalidInputError',
    code: 'IRMAA_INVALID_INPUT',
    ...(reason !== undefined ? { reason: expect.stringContaining(reason) } : {}),
  });

const BAD_CENTS: ReadonlyArray<readonly [string, number]> = [
  ['negative', -1],
  ['fractional', 1000.5],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['MAX_SAFE_INTEGER + 1', Number.MAX_SAFE_INTEGER + 1],
];

function input(overrides: Partial<IrmaaInput> = {}): IrmaaInput {
  return {
    taxYear: 2025,
    magiTwoYearsPriorCents: 80_000_00,
    filingStatus: 'Single',
    beneficiariesOnMedicareCount: 1,
    ...overrides,
  };
}

describe('computeIrmaa — taxYear validation', () => {
  it.each([
    ['non-integer', 2025.5],
    ['below 2000', 1999],
    ['above 2100', 2101],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('throws IrmaaInvalidInputError for taxYear %s', (_label, taxYear) => {
    expect(() => computeIrmaa(input({ taxYear }), snap)).toThrow(invalidInput());
  });
});

describe('computeIrmaa — magiTwoYearsPriorCents validation', () => {
  it.each(BAD_CENTS)('throws IrmaaInvalidInputError naming the field for %s magi', (_label, value) => {
    expect(() => computeIrmaa(input({ magiTwoYearsPriorCents: value }), snap)).toThrow(
      invalidInput('magiTwoYearsPriorCents'),
    );
  });
});

describe('computeIrmaa — filingStatus validation', () => {
  it('throws IrmaaInvalidInputError for invalid filingStatus string', () => {
    // 'QW' is not a supported status (MFS and QSS ARE supported).
    expect(() =>
      computeIrmaa(input({ filingStatus: 'QW' as unknown as IrmaaInput['filingStatus'] }), snap),
    ).toThrow(invalidInput());
  });

  it('accepts MFS and QSS (tax-unit pipeline)', () => {
    expect(() => computeIrmaa(input({ filingStatus: 'MFS' }), snap)).not.toThrow();
    expect(() => computeIrmaa(input({ filingStatus: 'QSS' }), snap)).not.toThrow();
  });
});

describe('computeIrmaa — mfsLivedWithSpouse validation', () => {
  it('throws for the STRING "true" instead of selecting the byMfs ladder', () => {
    // "true" is truthy in JS, so unvalidated it would wrongly select the steeper byMfs schedule.
    expect(() =>
      computeIrmaa(
        input({ filingStatus: 'MFS', mfsLivedWithSpouse: 'true' as unknown as boolean }),
        snap,
      ),
    ).toThrow(invalidInput());
  });

  it('throws for a numeric mfsLivedWithSpouse (1)', () => {
    expect(() =>
      computeIrmaa(
        input({ filingStatus: 'MFS', mfsLivedWithSpouse: 1 as unknown as boolean }),
        snap,
      ),
    ).toThrow(invalidInput());
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
    ).toThrow(invalidInput());
  });
});

describe('computeIrmaa — beneficiariesOnMedicareCount validation', () => {
  it.each([
    ['negative', -1],
    ['> 2', 3],
    ['fractional', 1.5],
    ['NaN', NaN],
  ])('throws IrmaaInvalidInputError for %s count', (_label, count) => {
    expect(() =>
      computeIrmaa(
        input({ beneficiariesOnMedicareCount: count as unknown as IrmaaInput['beneficiariesOnMedicareCount'] }),
        snap,
      ),
    ).toThrow(invalidInput());
  });
});

describe('computeIrmaa — validation order', () => {
  it('throws IrmaaInvalidInputError (not UnsupportedTaxYearError) when both taxYear=2030 and magiCents=NaN', () => {
    expect(() =>
      computeIrmaa(input({ taxYear: 2030, magiTwoYearsPriorCents: NaN }), snap),
    ).toThrow(invalidInput());
  });
});

const FULL_YEAR_BOTH: readonly IrmaaBeneficiaryEnrollment[] = [{ partBMonths: 12, partDMonths: 12 }];

function mInput(overrides: Partial<MonthAwareIrmaaInput> = {}): MonthAwareIrmaaInput {
  return {
    taxYear: 2025,
    lookback: { magiCents: 110_000_00, filingStatus: 'Single' },
    beneficiaries: FULL_YEAR_BOTH,
    ...overrides,
  };
}

// The month-aware engine inlines its own validation, so each path is exercised here.
describe('computeMonthAwareIrmaa — validation', () => {
  it('throws UnsupportedTaxYearError with the year when enrolled but year missing', () => {
    expect(() => computeMonthAwareIrmaa(mInput({ taxYear: 2030 }), snap)).toThrow(
      expect.objectContaining({ name: 'UnsupportedTaxYearError', year: 2030, code: 'UNSUPPORTED_TAX_YEAR' }),
    );
  });

  it.each([
    ['out-of-range months', { beneficiaries: [{ partBMonths: 13, partDMonths: 0 }] }],
    ['a non-integer month count', { beneficiaries: [{ partBMonths: 6.5, partDMonths: 0 }] }],
    [
      'more than 2 beneficiaries',
      {
        beneficiaries: [
          { partBMonths: 12, partDMonths: 12 },
          { partBMonths: 12, partDMonths: 12 },
          { partBMonths: 12, partDMonths: 12 },
        ],
      },
    ],
    ['an out-of-range taxYear', { taxYear: 1999 }],
    ['a negative lookback magiCents', { lookback: { magiCents: -1, filingStatus: 'Single' } }],
    [
      'an unsupported lookback filingStatus',
      { lookback: { magiCents: 110_000_00, filingStatus: 'BOGUS' as never } },
    ],
    [
      'a non-boolean mfsLivedWithSpouse',
      { lookback: { magiCents: 110_000_00, filingStatus: 'MFS', mfsLivedWithSpouse: 'yes' as never } },
    ],
  ] as const)('throws IrmaaInvalidInputError for %s', (_label, overrides) => {
    expect(() => computeMonthAwareIrmaa(mInput(overrides as Partial<MonthAwareIrmaaInput>), snap)).toThrow(
      invalidInput(),
    );
  });
});
