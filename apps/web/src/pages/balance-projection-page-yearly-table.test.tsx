/**
 * BalanceProjectionYearlyTable — year-by-year table sub-section render +
 * a11y smoke.
 *
 * Covers the show/hide disclosure, the collapsible `<TableScroll>` grid,
 * the Cap column gating, and the MAGI-cap breach banner.
 * A11y assertion per the project shared-component rule.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BalanceProjectionYearlyTable } from './balance-projection-page-yearly-table';
import { expectNoA11yViolations } from '../test/a11y';
import type { YearlyTableRow } from './balance-projection-page-yearly';

function yearRow(year: number, balance: number): YearlyTableRow {
  return {
    year,
    isCashflowYear: true,
    balanceByMethod: { planned: balance, twr: balance },
    earned: 20_000,
    withdrawal: 30_000,
    totalIncome: 50_000,
    expenses: 50_000,
    shortfall: 0,
    gains: 10_000,
    gainsBreakdown: null,
  };
}

const baseProps = {
  activeMethod: 'planned' as const,
  yearTableOpen: false,
  onToggleYearTable: () => undefined,
  yearTableRows: [yearRow(2030, 500_000), yearRow(2031, 480_000)],
  displayMode: 'today' as const,
};

describe('BalanceProjectionYearlyTable', () => {
  it('renders the disclosure button collapsed and hides the table', () => {
    render(<BalanceProjectionYearlyTable {...baseProps} />);
    expect(
      screen.getByRole('button', { name: 'Show year-by-year table' }),
    ).toBeInTheDocument();
    // The table is now always mounted inside a `<div hidden>` wrapper,
    // so it must drop out of the a11y tree when collapsed — both the grid AND
    // the TableScroll scroll-region landmark are absent (the landmark check
    // catches a regression that strips `hidden` from the wrapper).
    expect(
      screen.queryByRole('grid', { name: 'Year-by-year projection' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Year-by-year projection table' }),
    ).not.toBeInTheDocument();
  });

  it('renders the table grid when open', () => {
    render(<BalanceProjectionYearlyTable {...baseProps} yearTableOpen />);
    expect(
      screen.getByRole('grid', { name: 'Year-by-year projection' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Year' }),
    ).toBeInTheDocument();
  });

  it('shows the Cap column only when MAGI cap is active', () => {
    const { rerender } = render(
      <BalanceProjectionYearlyTable {...baseProps} yearTableOpen />,
    );
    expect(screen.queryByRole('columnheader', { name: 'Cap' })).not.toBeInTheDocument();
    rerender(
      <BalanceProjectionYearlyTable {...baseProps} yearTableOpen isMagiCapActive />,
    );
    expect(screen.getByRole('columnheader', { name: 'Cap' })).toBeInTheDocument();
  });

  it('hides the Roth converted column when no year has a conversion', () => {
    render(<BalanceProjectionYearlyTable {...baseProps} yearTableOpen />);
    expect(
      screen.queryByRole('columnheader', { name: 'Roth converted' }),
    ).not.toBeInTheDocument();
  });

  it('shows the Roth converted column + values when a year has a conversion', () => {
    const rows: YearlyTableRow[] = [
      { ...yearRow(2030, 500_000), rothConverted: 0 },
      { ...yearRow(2031, 480_000), rothConverted: 12_345 },
    ];
    render(
      <BalanceProjectionYearlyTable
        {...baseProps}
        yearTableRows={rows}
        yearTableOpen
      />,
    );
    expect(
      screen.getByRole('columnheader', { name: 'Roth converted' }),
    ).toBeInTheDocument();
    // The converting year shows the dollar amount; the zero year shows em-dash.
    expect(screen.getByText('$12,345')).toBeInTheDocument();
  });

  it('renders the breach banner when breach years are present', () => {
    render(
      <BalanceProjectionYearlyTable
        {...baseProps}
        magiCapBreachYears={[2030, 2032]}
      />,
    );
    expect(screen.getByText(/Cap breached in 2 years \(2030–2032\)/)).toBeInTheDocument();
  });

  it('has no a11y violations when open', async () => {
    const { container } = render(
      <BalanceProjectionYearlyTable {...baseProps} yearTableOpen />,
    );
    await expectNoA11yViolations(container);
  });
});
