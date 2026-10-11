/**
 * ExpensesProjectionSection — Reset-button visibility.
 *
 * Tests:
 *  - reset_visible_when_zoomed
 *
 * Chart is mocked to a div; useChartZoom mocked at module boundary.
 * Section now owns only the Total-expenses chart body.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../components/ExpensesProjectionChart', () => ({
  ExpensesProjectionChart: () => <div data-testid="expenses-projection-chart" />,
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

import { ExpensesProjectionSection } from './expenses-projection-section';
import type { ExpenseProjectionMonthlyPoint } from '../lib/expense-projection';

const row = (year: number, month0: number): ExpenseProjectionMonthlyPoint => ({
  fractionalYear: year + month0 / 12,
  year,
  month0,
  essential: 3_000,
  discretionary: 1_000,
  total: 4_000,
  oneOffEssential: 0,
  oneOffDiscretionary: 0,
  essentialBase: 3_000,
  discretionaryBase: 1_000,
  oneOffEssentialBase: 0,
  oneOffDiscretionaryBase: 0,
});

const rows = [row(2025, 0), row(2026, 0)];

const baseProps = {
  rows,
  markers: [],
  members: [],
};

describe('ExpensesProjectionSection', () => {
  beforeEach(() => {
    mockIsZoomed = false;
    mockReset.mockClear();
  });

  it('reset_visible_when_zoomed', () => {
    mockIsZoomed = true;
    render(<ExpensesProjectionSection {...baseProps} />);
    expect(
      screen.getByRole('button', { name: /reset view/i }),
    ).toBeInTheDocument();
  });
});
