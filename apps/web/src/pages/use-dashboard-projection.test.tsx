/** `allocationByType` from the dashboard hook: whole accounts bucketed by category, ordered, with empty categories dropped. */
import 'fake-indexeddb/auto';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAllStores, putAggregate } from '../db/store';
import type { AccountBalancePayload, AccountPayload, AccountType, Aggregate } from '../db/types';
import { MonteCarloProvider } from '../monte-carlo/MonteCarloProvider';
import { ThemeWrapper } from '../test/theme-render';
import { useDashboardProjection } from './use-dashboard-projection';

const HH = 'hh-dash';

const wrapper = ({ children }: { children: ReactNode }) => (
  <ThemeWrapper>
    <MonteCarloProvider>{children}</MonteCarloProvider>
  </ThemeWrapper>
);

async function seedAccount(
  id: string,
  type: AccountType,
  endingBalance: number | null,
  mixedPostTax: number | null = null,
): Promise<void> {
  const base = { householdId: HH, schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'dev-1' };
  await putAggregate('account', {
    ...base,
    id,
    aggregateType: 'account',
    payload: {
      name: id,
      type,
      ownershipType: 'INDIVIDUAL',
      taxTreatment: mixedPostTax === null ? 'PRE_TAX' : 'MIXED',
      ownerId: 'hm-1',
      institution: 'Bank',
      notes: '',
      planningReturnPct: 7,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    },
  } satisfies Aggregate<AccountPayload>);
  if (endingBalance === null) return;
  await putAggregate('accountBalance', {
    ...base,
    id: `bal-${id}`,
    aggregateType: 'accountBalance',
    payload: {
      accountId: id,
      year: 2025,
      lastUpdated: '2025-12-31T00:00:00Z',
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
      endingBalance,
      endingBalancePreTax: null,
      endingBalancePostTax: mixedPostTax,
      totalContributions: 0,
      comment: null,
    },
  } satisfies Aggregate<AccountBalancePayload>);
}

describe('useDashboardProjection — allocationByType', () => {
  afterEach(async () => {
    await clearAllStores();
  });

  it('is empty with no accounts', async () => {
    const { result } = renderHook(() => useDashboardProjection(), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.allocationByType).toEqual([]);
  });

  // Ids sort in IndexedDB key order and are seeded in that order, with brokerage first and Roth last, so any order other than CATEGORY_ORDER differs.
  it('sums accounts per category in display order and drops categories with no balance', async () => {
    await seedAccount('a', 'BROKERAGE', 50_000);
    await seedAccount('b', 'RETIREMENT_401K', 100_000, 40_000);
    await seedAccount('c', 'RETIREMENT_IRA', 50_000);
    await seedAccount('d', 'RETIREMENT_ROTH_IRA', 50_000);
    await seedAccount('e', 'HSA', null);
    const { result } = renderHook(() => useDashboardProjection(), { wrapper });
    await waitFor(() => expect(result.current.allocationByType).toHaveLength(3));
    expect(result.current.allocationByType).toEqual([
      { category: 'retirement', dollars: 150_000, share: 0.6 },
      { category: 'roth', dollars: 50_000, share: 0.2 },
      { category: 'brokerage', dollars: 50_000, share: 0.2 },
    ]);
  });
});
