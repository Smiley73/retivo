// YearlyIncomeBreakdownBand: Reset-zoom visibility, with IncomeBreakdownChart and useChartZoom mocked at the module boundary.
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../components/IncomeBreakdownChart', () => ({
  IncomeBreakdownChart: () => <div data-testid="income-breakdown-chart" />,
}));

let mockIsZoomed = false;
const mockReset = vi.fn();

vi.mock('../lib/use-chart-zoom', () => ({
  useChartZoom: () => ({
    xDomain: undefined,
    yDomain: null,
    isZoomed: mockIsZoomed,
    isDragging: false,
    dragSelection: null,
    mouseHandlers: {},
    reset: mockReset,
  }),
}));

import { YearlyIncomeBreakdownBand } from './balance-projection-page-yearly-income-breakdown';

const baseProps = {
  breakdownChartRows: [
    {
      fractionalYear: 2025, year: 2025, month0: 0,
      ss: 24_000, pensionAnnuity: 0, partTime: 12_000,
      oneOff: 0, portfolioAdd: 0, withdrawal: 10_000,
      total: 46_000, expenses: 40_000,
    },
    {
      fractionalYear: 2026, year: 2026, month0: 0,
      ss: 24_000, pensionAnnuity: 0, partTime: 0,
      oneOff: 0, portfolioAdd: 0, withdrawal: 16_000,
      total: 40_000, expenses: 40_000,
    },
  ],
  chartMarkers: [],
  tooltipMembers: [],
  depletionYear: null,
  incomeBreakdownGranularity: 'monthly' as const,
  onGranularityChange: vi.fn(),
  methodLabel: 'Historical',
};

describe('YearlyIncomeBreakdownBand', () => {
  beforeEach(() => {
    mockIsZoomed = false;
    mockReset.mockClear();
  });

  it('renders inside its own labelled card (per-card layout)', () => {
    mockIsZoomed = true;
    render(<YearlyIncomeBreakdownBand {...baseProps} />);
    expect(
      screen.getByRole('region', { name: 'Income breakdown' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /reset view/i }),
    ).toBeInTheDocument();
  });

  it('suffixes the active method label onto the visible title', () => {
    render(<YearlyIncomeBreakdownBand {...baseProps} />);
    expect(
      screen.getByRole('heading', { name: 'Income breakdown (Historical)' }),
    ).toBeInTheDocument();
  });

  it('owns an independent granularity toggle distinct from the cashflow card', async () => {
    const user = userEvent.setup();
    const onGranularityChange = vi.fn();
    render(
      <YearlyIncomeBreakdownBand
        {...baseProps}
        incomeBreakdownGranularity="yearly"
        onGranularityChange={onGranularityChange}
      />,
    );
    const group = screen.getByRole('radiogroup', {
      name: 'Income breakdown chart granularity',
    });
    expect(group).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Monthly' }));
    expect(onGranularityChange).toHaveBeenCalledWith('monthly');
  });
});
