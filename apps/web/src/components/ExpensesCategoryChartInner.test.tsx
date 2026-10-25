/** ExpensesCategoryChartInner: the canonical teal retirement marker renders as a dashed vertical line with its label. */
import React from 'react';
import { describe, expect, it } from 'vitest';

import InnerChart from './ExpensesCategoryChartInner';
import type { CategoryMeta } from '../lib/category-palette';
import type { ExpenseCategoryMonthlyPoint } from '../lib/expense-projection';
import type { TooltipMember } from './tooltip-member';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import { expectNoA11yViolations } from '../test/a11y';
import { renderWithTheme } from '../test/theme-render';
import { CHART_COLORS } from '../lib/tokens';

const CATEGORIES: CategoryMeta[] = [
  { id: 'cat-1', name: 'Housing', color: '#0d9488' },
];

function point(year: number): ExpenseCategoryMonthlyPoint {
  return {
    fractionalYear: year,
    year,
    month0: 0,
    byCategoryId: { 'cat-1': 4_000 },
    total: 4_000,
    recurringByCategoryId: { 'cat-1': 4_000 },
    oneOffByCategoryId: {},
  };
}

const ROWS: ExpenseCategoryMonthlyPoint[] = [point(2033), point(2034)];
const MEMBERS: TooltipMember[] = [{ firstName: 'Alex', birthYear: 1975 }];

describe('ExpensesCategoryChartInner — canonical retirement marker', () => {
  it('renders the teal Retires <Mon YYYY> marker line fed by the host', () => {
    const retirement: CashflowChartMarker = {
      fractionalYear: 2033 + 4 / 12,
      label: 'Retires May 2033',
      color: CHART_COLORS.light.retirementMarker,
    };
    const container = renderWithTheme(
      'light',
      <InnerChart
        rows={ROWS}
        categories={CATEGORIES}
        markers={[retirement]}
        members={MEMBERS}
      />,
    );
    const line = container.querySelector(
      '[data-marker-label="Retires May 2033"]',
    );
    expect(line).not.toBeNull();
    expect(line?.getAttribute('stroke')).toBe(
      CHART_COLORS.light.retirementMarker,
    );
    expect(container.textContent).toContain('Retires May 2033');
  });
});

describe('ExpensesCategoryChartInner — a11y', () => {
  it('renders without a11y violations', async () => {
    const container = renderWithTheme(
      'light',
      <InnerChart
        rows={ROWS}
        categories={CATEGORIES}
        markers={[]}
        members={MEMBERS}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
