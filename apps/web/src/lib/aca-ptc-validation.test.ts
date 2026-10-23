import { describe, it, expect } from 'vitest';
import { computeAcaPtc, AcaPtcInvalidInputError, type AcaPtcInput } from './aca-ptc';
import { ACA_PTC_PARAMETERS } from './aca-ptc-parameters';

const snap = ACA_PTC_PARAMETERS;

const BAD_CENTS: ReadonlyArray<readonly [string, number]> = [
  ['negative', -1],
  ['non-integer (float)', 100.5],
  ['NaN', NaN],
  ['+Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['MAX_SAFE_INTEGER + 1 (unsafe integer)', Number.MAX_SAFE_INTEGER + 1],
];

function input(overrides: Partial<AcaPtcInput> = {}): AcaPtcInput {
  return {
    taxYear: 2025,
    filingStatus: 'Single',
    householdSize: 1,
    magiCents: 2_800_000,
    benchmarkAnnualSlcspCents: 600_000,
    ...overrides,
  };
}

describe('computeAcaPtc — strict-year lookup', () => {
  it.each([2023, 2099])('throws UnsupportedTaxYearError with the year and code for %i', (taxYear) => {
    expect(() => computeAcaPtc(input({ taxYear }), snap)).toThrow(
      expect.objectContaining({ name: 'UnsupportedTaxYearError', year: taxYear, code: 'UNSUPPORTED_TAX_YEAR' }),
    );
  });

  it('succeeds for supported years 2024, 2025, 2026', () => {
    expect(() => computeAcaPtc(input({ taxYear: 2024 }), snap)).not.toThrow();
    expect(() => computeAcaPtc(input({ taxYear: 2025 }), snap)).not.toThrow();
    expect(() => computeAcaPtc(input({ taxYear: 2026 }), snap)).not.toThrow();
  });
});

describe('computeAcaPtc — input validation (fail-fast before snapshot)', () => {
  it.each([
    ['below range', 1999],
    ['above range', 2101],
    ['non-integer', 2025.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('throws for taxYear %s', (_label, taxYear) => {
    expect(() => computeAcaPtc(input({ taxYear }), snap)).toThrow(AcaPtcInvalidInputError);
  });

  it.each([
    ['MFS (§36B(c)(1)(C) ineligible)', 'MFS'],
    ['an empty filingStatus', ''],
    ['an unknown filingStatus', 'QW'],
  ])('throws for %s', (_label, filingStatus) => {
    expect(() =>
      computeAcaPtc(input({ filingStatus: filingStatus as 'Single' }), snap),
    ).toThrow(AcaPtcInvalidInputError);
  });

  it.each([0, -1, 1.5])('throws for householdSize %d', (householdSize) => {
    expect(() => computeAcaPtc(input({ householdSize }), snap)).toThrow(
      expect.objectContaining({ name: 'AcaPtcInvalidInputError', code: 'ACA_PTC_INVALID_INPUT' }),
    );
  });

  it.each(BAD_CENTS)('throws for %s magiCents', (_label, value) => {
    expect(() => computeAcaPtc(input({ magiCents: value }), snap)).toThrow(AcaPtcInvalidInputError);
  });

  it('accepts MAX_SAFE_INTEGER magiCents (boundary — safe integer)', () => {
    expect(() => computeAcaPtc(input({ magiCents: Number.MAX_SAFE_INTEGER }), snap)).not.toThrow();
  });

  it.each(BAD_CENTS)('throws for %s benchmarkAnnualSlcspCents', (_label, value) => {
    expect(() =>
      computeAcaPtc(input({ benchmarkAnnualSlcspCents: value }), snap),
    ).toThrow(AcaPtcInvalidInputError);
  });

  it.each(['MFJ', 'HoH', 'QSS'] as const)('accepts filingStatus %s', (filingStatus) => {
    expect(() => computeAcaPtc(input({ filingStatus }), snap)).not.toThrow();
  });
});
