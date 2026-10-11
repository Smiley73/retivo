/**
 * YearlyCashflowBand — Reset-button visibility.
 *
 * CashflowProjectionChart mocked; useChartZoom mocked at module boundary.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const chartProps: { expenseMode?: string; categoryMeta?: unknown[] } = {};
vi.mock('../components/CashflowProjectionChart', () => ({
  CashflowProjectionChart: (props: {
    expenseMode?: string;
    categoryMeta?: unknown[];
  }) => {
    chartProps.expenseMode = props.expenseMode;
    chartProps.categoryMeta = props.categoryMeta;
    return <div data-testid="cashflow-chart" />;
  },
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

import { YearlyCashflowBand } from './balance-projection-page-yearly-cashflow';

const baseProps = {
  cashflowGranularity: 'monthly' as const,
  onGranularityChange: vi.fn(),
  cashflowChartRows: [
    {
      fractionalYear: 2025, year: 2025, month0: 0,
      essential: 3_000, discretionary: 1_000, taxes: 0, total: 4_000,
      earned: 60_000, withdrawal: 0, totalIncome: 60_000,
      shortfallBase: 60_000, shortfallHeight: 0,
    },
    {
      fractionalYear: 2026, year: 2026, month0: 0,
      essential: 3_000, discretionary: 1_000, taxes: 0, total: 4_000,
      earned: 60_000, withdrawal: 0, totalIncome: 60_000,
      shortfallBase: 60_000, shortfallHeight: 0,
    },
  ],
  chartMarkers: [],
  tooltipMembers: [],
  depletionYear: null,
  methodLabel: 'Historical',
  categoryMeta: [],
};

describe('YearlyCashflowBand', () => {
  beforeEach(() => {
    mockIsZoomed = false;
    mockReset.mockClear();
  });

  it('renders inside its own labelled card (per-card layout)', () => {
    mockIsZoomed = true;
    render(<YearlyCashflowBand {...baseProps} />);
    expect(
      screen.getByRole('region', { name: 'Expected cashflow' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /reset view/i }),
    ).toBeInTheDocument();
  });

  it('suffixes the active method label onto the visible title', () => {
    render(<YearlyCashflowBand {...baseProps} />);
    expect(
      screen.getByRole('heading', { name: 'Expected cashflow (Historical)' }),
    ).toBeInTheDocument();
  });

  it('owns a granularity toggle whose change handler fires independently', async () => {
    const user = userEvent.setup();
    const onGranularityChange = vi.fn();
    render(
      <YearlyCashflowBand
        {...baseProps}
        cashflowGranularity="yearly"
        onGranularityChange={onGranularityChange}
      />,
    );
    const group = screen.getByRole('radiogroup', {
      name: 'Cashflow chart granularity',
    });
    expect(group).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Monthly' }));
    expect(onGranularityChange).toHaveBeenCalledWith('monthly');
  });

  it('expense-mode toggle defaults to Total and is disabled when no categories', () => {
    render(<YearlyCashflowBand {...baseProps} categoryMeta={[]} />);
    const group = screen.getByRole('radiogroup', {
      name: 'Cashflow expense breakdown',
    });
    // Distinct accessible name from the granularity group.
    expect(group).toBeInTheDocument();
    expect(group).toHaveAttribute('aria-disabled', 'true');
    // Forced to Total (default) and passed down to the chart.
    expect(chartProps.expenseMode).toBe('total');
  });

  it('switching to "By category" threads expenseMode + categoryMeta to the chart', async () => {
    const user = userEvent.setup();
    const categoryMeta = [
      { id: 'cat-housing', name: 'Housing', color: '#0d9488' },
    ];
    render(<YearlyCashflowBand {...baseProps} categoryMeta={categoryMeta} />);
    // Default Total.
    expect(chartProps.expenseMode).toBe('total');
    await user.click(screen.getByRole('radio', { name: 'By category' }));
    expect(chartProps.expenseMode).toBe('category');
    expect(chartProps.categoryMeta).toEqual(categoryMeta);
  });
});
