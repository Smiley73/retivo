// BalanceProjectionAccountStackSection branching on `accountStackTimeline` (moved out of `balance-projection-page-charts.test.tsx` when the section became its own component).
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BalanceProjectionAccountStackSection } from './balance-projection-page-account-stack-section';
import { ThemeProvider } from '../contexts/ThemeContext';
import type { AccountPayload, Aggregate } from '../db/types';

function account(id: string, name: string): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name,
      type: 'BROKERAGE',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'POST_TAX',
      ownerId: 'm1',
      institution: 'X',
      notes: '',
      planningReturnPct: 5,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

function baseProps() {
  return {
    accounts: [account('a1', 'Brokerage')],
    resolvedLabel: 'Planned',
    isMcBasisActive: false,
    customTiers: null,
    excludedAccountIds: [],
    accountStackTimeline: [
      {
        year: 2030,
        zone: 'projected' as const,
        accountBalances: new Map([
          ['a1', { balance: 500_000, preEnd: 0, postEnd: 500_000 }],
        ]),
      },
      {
        year: 2031,
        zone: 'projected' as const,
        accountBalances: new Map([
          ['a1', { balance: 480_000, preEnd: 0, postEnd: 480_000 }],
        ]),
      },
    ],
    accountStackBoundaryYear: 2029,
    markers: [],
    tooltipMembers: [],
  };
}

describe('BalanceProjectionAccountStackSection — accountStackTimeline branching', () => {
  // The view model's `accountStackTimeline` differs per basis: the deterministic branch emits all-`projected` rows, the MC branch threads historical `actual` rows ahead of the MC representative-run rows through a boundary year. The band consumes the precomputed prop, so these tests render both shapes.
  it('renders the deterministic-branch surface (all projected rows, no boundary)', () => {
    render(
      <ThemeProvider>
        <BalanceProjectionAccountStackSection
          {...baseProps()}
          isMcBasisActive={false}
          accountStackBoundaryYear={null}
          accountStackTimeline={[
            {
              year: 2030,
              zone: 'projected' as const,
              accountBalances: new Map([
                ['a1', { balance: 500_000, preEnd: 0, postEnd: 500_000 }],
              ]),
            },
            {
              year: 2031,
              zone: 'projected' as const,
              accountBalances: new Map([
                ['a1', { balance: 520_000, preEnd: 0, postEnd: 520_000 }],
              ]),
            },
          ]}
        />
      </ThemeProvider>,
    );
    expect(
      screen.getByRole('heading', {
        name: 'Account balances over time (Planned)',
      }),
    ).toBeInTheDocument();
  });

  it('renders the MC-branch surface (historical actual rows ahead of a boundary)', () => {
    render(
      <ThemeProvider>
        <BalanceProjectionAccountStackSection
          {...baseProps()}
          isMcBasisActive
          resolvedLabel="Typical"
          accountStackBoundaryYear={2029}
          accountStackTimeline={[
            {
              year: 2028,
              zone: 'actual' as const,
              accountBalances: new Map([
                ['a1', { balance: 400_000, preEnd: 0, postEnd: 400_000 }],
              ]),
            },
            {
              year: 2029,
              zone: 'actual' as const,
              accountBalances: new Map([
                ['a1', { balance: 420_000, preEnd: 0, postEnd: 420_000 }],
              ]),
            },
            {
              year: 2030,
              zone: 'projected' as const,
              accountBalances: new Map([
                ['a1', { balance: 440_000, preEnd: 0, postEnd: 440_000 }],
              ]),
            },
          ]}
        />
      </ThemeProvider>,
    );
    expect(
      screen.getByRole('heading', {
        name: 'Account balances over time (Typical)',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Based on one example simulated path.'),
    ).toBeInTheDocument();
  });
});
