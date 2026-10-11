/**
 * Tests for isQualifyingAccount helper and account-type qualification in computeRmd.
 * Covers all 6 PRE_TAX types, non-qualifying types, and MIXED rothPortion variants.
 */

import { describe, it, expect } from 'vitest';
import { computeRmd, isQualifyingAccount, RmdInvalidInputError } from './rmd';
import { SNAPSHOT, OWNER_1950_2025 } from './rmd.test-helpers';

// ---------------------------------------------------------------------------
// isQualifyingAccount helper
// ---------------------------------------------------------------------------

describe('isQualifyingAccount', () => {
  // Traditional IRAs are PRE_TAX only; MIXED applies to employer plans.
  // validateRmdInput rejects RETIREMENT_IRA + MIXED upstream so that row is
  // defensive, but isQualifyingAccount must also return false for correctness.
  // Roth IRA is always non-qualifying; POST_TAX on IRA mirrors Roth.
  it.each([
    ['RETIREMENT_IRA', 'PRE_TAX', true],
    ['RETIREMENT_IRA', 'MIXED', false],
    ['RETIREMENT_IRA', 'POST_TAX', false],
    ['RETIREMENT_401K', 'PRE_TAX', true],
    ['RETIREMENT_401K', 'POST_TAX', false],
    ['RETIREMENT_403B', 'PRE_TAX', true],
    ['RETIREMENT_457B', 'PRE_TAX', true],
    ['RETIREMENT_TSP', 'PRE_TAX', true],
    ['RETIREMENT_CASH_BALANCE', 'PRE_TAX', true],
    ['RETIREMENT_ROTH_IRA', 'ROTH', false],
    ['RETIREMENT_ROTH_IRA', 'PRE_TAX', false],
    ['RETIREMENT_ROTH_401K', 'ROTH', false],
    ['RETIREMENT_ROTH_403B', 'ROTH', false],
    ['RETIREMENT_ROTH_457B', 'ROTH', false],
    ['RETIREMENT_ROTH_TSP', 'ROTH', false],
    ['HSA', 'PRE_TAX', false],
    ['BROKERAGE', 'PRE_TAX', false],
  ] as const)('isQualifyingAccount(%s, %s) is %s', (accountType, taxTreatment, expected) => {
    expect(isQualifyingAccount(accountType, taxTreatment)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// computeRmd — qualifying account types (all 6 PRE_TAX types, positive tests)
// ---------------------------------------------------------------------------

describe('computeRmd — qualifying account types', () => {
  const BASE_INPUT = (accountType: string) => ({
    ...OWNER_1950_2025,
    accounts: [
      {
        id: 'acct1',
        balanceDec31PriorYearCents: 1_000_000,
        accountType: accountType as never,
        taxTreatment: 'PRE_TAX' as const,
      },
    ],
  });

  it('should_qualify_RETIREMENT_IRA_PRE_TAX', () => {
    const r = computeRmd(BASE_INPUT('RETIREMENT_IRA'), SNAPSHOT);
    expect(r.applicable).toBe(true);
    expect(r.ownerRmdCents).toBeGreaterThan(0);
    expect(r.perAccountRmdCents['acct1']).toBeGreaterThan(0);
  });

  it('should_exclude_HSA_and_non_retirement_types', () => {
    const r = computeRmd(
      {
        ...OWNER_1950_2025,
        accounts: [
          { id: 'hsa', balanceDec31PriorYearCents: 1_000_000, accountType: 'HSA', taxTreatment: 'PRE_TAX' },
          { id: 'brok', balanceDec31PriorYearCents: 2_000_000, accountType: 'BROKERAGE', taxTreatment: 'POST_TAX' },
          { id: 'sav', balanceDec31PriorYearCents: 500_000, accountType: 'SAVINGS', taxTreatment: 'POST_TAX' },
          { id: 'mm', balanceDec31PriorYearCents: 500_000, accountType: 'MONEY_MARKET', taxTreatment: 'POST_TAX' },
          { id: 'cd', balanceDec31PriorYearCents: 500_000, accountType: 'CD', taxTreatment: 'POST_TAX' },
          { id: 'other', balanceDec31PriorYearCents: 300_000, accountType: 'OTHER', taxTreatment: 'PRE_TAX' },
        ],
      },
      SNAPSHOT,
    );
    expect(r.ownerRmdCents).toBe(0);
    expect(r.perAccountRmdCents).toEqual({});
  });

});

// ---------------------------------------------------------------------------
// computeRmd — MIXED account handling (SECURE 2.0 §325)
// ---------------------------------------------------------------------------

describe('computeRmd — MIXED account rothPortionCents', () => {
  it('should_use_whole_balance_when_rothPortionCents_omitted_on_MIXED', () => {
    const r = computeRmd(
      {
        ...OWNER_1950_2025,
        accounts: [
          { id: 'mix', balanceDec31PriorYearCents: 20_000_000, accountType: 'RETIREMENT_401K', taxTreatment: 'MIXED' },
        ],
      },
      SNAPSHOT,
    );
    expect(r.qualifyingBalanceCents).toBe(20_000_000); // whole balance used (over-estimate)
    expect(r.ownerRmdCents).toBeGreaterThan(0);
  });

  it('should_subtract_rothPortionCents_from_qualifying_balance_on_MIXED', () => {
    // $200k total, $50k Roth → $150k pre-tax base
    const r = computeRmd(
      {
        ...OWNER_1950_2025,
        accounts: [
          {
            id: 'mix',
            balanceDec31PriorYearCents: 20_000_000, // $200k
            accountType: 'RETIREMENT_401K',
            taxTreatment: 'MIXED',
            rothPortionCents: 5_000_000, // $50k Roth
          },
        ],
      },
      SNAPSHOT,
    );
    expect(r.qualifyingBalanceCents).toBe(15_000_000); // $150k base
    // divisor at age 75 = 24.6; rmd = round(150000 / 24.6 * 100) = round(609756.10...) = 609756
    expect(r.ownerRmdCents).toBe(Math.round((15_000_000 / 100 / 24.6) * 100));
  });

  it('should_produce_zero_rmd_when_rothPortionCents_equals_full_balance_on_MIXED', () => {
    const r = computeRmd(
      {
        ...OWNER_1950_2025,
        accounts: [
          {
            id: 'mix',
            balanceDec31PriorYearCents: 10_000_000,
            accountType: 'RETIREMENT_401K',
            taxTreatment: 'MIXED',
            rothPortionCents: 10_000_000, // entire balance is Roth-designated
          },
        ],
      },
      SNAPSHOT,
    );
    expect(r.applicable).toBe(true);
    expect(r.ownerRmdCents).toBe(0);
    expect(r.perAccountRmdCents).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// computeRmd — RETIREMENT_IRA incoherent tax-treatment
// ---------------------------------------------------------------------------

describe('computeRmd — RETIREMENT_IRA must be PRE_TAX', () => {
  it('should_throw_RmdInvalidInputError_for_RETIREMENT_IRA_with_MIXED_treatment', () => {
    // Traditional IRAs are always PRE_TAX; MIXED applies only to employer plans
    // (401k/403b/TSP) where pre-tax and Roth-designated sub-accounts coexist.
    // RETIREMENT_IRA + MIXED is structurally incoherent → validation rejects it.
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [
            {
              id: 'ira',
              balanceDec31PriorYearCents: 5_000_000,
              accountType: 'RETIREMENT_IRA',
              taxTreatment: 'MIXED',
            },
          ],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [
            {
              id: 'ira',
              balanceDec31PriorYearCents: 5_000_000,
              accountType: 'RETIREMENT_IRA',
              taxTreatment: 'MIXED',
            },
          ],
        },
        SNAPSHOT,
      ),
    ).toThrowError(/RETIREMENT_IRA must have taxTreatment 'PRE_TAX'/);
  });

  it('should_throw_RmdInvalidInputError_for_RETIREMENT_IRA_with_POST_TAX_treatment', () => {
    // POST_TAX on a RETIREMENT_IRA is also incoherent — Roth IRAs are the separate
    // RETIREMENT_ROTH_IRA type; a RETIREMENT_IRA flagged POST_TAX is nonsensical data.
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [
            {
              id: 'ira',
              balanceDec31PriorYearCents: 5_000_000,
              accountType: 'RETIREMENT_IRA',
              taxTreatment: 'POST_TAX',
            },
          ],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [
            {
              id: 'ira',
              balanceDec31PriorYearCents: 5_000_000,
              accountType: 'RETIREMENT_IRA',
              taxTreatment: 'POST_TAX',
            },
          ],
        },
        SNAPSHOT,
      ),
    ).toThrowError(/RETIREMENT_IRA must have taxTreatment 'PRE_TAX'/);
  });
});
