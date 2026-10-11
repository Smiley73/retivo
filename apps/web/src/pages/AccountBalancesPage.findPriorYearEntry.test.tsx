/** Pure-unit tests for the `findPriorYearEntry` helper exported from AccountBalancesPage. */
import { describe, expect, it } from 'vitest';
import { findPriorYearEntry } from '../pages/AccountBalancesPage';
import type { AccountBalancePayload } from '../db/types';

interface BalanceRowLike extends AccountBalancePayload {
  id: string;
  version: number;
  gainLoss: number;
  returnPct: number;
}

function makeRow(year: number, overrides: Partial<BalanceRowLike> = {}): BalanceRowLike {
  return {
    id: `bal-acc-1-${year}`,
    version: 1,
    accountId: 'acc-1',
    year,
    lastUpdated: `${year}-12-31T23:59:59Z`,
    startingBalance: 0,
    startingBalancePreTax: null,
    startingBalancePostTax: null,
    contributionsPreTax: null,
    contributionsPostTax: null,
    companyContributions: 0,
    companyContributionsPreTax: null,
    companyContributionsPostTax: null,
    rollover: 0,
    distributions: 0,
    endingBalance: 0,
    endingBalancePreTax: null,
    endingBalancePostTax: null,
    totalContributions: 0,
    gainLoss: 0,
    returnPct: 0,
    comment: null,
    ...overrides,
  };
}

describe('findPriorYearEntry', () => {
  it('returns null when no entries exist', () => {
    expect(findPriorYearEntry([], 2024)).toBeNull();
  });

  it('returns null when no entry precedes the given year', () => {
    const list = [makeRow(2024), makeRow(2025)];
    expect(findPriorYearEntry(list, 2024)).toBeNull();
  });

  it('returns the immediately prior year when present', () => {
    const list = [makeRow(2022), makeRow(2023), makeRow(2024)];
    expect(findPriorYearEntry(list, 2024)?.year).toBe(2023);
  });

  it('returns the most recent prior when there is a year gap', () => {
    const list = [makeRow(2018), makeRow(2020), makeRow(2024)];
    expect(findPriorYearEntry(list, 2024)?.year).toBe(2020);
  });

  it('does not consider entries with year >= the target', () => {
    const list = [makeRow(2023), makeRow(2024), makeRow(2025)];
    expect(findPriorYearEntry(list, 2024)?.year).toBe(2023);
  });
});
