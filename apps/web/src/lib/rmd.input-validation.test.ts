/**
 * Input validation tests for the RMD engine:
 * - balance validation (negative / NaN / Infinity / non-integer)
 * - rothPortionCents validation (non-integer / NaN / negative / over-balance / a
 *   treatment with no Roth-designated pocket)
 * - duplicate and empty account-id validation
 * - below-trigger-age regression (validation fires before trigger-age gate)
 */

import { describe, it, expect } from 'vitest';
import { computeRmd, RmdInvalidInputError } from './rmd';
import { SNAPSHOT, OWNER_1950_2025 } from './rmd.test-helpers';

// ---------------------------------------------------------------------------
// computeRmd — taxYear validation
// ---------------------------------------------------------------------------

describe('computeRmd — taxYear validation', () => {
  const VALID_ACCOUNT = {
    id: 'ira',
    balanceDec31PriorYearCents: 1_000_000,
    accountType: 'RETIREMENT_IRA' as const,
    taxTreatment: 'PRE_TAX' as const,
  };

  it('should_throw_RmdInvalidInputError_for_Infinity_taxYear', () => {
    expect(() =>
      computeRmd(
        { isoBirthdate: '1950-01-01', taxYear: Infinity, accounts: [VALID_ACCOUNT] },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
    expect(() =>
      computeRmd(
        { isoBirthdate: '1950-01-01', taxYear: Infinity, accounts: [VALID_ACCOUNT] },
        SNAPSHOT,
      ),
    ).toThrowError(/taxYear must be a finite safe integer/);
  });

  it('should_throw_RmdInvalidInputError_for_NaN_taxYear', () => {
    expect(() =>
      computeRmd(
        { isoBirthdate: '1950-01-01', taxYear: NaN, accounts: [VALID_ACCOUNT] },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
    expect(() =>
      computeRmd(
        { isoBirthdate: '1950-01-01', taxYear: NaN, accounts: [VALID_ACCOUNT] },
        SNAPSHOT,
      ),
    ).toThrowError(/taxYear must be a finite safe integer/);
  });

  it('should_throw_RmdInvalidInputError_for_non_integer_taxYear', () => {
    expect(() =>
      computeRmd(
        { isoBirthdate: '1950-01-01', taxYear: 2024.5, accounts: [VALID_ACCOUNT] },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
    expect(() =>
      computeRmd(
        { isoBirthdate: '1950-01-01', taxYear: 2024.5, accounts: [VALID_ACCOUNT] },
        SNAPSHOT,
      ),
    ).toThrowError(/taxYear must be a finite safe integer/);
  });
});

// ---------------------------------------------------------------------------
// computeRmd — balance validation
// ---------------------------------------------------------------------------

describe('computeRmd — balance validation', () => {
  it('should_throw_RmdInvalidInputError_for_negative_balance', () => {
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [{ id: 'ira', balanceDec31PriorYearCents: -1, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' }],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });

  it('should_throw_RmdInvalidInputError_for_NaN_balance', () => {
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [{ id: 'ira', balanceDec31PriorYearCents: NaN, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' }],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });

  it('should_throw_RmdInvalidInputError_for_Infinity_balance', () => {
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [{ id: 'ira', balanceDec31PriorYearCents: Infinity, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' }],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });

  it('should_throw_RmdInvalidInputError_for_non_integer_balance', () => {
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [{ id: 'ira', balanceDec31PriorYearCents: 100.5, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' }],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });
});

// ---------------------------------------------------------------------------
// computeRmd — rothPortionCents validation
// ---------------------------------------------------------------------------

describe('computeRmd — rothPortionCents validation', () => {
  it('should_throw_RmdInvalidInputError_when_rothPortionCents_negative_on_MIXED', () => {
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [
            {
              id: 'mix',
              balanceDec31PriorYearCents: 10_000_000,
              accountType: 'RETIREMENT_401K',
              taxTreatment: 'MIXED',
              rothPortionCents: -1,
            },
          ],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });

  it('should_throw_RmdInvalidInputError_for_non_integer_rothPortionCents', () => {
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [
            {
              id: 'mix',
              balanceDec31PriorYearCents: 10_000_000,
              accountType: 'RETIREMENT_401K',
              taxTreatment: 'MIXED',
              rothPortionCents: 100.5,
            },
          ],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });

  it('should_throw_RmdInvalidInputError_for_NaN_rothPortionCents', () => {
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [
            {
              id: 'mix',
              balanceDec31PriorYearCents: 10_000_000,
              accountType: 'RETIREMENT_401K',
              taxTreatment: 'MIXED',
              rothPortionCents: NaN,
            },
          ],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });

  it('should_throw_RmdInvalidInputError_when_rothPortionCents_exceeds_balance_on_MIXED', () => {
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [
            {
              id: 'mix',
              balanceDec31PriorYearCents: 10_000_000,
              accountType: 'RETIREMENT_401K',
              taxTreatment: 'MIXED',
              rothPortionCents: 10_000_001, // 1 cent over
            },
          ],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });

  it('should_throw_RmdInvalidInputError_when_rothPortionCents_supplied_on_PRE_TAX', () => {
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [
            {
              id: 'ira',
              balanceDec31PriorYearCents: 5_000_000,
              accountType: 'RETIREMENT_IRA',
              taxTreatment: 'PRE_TAX',
              rothPortionCents: 0, // even zero throws on non-MIXED
            },
          ],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });

  // POST_TAX / ROTH are exactly the treatments whose WHOLE balance
  // is the §325 Roth-designated pocket, so declaring that pocket on them is valid —
  // it is how an INHERITED Roth account keeps its untaxed balance
  // out of a pre-tax RMD base. Only PRE_TAX and HSA have no pocket to declare.
  it('should_accept_rothPortionCents_on_POST_TAX_and_zero_the_base', () => {
    const result = computeRmd(
      {
        ...OWNER_1950_2025,
        accounts: [
          {
            id: '401k',
            balanceDec31PriorYearCents: 5_000_000,
            accountType: 'RETIREMENT_401K',
            taxTreatment: 'POST_TAX',
            rothPortionCents: 5_000_000,
          },
        ],
      },
      SNAPSHOT,
    );
    expect(result.ownerRmdCents).toBe(0);
  });

  it('should_throw_RmdInvalidInputError_when_rothPortionCents_supplied_on_HSA_treatment', () => {
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [
            {
              id: 'hsa-treated',
              balanceDec31PriorYearCents: 5_000_000,
              accountType: 'RETIREMENT_401K',
              taxTreatment: 'HSA',
              rothPortionCents: 100,
            },
          ],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });
});

// ---------------------------------------------------------------------------
// computeRmd — duplicate and empty account IDs
// ---------------------------------------------------------------------------

describe('computeRmd — duplicate and empty account IDs', () => {
  it('should_throw_RmdInvalidInputError_for_duplicate_account_ids', () => {
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [
            { id: 'ira', balanceDec31PriorYearCents: 1_000_000, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
            { id: 'ira', balanceDec31PriorYearCents: 2_000_000, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
          ],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });

  it('should_throw_RmdInvalidInputError_for_empty_account_id', () => {
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [
            { id: '', balanceDec31PriorYearCents: 1_000_000, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
          ],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });
});

// ---------------------------------------------------------------------------
// computeRmd — validation fires before trigger-age gate (regression)
// ---------------------------------------------------------------------------

describe('computeRmd — validation fires before trigger-age gate', () => {
  it('should_throw_RmdInvalidInputError_for_negative_balance_even_when_below_trigger_age', () => {
    // Regression: prior code ran validateRmdInput AFTER the trigger-age
    // short-circuit, so below-trigger owners with malformed inputs got silent
    // applicable:false instead of throwing. Validation must always precede the gate.
    expect(() =>
      computeRmd(
        {
          // Born 1990 → trigger age 75; taxYear 2025 → age 35 → below trigger
          isoBirthdate: '1990-01-01',
          taxYear: 2025,
          accounts: [
            { id: 'ira', balanceDec31PriorYearCents: -500, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
          ],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });
});
