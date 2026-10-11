/**
 * Tests for rmdTriggerAge helper and trigger-age cutover in computeRmd.
 */

import { describe, it, expect } from 'vitest';
import { computeRmd, rmdTriggerAge } from './rmd';
import { SNAPSHOT } from './rmd.test-helpers';

// ---------------------------------------------------------------------------
// rmdTriggerAge helper
// ---------------------------------------------------------------------------

describe('rmdTriggerAge', () => {
  it.each([
    [1951, 73],
    [1959, 73],
    [1950, 73],
    [1900, 73],
    [1960, 75],
    [1965, 75],
  ])('rmdTriggerAge(%i) is %i', (birthYear, expected) => {
    expect(rmdTriggerAge(birthYear)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// computeRmd — trigger-age cutover
// ---------------------------------------------------------------------------

describe('computeRmd — trigger-age cutover', () => {
  // [isoBirthdate, taxYear, balanceCents, applicable, divisor (when applicable and pinned)]
  it.each([
    // Born 1950 → trigger 73; attains 75 in 2025 → applicable
    ['1950-01-01', 2025, 1_000_000, true, undefined],
    // Born 1951 → trigger 73; attains 73 in 2024 → first RMD year
    ['1951-07-01', 2024, 500_000, true, 26.5],
    // Born 1959 → trigger 73; attains 72 in 2031 → not yet applicable
    ['1959-06-01', 2031, 2_000_000, false, undefined],
    // Born 1959 → trigger 73; attains 73 in 2032
    ['1959-06-01', 2032, 2_000_000, true, 26.5],
    // Born 1960 → trigger 75; attains 72 in 2032 → not applicable
    ['1960-01-01', 2032, 1_000_000, false, undefined],
    // Born 1960 → trigger 75; attains 74 in 2034 → not applicable
    ['1960-06-01', 2034, 1_000_000, false, undefined],
    // Born 1960 → trigger 75; attains 75 in 2035 → first RMD year (age 75 divisor)
    ['1960-06-01', 2035, 1_000_000, true, 24.6],
  ] as const)('born %s, taxYear %i, balance %i → applicable %s', (isoBirthdate, taxYear, balance, applicable, divisor) => {
    const result = computeRmd(
      {
        isoBirthdate,
        taxYear,
        accounts: [{ id: 'a1', balanceDec31PriorYearCents: balance, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' }],
      },
      SNAPSHOT,
    );
    expect(result.applicable).toBe(applicable);
    if (divisor !== undefined) expect(result.divisor).toBe(divisor);
    if (!applicable) {
      expect(result.ownerRmdCents).toBe(0);
      // qualifyingBalanceCents === 0 even though input has non-zero balance (no computation occurred)
      expect(result.qualifyingBalanceCents).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// computeRmd — applicable: false output shape
// ---------------------------------------------------------------------------

describe('computeRmd — applicable: false output shape', () => {
  it('should_zero_all_numeric_fields_and_null_divisor_when_not_applicable', () => {
    // Owner age 70 in 2025 (born 1955 → trigger 73; attains 70 in 2025)
    const result = computeRmd(
      {
        isoBirthdate: '1955-01-01',
        taxYear: 2025,
        accounts: [
          { id: 'ira', balanceDec31PriorYearCents: 50_000_000, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
        ],
      },
      SNAPSHOT,
    );
    expect(result.applicable).toBe(false);
    expect(result.ownerRmdCents).toBe(0);
    expect(result.perAccountRmdCents).toEqual({});
    expect(result.divisor).toBeNull();
    // qualifyingBalanceCents === 0 even though input has non-zero balance; no computation occurred
    expect(result.qualifyingBalanceCents).toBe(0);
  });
});
