/**
 * account-bucket — exhaustive AccountType → AccountBucket mapping.
 *
 * Covers every enum value so a future AccountType addition that the
 * classifier doesn't intend to fall through to `pretax` is caught here.
 * HSA maps to its own teal `tax_free` bucket (triple-tax-advantaged).
 */
import { describe, expect, it } from 'vitest';
import type { AccountType } from '../db/types';
import { accountBucket, type AccountBucket } from './account-bucket';

describe('accountBucket', () => {
  const cases: ReadonlyArray<[AccountType, AccountBucket]> = [
    ['RETIREMENT_401K', 'pretax'],
    ['RETIREMENT_IRA', 'pretax'],
    ['RETIREMENT_ROTH_IRA', 'roth'],
    ['RETIREMENT_ROTH_401K', 'roth'],
    ['RETIREMENT_ROTH_403B', 'roth'],
    ['RETIREMENT_ROTH_457B', 'roth'],
    ['RETIREMENT_ROTH_TSP', 'roth'],
    ['RETIREMENT_CASH_BALANCE', 'pretax'],
    ['RETIREMENT_403B', 'pretax'],
    ['RETIREMENT_457B', 'pretax'],
    ['RETIREMENT_TSP', 'pretax'],
    ['SAVINGS', 'cash'],
    ['MONEY_MARKET', 'cash'],
    ['BROKERAGE', 'taxable'],
    ['CD', 'cash'],
    ['HSA', 'tax_free'],
    ['OTHER', 'pretax'],
  ];

  it.each(cases)('maps %s → %s', (type, bucket) => {
    expect(accountBucket(type)).toBe(bucket);
  });
});
