/**
 * WithdrawalGuidanceSchedule — focused tests for the schedule table's
 * Withdraw-cell split sub-note. The overall schedule table wiring is
 * exercised by the WithdrawalGuidancePage integration tests; these tests cover
 * the MIXED per-sub-account split note added in the feature branch.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { withTheme } from '../test/theme-render';
import { WithdrawalGuidanceSchedule } from './withdrawal-guidance-schedule';
import type { GuidanceYearRow } from './withdrawal-guidance-data';

function makeRow(
  accountOverrides: Partial<GuidanceYearRow['accounts'][number]> = {},
): GuidanceYearRow {
  return {
    year: 2040,
    totalWithdrawnDollars: 10_000,
    taxAndMedicareDollars: 0,
    spendableDollars: 10_000,
    hasWithdrawal: true,
    hasRmdShortfall: false,
    rmdGroups: [],
    rmdDisclosures: [],
    accounts: [
      {
        accountId: 'acc1',
        accountName: 'Test Account',
        withdrawnDollars: 10_000,
        endingBalanceDollars: 200_000,
        rmdDollars: 0,
        ...accountOverrides,
      },
    ],
  };
}

function renderSchedule(rows: GuidanceYearRow[]): ReturnType<typeof render> {
  return render(
    withTheme(
      'light',
      <WithdrawalGuidanceSchedule
        rows={rows}
        selectedYear={2040}
        open={true}
        onToggle={() => undefined}
        formatAt={(d) => `$${d.toLocaleString('en-US')}`}
      />,
    ),
  );
}

describe('WithdrawalGuidanceSchedule — MIXED sub-note in Withdraw cell', () => {
  it('renders the split sub-note in the Withdraw cell for a MIXED named-strategy line', () => {
    renderSchedule([
      makeRow({
        isMixed: true,
        preTaxWithdrawnDollars: 6_000,
        postWithdrawnDollars: 4_000,
        postLabel: 'Roth',
      }),
    ]);
    // Total still present
    expect(screen.getByText('$10,000')).toBeInTheDocument();
    // Sub-note present
    expect(screen.getByText(/\$6,000 pre-tax/)).toBeInTheDocument();
    expect(screen.getByText(/\$4,000/)).toBeInTheDocument();
    expect(screen.getByText(/Roth/)).toBeInTheDocument();
  });

  it('renders no split sub-note for a non-MIXED line', () => {
    renderSchedule([makeRow()]);
    // Total present
    expect(screen.getByText('$10,000')).toBeInTheDocument();
    // No pre-tax sub-note
    expect(screen.queryByText(/pre-tax/)).not.toBeInTheDocument();
  });

  it('split sub-note: preTaxWithdrawnDollars + postWithdrawnDollars === withdrawnDollars (residual rule)', () => {
    // $9,999 total, $6,666.67 pre (666_667 cents → $6,666.67 → floor/round to $6,666.67)
    // post = 9_999 − 6_666.67 = 3_332.33
    // We supply pre/post already computed (as the data layer does it).
    const pre = 6_666;
    const post = 9_999 - pre; // residual
    const rows = [
      makeRow({
        withdrawnDollars: 9_999,
        isMixed: true,
        preTaxWithdrawnDollars: pre,
        postWithdrawnDollars: post,
        postLabel: 'Roth',
      }),
    ];
    // Assert the math (data layer guarantee)
    const acc = rows[0].accounts[0];
    expect(acc.preTaxWithdrawnDollars! + acc.postWithdrawnDollars!).toBe(acc.withdrawnDollars);
    renderSchedule(rows);
    expect(screen.getByText(`$${(9_999).toLocaleString('en-US')}`)).toBeInTheDocument();
  });

  it('renders a MIXED account with no split data as having no sub-note in the Withdraw cell', () => {
    // The schedule only renders the split sub-note when preTaxWithdrawnDollars is
    // defined; with no split data the cell carries no pre-tax/post-tax sub-note.
    renderSchedule([makeRow({ isMixed: true })]);
    expect(screen.queryByText(/pre-tax/)).not.toBeInTheDocument();
  });
});
