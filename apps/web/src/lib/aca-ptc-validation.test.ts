/**
 * Input validation tests for ACA PTC engine — computeAcaPtc().
 *
 * Computation tests → aca-ptc.test.ts
 * Boundary / edge-case / regime tests → aca-ptc-edge-cases.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  computeAcaPtc,
  UnsupportedTaxYearError,
  AcaPtcInvalidInputError,
  type AcaPtcInput,
} from './aca-ptc';
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

/** Build a valid default input, overridable per-test. */
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

// ---------------------------------------------------------------------------
// strict-year lookup
// ---------------------------------------------------------------------------
describe('computeAcaPtc — strict-year lookup', () => {
  it('throws UnsupportedTaxYearError for an unsupported year', () => {
    expect(() => computeAcaPtc(input({ taxYear: 2023 }), snap)).toThrow(UnsupportedTaxYearError);
  });

  it('UnsupportedTaxYearError has correct year and code', () => {
    try {
      computeAcaPtc(input({ taxYear: 2099 }), snap);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedTaxYearError);
      expect((err as UnsupportedTaxYearError).year).toBe(2099);
      expect((err as UnsupportedTaxYearError).code).toBe('UNSUPPORTED_TAX_YEAR');
    }
  });

  it('succeeds for supported years 2024, 2025, 2026', () => {
    expect(() => computeAcaPtc(input({ taxYear: 2024 }), snap)).not.toThrow();
    expect(() => computeAcaPtc(input({ taxYear: 2025 }), snap)).not.toThrow();
    expect(() => computeAcaPtc(input({ taxYear: 2026 }), snap)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// input validation (fail-fast before snapshot)
// ---------------------------------------------------------------------------
describe('computeAcaPtc — taxYear validation', () => {
  it('throws AcaPtcInvalidInputError for taxYear below range', () => {
    expect(() => computeAcaPtc(input({ taxYear: 1999 }), snap)).toThrow(AcaPtcInvalidInputError);
  });

  it('throws for taxYear above range', () => {
    expect(() => computeAcaPtc(input({ taxYear: 2101 }), snap)).toThrow(AcaPtcInvalidInputError);
  });

  it('throws for non-integer taxYear', () => {
    expect(() => computeAcaPtc(input({ taxYear: 2025.5 }), snap)).toThrow(AcaPtcInvalidInputError);
  });

  it('throws for NaN taxYear', () => {
    expect(() => computeAcaPtc(input({ taxYear: NaN }), snap)).toThrow(AcaPtcInvalidInputError);
  });

  it('throws for Infinity taxYear', () => {
    expect(() => computeAcaPtc(input({ taxYear: Infinity }), snap)).toThrow(AcaPtcInvalidInputError);
  });
});

describe('computeAcaPtc — filingStatus validation', () => {
  it('throws for MFS (§36B(c)(1)(C) ineligible)', () => {
    expect(() =>
      computeAcaPtc(input({ filingStatus: 'MFS' as 'Single' }), snap),
    ).toThrow(AcaPtcInvalidInputError);
  });

  it('throws for empty filingStatus', () => {
    expect(() =>
      computeAcaPtc(input({ filingStatus: '' as 'Single' }), snap),
    ).toThrow(AcaPtcInvalidInputError);
  });

  it('throws for unknown filingStatus', () => {
    expect(() =>
      computeAcaPtc(input({ filingStatus: 'QW' as 'Single' }), snap),
    ).toThrow(AcaPtcInvalidInputError);
  });
});

describe('computeAcaPtc — householdSize validation', () => {
  it('throws for householdSize = 0', () => {
    expect(() => computeAcaPtc(input({ householdSize: 0 }), snap)).toThrow(AcaPtcInvalidInputError);
  });

  it('throws for householdSize < 0', () => {
    expect(() => computeAcaPtc(input({ householdSize: -1 }), snap)).toThrow(AcaPtcInvalidInputError);
  });

  it('throws for non-integer householdSize', () => {
    expect(() => computeAcaPtc(input({ householdSize: 1.5 }), snap)).toThrow(AcaPtcInvalidInputError);
  });
});

describe('computeAcaPtc — magiCents validation', () => {
  it.each(BAD_CENTS)('throws for %s magiCents', (_label, value) => {
    expect(() => computeAcaPtc(input({ magiCents: value }), snap)).toThrow(AcaPtcInvalidInputError);
  });

  it('accepts MAX_SAFE_INTEGER magiCents (boundary — safe integer)', () => {
    // MAX_SAFE_INTEGER is a valid safe integer; engine should not throw on it
    // (though the PTC result will be ineligible since FPL% is enormous)
    expect(() =>
      computeAcaPtc(input({ magiCents: Number.MAX_SAFE_INTEGER }), snap),
    ).not.toThrow();
  });
});

describe('computeAcaPtc — benchmarkAnnualSlcspCents validation', () => {
  it.each(BAD_CENTS)('throws for %s benchmarkAnnualSlcspCents', (_label, value) => {
    expect(() =>
      computeAcaPtc(input({ benchmarkAnnualSlcspCents: value }), snap),
    ).toThrow(AcaPtcInvalidInputError);
  });
});

describe('computeAcaPtc — AcaPtcInvalidInputError shape', () => {
  it('has correct code', () => {
    try {
      computeAcaPtc(input({ householdSize: 0 }), snap);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as AcaPtcInvalidInputError).code).toBe('ACA_PTC_INVALID_INPUT');
    }
  });
});

// ---------------------------------------------------------------------------
// filing status acceptance
// ---------------------------------------------------------------------------
describe('computeAcaPtc — filing status', () => {
  it('MFJ accepted', () => {
    expect(() => computeAcaPtc(input({ filingStatus: 'MFJ' }), snap)).not.toThrow();
  });

  it('HoH accepted', () => {
    expect(() => computeAcaPtc(input({ filingStatus: 'HoH' }), snap)).not.toThrow();
  });

  it('QSS accepted (individual filer, eligible)', () => {
    expect(() => computeAcaPtc(input({ filingStatus: 'QSS' }), snap)).not.toThrow();
  });

  it('MFS rejected (§36B(c)(1)(C) ineligible)', () => {
    expect(() =>
      computeAcaPtc(input({ filingStatus: 'MFS' as 'Single' }), snap),
    ).toThrow(AcaPtcInvalidInputError);
  });
});
