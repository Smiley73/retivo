// BalanceProjectionYearlySection Cap column (present only when `isMagiCapActive`) and breach banner (rendered when `magiCapBreachYears` is non-empty, with the right year range). Chart bands and zoom are mocked at the module boundary.
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../components/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import {
  BalanceProjectionYearlySection,
  type BalanceProjectionYearlyProps,
  type YearlyTableRow,
} from './balance-projection-page-yearly';

function makeRow(year: number, overrides: Partial<YearlyTableRow> = {}): YearlyTableRow {
  return {
    year,
    isCashflowYear: true,
    balanceByMethod: { planned: 500_000, twr: null },
    earned: 0,
    withdrawal: 20_000,
    totalIncome: 20_000,
    expenses: 50_000,
    shortfall: 0,
    gains: 35_000,
    gainsBreakdown: null,
    magiCapBreachDollars: 0,
    magiCapTierOverrideDollars: 0,
    ...overrides,
  };
}

const BASE_PROPS: BalanceProjectionYearlyProps = {
  accountRows: [],
  activeMethod: 'planned',
  displayedTotals: null,
  isMcBasisActive: false,
  hiddenInactiveCount: 0,
  hiddenZeroHistoryCount: 0,
  primaryRetirementYear: 2030,
  viewDeflator: () => 1,
  breakdownTableOpen: true,
  onToggleBreakdownTable: vi.fn(),
  yearTableOpen: true,
  onToggleYearTable: vi.fn(),
  yearTableRows: [makeRow(2030), makeRow(2031)],
  displayMode: 'future',
};

describe('BalanceProjectionYearlySection — Cap column gating', () => {
  it('cap_column_absent_when_isMagiCapActive_not_set', () => {
    render(<BalanceProjectionYearlySection {...BASE_PROPS} />);
    expect(screen.queryByRole('columnheader', { name: /^Cap$/i })).not.toBeInTheDocument();
  });

  it('cap_column_absent_when_isMagiCapActive_false', () => {
    render(<BalanceProjectionYearlySection {...BASE_PROPS} isMagiCapActive={false} />);
    expect(screen.queryByRole('columnheader', { name: /^Cap$/i })).not.toBeInTheDocument();
  });

  it('cap_column_present_when_isMagiCapActive_true', () => {
    render(<BalanceProjectionYearlySection {...BASE_PROPS} isMagiCapActive={true} />);
    // The Cap column header sits in a Tooltip that renders just the text.
    expect(screen.getByRole('columnheader', { name: /^Cap$/i })).toBeInTheDocument();
  });
});

describe('BalanceProjectionYearlySection — Breach banner', () => {
  it('breach_banner_absent_when_no_breach_years', () => {
    render(
      <BalanceProjectionYearlySection
        {...BASE_PROPS}
        magiCapBreachYears={[]}
      />,
    );
    expect(
      screen.queryByText(/Cap breached/i),
    ).not.toBeInTheDocument();
  });

  it('breach_banner_absent_when_magiCapBreachYears_not_provided', () => {
    render(<BalanceProjectionYearlySection {...BASE_PROPS} />);
    expect(
      screen.queryByText(/Cap breached/i),
    ).not.toBeInTheDocument();
  });

  it('breach_banner_shows_singular_count_for_one_year', () => {
    render(
      <BalanceProjectionYearlySection
        {...BASE_PROPS}
        magiCapBreachYears={[2031]}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/Cap breached in 1 year/i)).toBeInTheDocument();
    expect(within(alert).getByText(/2031/)).toBeInTheDocument();
  });

  it('breach_banner_shows_plural_count_and_range_for_multiple_years', () => {
    render(
      <BalanceProjectionYearlySection
        {...BASE_PROPS}
        magiCapBreachYears={[2031, 2033, 2035]}
        // Use years not in yearTableRows (2030, 2031) to avoid a table-row collision.
        yearTableRows={[makeRow(2040), makeRow(2041)]}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/Cap breached in 3 years/i)).toBeInTheDocument();
    expect(within(alert).getByText(/2031/)).toBeInTheDocument();
    expect(within(alert).getByText(/2035/)).toBeInTheDocument();
  });
});
