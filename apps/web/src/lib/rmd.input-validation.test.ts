import { describe, it, expect } from 'vitest';
import { computeRmd, RmdInvalidInputError } from './rmd';
import { SNAPSHOT, OWNER_1950_2025 } from './rmd.test-helpers';

describe('computeRmd — taxYear validation', () => {
  const VALID_ACCOUNT = {
    id: 'ira',
    balanceDec31PriorYearCents: 1_000_000,
    accountType: 'RETIREMENT_IRA' as const,
    taxTreatment: 'PRE_TAX' as const,
  };

  it.each([
    ['Infinity', Infinity],
    ['NaN', NaN],
    ['a non-integer', 2024.5],
  ])('should_throw_RmdInvalidInputError_for_%s_taxYear', (_label, taxYear) => {
    const run = () =>
      computeRmd({ isoBirthdate: '1950-01-01', taxYear, accounts: [VALID_ACCOUNT] }, SNAPSHOT);
    expect(run).toThrow(RmdInvalidInputError);
    expect(run).toThrowError(/taxYear must be a finite safe integer/);
  });
});

describe('computeRmd — balance validation', () => {
  it.each([
    ['negative', -1],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['non-integer', 100.5],
  ])('should_throw_RmdInvalidInputError_for_%s_balance', (_label, balanceDec31PriorYearCents) => {
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [{ id: 'ira', balanceDec31PriorYearCents, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' }],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });
});

describe('computeRmd — rothPortionCents validation', () => {
  it.each([
    ['negative', -1],
    ['non-integer', 100.5],
    ['NaN', NaN],
    ['one cent over the balance', 10_000_001],
  ])('should_throw_RmdInvalidInputError_for_%s_rothPortionCents_on_MIXED', (_label, rothPortionCents) => {
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
              rothPortionCents,
            },
          ],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });

  it.each([
    ['PRE_TAX', 0],
    ['HSA', 100],
  ] as const)('should_throw_RmdInvalidInputError_when_rothPortionCents_supplied_on_%s', (taxTreatment, rothPortionCents) => {
    expect(() =>
      computeRmd(
        {
          ...OWNER_1950_2025,
          accounts: [
            {
              id: 'acct',
              balanceDec31PriorYearCents: 5_000_000,
              accountType: 'RETIREMENT_401K',
              taxTreatment,
              rothPortionCents,
            },
          ],
        },
        SNAPSHOT,
      ),
    ).toThrow(RmdInvalidInputError);
  });

  // An inherited Roth account keeps its untaxed balance out of a pre-tax RMD base through this pocket.
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
});

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

describe('computeRmd — validation fires before trigger-age gate', () => {
  it('should_throw_RmdInvalidInputError_for_negative_balance_even_when_below_trigger_age', () => {
    // Regression: validation once ran after the trigger-age short-circuit, so a below-trigger owner got a silent applicable:false.
    expect(() =>
      computeRmd(
        {
          isoBirthdate: '1990-01-01', // age 35 in 2025, below the age-75 trigger
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
