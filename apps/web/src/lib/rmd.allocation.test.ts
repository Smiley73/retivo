/**
 * Tests for per-account proportional allocation invariants in computeRmd.
 */

import { describe, it, expect } from 'vitest';
import { computeRmd } from './rmd';
import { SNAPSHOT, OWNER_1950_2025 } from './rmd.test-helpers';

// ---------------------------------------------------------------------------
// computeRmd — per-account allocation invariant
// ---------------------------------------------------------------------------

describe('computeRmd — per-account allocation', () => {
  it('should_ensure_sum_of_perAccountRmdCents_equals_ownerRmdCents_exactly', () => {
    const result = computeRmd(
      {
        isoBirthdate: '1950-01-01',
        taxYear: 2025,
        accounts: [
          { id: 'ira1', balanceDec31PriorYearCents: 30_000_000, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
          { id: 'k401', balanceDec31PriorYearCents: 70_000_000, accountType: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX' },
          { id: 'tsp', balanceDec31PriorYearCents: 15_123_456, accountType: 'RETIREMENT_TSP', taxTreatment: 'PRE_TAX' },
        ],
      },
      SNAPSHOT,
    );
    const sum = Object.values(result.perAccountRmdCents).reduce((a, b) => a + b, 0);
    expect(sum).toBe(result.ownerRmdCents);
    expect(result.applicable).toBe(true);
  });

  it('should_omit_non_qualifying_accounts_from_perAccountRmdCents_map', () => {
    const result = computeRmd(
      {
        isoBirthdate: '1950-01-01',
        taxYear: 2025,
        accounts: [
          { id: 'ira', balanceDec31PriorYearCents: 10_000_000, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
          { id: 'brok', balanceDec31PriorYearCents: 5_000_000, accountType: 'BROKERAGE', taxTreatment: 'POST_TAX' },
        ],
      },
      SNAPSHOT,
    );
    expect(Object.keys(result.perAccountRmdCents)).toEqual(['ira']);
    expect(result.perAccountRmdCents['brok']).toBeUndefined();
  });
});

  it('should_produce_non_negative_shares_for_tiny_total_rmd_across_many_accounts', () => {
    // Regression: the earlier Math.round-per-share algo produced -1 cent for
    // the last account when ownerRmdCents=2 and balances=[14,14,14,11].
    // Largest-remainder method guarantees every share ≥ 0.
    const result = computeRmd(
      {
        isoBirthdate: '1950-01-01',
        taxYear: 2025,
        accounts: [
          { id: 'a', balanceDec31PriorYearCents: 14, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
          { id: 'b', balanceDec31PriorYearCents: 14, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
          { id: 'c', balanceDec31PriorYearCents: 14, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
          { id: 'd', balanceDec31PriorYearCents: 11, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
        ],
      },
      SNAPSHOT,
    );
    // Total qualifying balance = 53 cents; divisor at age 75 = 24.6
    // ownerRmdCents = Math.round((53/100) / 24.6 * 100) = Math.round(2.154...) = 2
    expect(result.ownerRmdCents).toBe(2);
    for (const share of Object.values(result.perAccountRmdCents)) {
      expect(share).toBeGreaterThanOrEqual(0);
    }
    const sum = Object.values(result.perAccountRmdCents).reduce((a, b) => a + b, 0);
    expect(sum).toBe(result.ownerRmdCents);
  });

// ---------------------------------------------------------------------------
// computeRmd — zero balance
// ---------------------------------------------------------------------------

describe('computeRmd — zero balance', () => {
  it('should_return_applicable_true_with_zero_rmd_when_all_qualifying_balances_are_zero', () => {
    const result = computeRmd(
      {
        ...OWNER_1950_2025,
        accounts: [
          { id: 'ira', balanceDec31PriorYearCents: 0, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
        ],
      },
      SNAPSHOT,
    );
    expect(result.applicable).toBe(true);
    expect(result.ownerRmdCents).toBe(0);
    expect(result.perAccountRmdCents).toEqual({});
    expect(result.qualifyingBalanceCents).toBe(0);
    expect(result.divisor).not.toBeNull(); // table lookup still occurred
  });
});
