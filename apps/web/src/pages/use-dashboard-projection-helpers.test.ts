/**
 * Unit tests for the dashboard projection hook's pure helpers — extracted from
 * the hook so the bucketing math can be exercised directly without rendering.
 */
import { deriveByAccountTypeAllocation } from './use-dashboard-projection';
import type { AccountWithCurrentBalance } from '../lib/balance-calc';

function account(
  overrides: Partial<AccountWithCurrentBalance> = {},
): AccountWithCurrentBalance {
  return {
    id: 'acc-1',
    name: 'Acct',
    ownerDisplayName: 'X',
    type: 'BROKERAGE',
    taxTreatment: 'POST_TAX',
    active: true,
    notes: '',
    currentBalance: 0,
    currentBalancePostTax: null,
    currentBalanceYear: 2025,
    currentBalanceAsOf: '2025-12-31T00:00:00Z',
    twr: null,
    ...overrides,
  };
}

describe('deriveByAccountTypeAllocation', () => {
  it('returns [] for an empty accounts array', () => {
    expect(deriveByAccountTypeAllocation([])).toEqual([]);
  });

  it('groups accounts of different categories into ordered slices', () => {
    const slices = deriveByAccountTypeAllocation([
      account({ id: 'a', type: 'RETIREMENT_401K', currentBalance: 100_000 }),
      account({ id: 'b', type: 'BROKERAGE', currentBalance: 60_000 }),
      account({ id: 'c', type: 'RETIREMENT_ROTH_IRA', currentBalance: 40_000 }),
    ]);
    // CATEGORY_ORDER: retirement → roth → brokerage → ...
    expect(slices.map((s) => s.category)).toEqual([
      'retirement',
      'roth',
      'brokerage',
    ]);
    const retirement = slices.find((s) => s.category === 'retirement')!;
    expect(retirement.dollars).toBe(100_000);
  });

  it('shares sum to 1 (≈100%) when total > 0', () => {
    const slices = deriveByAccountTypeAllocation([
      account({ id: 'a', type: 'RETIREMENT_401K', currentBalance: 100_000 }),
      account({ id: 'b', type: 'BROKERAGE', currentBalance: 60_000 }),
      account({ id: 'c', type: 'HSA', currentBalance: 20_000 }),
    ]);
    const sum = slices.reduce((s, x) => s + x.share, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('omits categories with a $0 (or negative) total balance', () => {
    const slices = deriveByAccountTypeAllocation([
      account({ id: 'a', type: 'RETIREMENT_401K', currentBalance: 100_000 }),
      account({ id: 'b', type: 'BROKERAGE', currentBalance: 0 }),
      account({ id: 'c', type: 'HSA', currentBalance: null }),
    ]);
    expect(slices.map((s) => s.category)).toEqual(['retirement']);
  });

  it('sums multiple accounts in the same category', () => {
    const slices = deriveByAccountTypeAllocation([
      account({ id: 'a', type: 'RETIREMENT_401K', currentBalance: 100_000 }),
      account({ id: 'b', type: 'RETIREMENT_IRA', currentBalance: 50_000 }),
    ]);
    expect(slices).toHaveLength(1);
    expect(slices[0].category).toBe('retirement');
    expect(slices[0].dollars).toBe(150_000);
    expect(slices[0].share).toBeCloseTo(1, 10);
  });

  it('treats a MIXED 401(k) as a whole under retirement (no tax-bucket split)', () => {
    const slices = deriveByAccountTypeAllocation([
      account({
        id: 'm',
        type: 'RETIREMENT_401K',
        taxTreatment: 'MIXED',
        currentBalance: 100_000,
        currentBalancePostTax: 25_000,
      }),
    ]);
    expect(slices).toHaveLength(1);
    expect(slices[0].category).toBe('retirement');
    // The full $100k lands under retirement — NOT split across pre-tax/Roth.
    expect(slices[0].dollars).toBe(100_000);
  });
});
