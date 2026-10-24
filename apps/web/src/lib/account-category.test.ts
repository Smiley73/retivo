import { describe, expect, it } from 'vitest';
import { accountCategory, type AccountCategory } from './account-category';
import type { AccountType } from '../db/types';

const EXPECTED: Record<AccountType, AccountCategory> = {
  RETIREMENT_401K: 'retirement',
  RETIREMENT_IRA: 'retirement',
  RETIREMENT_403B: 'retirement',
  RETIREMENT_457B: 'retirement',
  RETIREMENT_TSP: 'retirement',
  RETIREMENT_CASH_BALANCE: 'retirement',
  RETIREMENT_ROTH_IRA: 'roth',
  RETIREMENT_ROTH_401K: 'roth',
  RETIREMENT_ROTH_403B: 'roth',
  RETIREMENT_ROTH_457B: 'roth',
  RETIREMENT_ROTH_TSP: 'roth',
  BROKERAGE: 'brokerage',
  HSA: 'hsa',
  SAVINGS: 'cash',
  MONEY_MARKET: 'cash',
  CD: 'cash',
  OTHER: 'other',
};

describe('accountCategory', () => {
  it('maps each AccountType to the expected category', () => {
    for (const [type, expected] of Object.entries(EXPECTED) as [
      AccountType,
      AccountCategory,
    ][]) {
      expect(accountCategory(type)).toBe(expected);
    }
  });
});
