// BalanceProjectionYearlyBreakdown: the show/hide disclosure, the per-account grid and totals row, insufficient-history warning gating and hidden-account footer counts. The page-header "Basis" select is the sole method control.
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../components/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { BalanceProjectionYearlyBreakdown } from './balance-projection-page-yearly-breakdown';
import { expectNoA11yViolations } from '../test/a11y';
import type { BreakdownAccountRow } from './balance-projection-page-yearly';
import type { AccountPayload, Aggregate } from '../db/types';
import type { ProjectionOutput } from '../lib/projection';

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

function projOut(total: number): ProjectionOutput {
  return {
    preTax: 0,
    postTax: total,
    total,
    yearlyTotals: [
      { year: 2030, preTax: 0, postTax: total, growth: 0, contributions: 0 },
    ],
  };
}

function row(
  id: string,
  name: string,
  total: number,
  hasInsufficientHistory = false,
): BreakdownAccountRow {
  return {
    account: account(id, name),
    ownerDisplay: 'Alex',
    ownerRetirementDate: '2030-01-01',
    latestBalance: total * 0.5,
    // A short-history account keeps its planned-rate projection on `outputs.twr`, so it stays in the Historical surfaces at the planned rate; `hasInsufficientHistory` drives the warning marker and disclosure, not exclusion.
    outputs: { planned: projOut(total), twr: projOut(total) },
    hasInsufficientHistory,
    ratePctByMethod: { planned: 5, twr: hasInsufficientHistory ? null : 5 },
    perMonthContribution: { preTax: 0, postTax: 0 },
  };
}

const baseProps = {
  accountRows: [row('a1', 'Brokerage One', 200_000), row('a2', 'Brokerage Two', 100_000)],
  activeMethod: 'planned' as const,
  displayedTotals: {
    planned: { total: 300_000, plannedRateCount: 0 },
    twr: { total: 300_000, plannedRateCount: 0 },
  },
  isMcBasisActive: false,
  hiddenInactiveCount: 0,
  hiddenZeroHistoryCount: 0,
  primaryRetirementYear: 2030,
  viewDeflator: () => 1,
  breakdownTableOpen: true,
  onToggleBreakdownTable: vi.fn(),
};

describe('BalanceProjectionYearlyBreakdown', () => {
  it('renders the disclosure button + per-account grid with a totals row when open', () => {
    render(<BalanceProjectionYearlyBreakdown {...baseProps} />);
    expect(
      screen.getByRole('button', { name: 'Hide account-by-account projection' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    const grid = screen.getByRole('grid', { name: /Projected at retirement/ });
    expect(grid).toBeInTheDocument();
    expect(within(grid).getByText('Brokerage One')).toBeInTheDocument();
    expect(grid.querySelector('tr[data-totals="true"]')).not.toBeNull();
  });

  it('collapses the table behind the disclosure button by default', () => {
    render(
      <BalanceProjectionYearlyBreakdown {...baseProps} breakdownTableOpen={false} />,
    );
    expect(
      screen.getByRole('button', { name: 'Show account-by-account projection' }),
    ).toBeInTheDocument();
    // The table is always mounted inside a `<div hidden>` wrapper, so collapsed, both the grid and the TableScroll landmark must drop out of the a11y tree (the landmark check catches a regression that strips `hidden`).
    expect(
      screen.queryByRole('grid', { name: /Projected at retirement/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', {
        name: 'Projected at retirement: account-by-account',
      }),
    ).not.toBeInTheDocument();
  });

  it('calls onToggleBreakdownTable when the disclosure button is clicked', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <BalanceProjectionYearlyBreakdown
        {...baseProps}
        breakdownTableOpen={false}
        onToggleBreakdownTable={onToggle}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: 'Show account-by-account projection' }),
    );
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders the hidden-account footer counts', () => {
    render(
      <BalanceProjectionYearlyBreakdown
        {...baseProps}
        hiddenInactiveCount={2}
        hiddenZeroHistoryCount={1}
      />,
    );
    expect(screen.getByText(/2 inactive accounts hidden/)).toBeInTheDocument();
    expect(screen.getByText(/1 account hidden. No balance history/)).toBeInTheDocument();
  });

  it('shows the planned-rate footnote count under the Historical method', () => {
    render(
      <BalanceProjectionYearlyBreakdown
        {...baseProps}
        activeMethod="twr"
        displayedTotals={{
          planned: { total: 300_000, plannedRateCount: 0 },
          twr: { total: 300_000, plannedRateCount: 2 },
        }}
      />,
    );
    expect(
      screen.getByText(/2 accounts use their planned return here/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/excluded/i)).not.toBeInTheDocument();
  });

  it('marks a short-history account with the ⚠ marker under Historical', () => {
    render(
      <BalanceProjectionYearlyBreakdown
        {...baseProps}
        activeMethod="twr"
        accountRows={[
          row('a1', 'Brokerage One', 200_000),
          row('a2', 'New Roth', 100_000, true),
        ]}
      />,
    );
    expect(
      screen.getByLabelText('Insufficient history for this method'),
    ).toBeInTheDocument();
    const grid = screen.getByRole('grid', { name: /Projected at retirement/ });
    const rothRow = within(grid).getByText('New Roth').closest('tr');
    expect(rothRow).not.toBeNull();
    expect(rothRow?.textContent ?? '').not.toContain('—');
  });

  it('replaces the table with an explanatory note under an MC basis', () => {
    render(<BalanceProjectionYearlyBreakdown {...baseProps} isMcBasisActive />);
    expect(
      screen.getByText(
        /Per-account breakdown is not available for Monte Carlo scenarios/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('grid', { name: /Projected at retirement/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /account-by-account projection/ }),
    ).not.toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    const { container } = render(<BalanceProjectionYearlyBreakdown {...baseProps} />);
    await expectNoA11yViolations(container);
  });
});
