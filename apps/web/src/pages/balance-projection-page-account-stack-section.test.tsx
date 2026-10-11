/**
 * BalanceProjectionAccountStackSection — accountStackTimeline branching
 * (moved out of `balance-projection-page-charts.test.tsx` when the Account
 * Balance Stack section split into its own component).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

// The SVG chart engine sizes itself via a ResizeObserver
// with an 800px fallback, so the band renders its SVG content in jsdom
// without any stub (recharts is gone).

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
    // No MC basis active by default, so the resolved label matches the method.
    resolvedLabel: 'Planned',
    isMcBasisActive: false,
    customTiers: null,
    excludedAccountIds: [],
    // A minimal unified timeline so the Account balances over time band renders
    // (mirrors the prior behaviour where it rendered whenever drawdown years
    // existed). Two projected years so the stacked area has ≥ 2 points.
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
  // The view-model's `accountStackTimeline` useMemo produces differently
  // shaped rows per basis — the deterministic branch emits an all-`projected`
  // surface from `accountProjections.yearlyTotals`, while the MC branch threads
  // historical `actual` rows ahead of the projected MC representative-run rows
  // through a boundary year. The band consumes the precomputed prop, so these
  // tests exercise both branch-shaped payloads render the heading without error.
  it('renders the deterministic-branch surface (all projected rows, no boundary)', () => {
    // Deterministic basis (isMcBasisActive=false): every row is `projected`
    // (the projection surface starts at the boundary, no historical actuals).
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
    // baseProps passes resolvedLabel="Planned", so the band suffixes the title.
    expect(
      screen.getByRole('heading', {
        name: 'Account balances over time (Planned)',
      }),
    ).toBeInTheDocument();
  });

  it('renders the MC-branch surface (historical actual rows ahead of a boundary)', () => {
    // MC basis (isMcBasisActive=true): historical `actual` rows precede the
    // boundary year, then the MC representative-run rows render as `projected`.
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
    // Under an MC basis the band suffixes the resolved MC tier label.
    expect(
      screen.getByRole('heading', {
        name: 'Account balances over time (Typical)',
      }),
    ).toBeInTheDocument();
    // The MC representative-run sub-label renders on the band under an MC basis.
    expect(
      screen.getByText('Based on one example simulated path.'),
    ).toBeInTheDocument();
  });
});
