/**
 * YearlyPortfolioFlowsBand — Reset-button visibility.
 *
 * PortfolioFlowsChart mocked; useChartZoom mocked at module boundary.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expectNoA11yViolations } from '../test/a11y';

vi.mock('../components/PortfolioFlowsChart', () => ({
  PortfolioFlowsChart: () => <div data-testid="portfolio-flows-chart" />,
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

import { YearlyPortfolioFlowsBand } from './balance-projection-page-yearly-portfolio-flows';

const baseProps = {
  portfolioFlowsRows: [
    { year: 2025, contributions: 10_000, gains: 30_000, deposits: 5_000, withdrawals: 0, qcd: 0, netChange: 45_000 },
    { year: 2026, contributions: 10_000, gains: 28_000, deposits: 0, withdrawals: 0, qcd: 0, netChange: 38_000 },
  ],
  chartMarkers: [],
  tooltipMembers: [],
  depletionYear: null,
  methodLabel: 'Historical',
};

describe('YearlyPortfolioFlowsBand', () => {
  beforeEach(() => {
    mockIsZoomed = false;
    mockReset.mockClear();
  });

  it('suffixes the active method label onto the visible title', () => {
    mockIsZoomed = true;
    render(<YearlyPortfolioFlowsBand {...baseProps} />);
    expect(
      screen.getByRole('heading', { name: 'Annual Portfolio Flow (Historical)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /reset view/i }),
    ).toBeInTheDocument();
  });

  it('the info popover explains the flow-vs-budget difference: activate reveals, Esc dismisses', async () => {
    const user = userEvent.setup();
    render(<YearlyPortfolioFlowsBand {...baseProps} />);
    // Hidden until the info-icon trigger is activated.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.tab();
    await user.keyboard('{Enter}');
    const popover = await screen.findByRole('dialog');
    expect(popover).toHaveTextContent(/actual cash drawn from your invested accounts/i);
    expect(popover).toHaveTextContent(/budgeted need for the year/i);
    // Esc dismisses the revealed popover.
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });

  it('has no a11y violations (info popover revealed)', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<YearlyPortfolioFlowsBand {...baseProps} />);
    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog');
    // React Aria portals the popover outside the render container.
    await expectNoA11yViolations(baseElement);
  });
});
