// ExpensesCategorySection owns only the "Expenses by Category" chart body: Reset-zoom visibility, with the chart mocked to a div and useChartZoom mocked at the module boundary.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../components/ExpensesCategoryChart', () => ({
  ExpensesCategoryChart: () => <div data-testid="expenses-category-chart" />,
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

import { ExpensesCategorySection } from './expenses-category-section';
import type { ExpenseCategoryMonthlyPoint } from '../lib/expense-projection';

const catRow = (year: number, month0: number): ExpenseCategoryMonthlyPoint => ({
  fractionalYear: year + month0 / 12,
  year,
  month0,
  byCategoryId: { c1: 4_000 },
  total: 4_000,
  recurringByCategoryId: { c1: 4_000 },
  oneOffByCategoryId: {},
});

const categoryRows = [catRow(2025, 0), catRow(2026, 0)];

const baseProps = {
  categoryRows,
  categoryMeta: [{ id: 'c1', name: 'Housing', color: '#6366f1' }],
  markers: [],
  members: [],
};

describe('ExpensesCategorySection', () => {
  beforeEach(() => {
    mockIsZoomed = false;
    mockReset.mockClear();
  });

  it('reset_visible_when_zoomed', () => {
    mockIsZoomed = true;
    render(<ExpensesCategorySection {...baseProps} />);
    expect(
      screen.getByRole('button', { name: /reset view/i }),
    ).toBeInTheDocument();
  });
});
