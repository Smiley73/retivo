/** ExpensesProjectionChart legend and theme contract; assertions await the lazy inner chart, never the Suspense fallback. */
import React from 'react';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ExpensesProjectionChart } from './ExpensesProjectionChart';
import ExpensesProjectionChartInner from './ExpensesProjectionChartInner';
import type { ExpenseProjectionMonthlyPoint } from '../lib/expense-projection';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import type { TooltipMember } from './tooltip-member';
import { expectNoA11yViolations } from '../test/a11y';
import { renderWithTheme, seriesColor } from '../test/theme-render';
import { CHART_COLORS } from '../lib/tokens';

const point = (
  year: number,
  month0: number,
): ExpenseProjectionMonthlyPoint => ({
  fractionalYear: year + month0 / 12,
  year,
  month0,
  essential: 36_000,
  discretionary: 18_000,
  total: 54_000,
  oneOffEssential: 0,
  oneOffDiscretionary: 0,
  essentialBase: 36_000,
  discretionaryBase: 18_000,
  oneOffEssentialBase: 0,
  oneOffDiscretionaryBase: 0,
});

const ROWS: ExpenseProjectionMonthlyPoint[] = [
  point(2035, 0),
  point(2035, 6),
  point(2036, 0),
];

const MARKERS: CashflowChartMarker[] = [
  { fractionalYear: 2050.5, label: 'Alex life expectancy 90', color: '#aabbcc' },
];

const MEMBERS: TooltipMember[] = [{ firstName: 'Alex', birthYear: 1975 }];

describe('ExpensesProjectionChart — list-page (breakdown) path', () => {
  it('renders Essential / Discretionary legend entries (no Total) without singleSeriesLabel', async () => {
    const container = renderWithTheme(
      'light',
      <ExpensesProjectionChart rows={ROWS} markers={MARKERS} members={MEMBERS} />,
    );
    expect(await screen.findByText('Essential')).toBeInTheDocument();
    expect(screen.getByText('Discretionary')).toBeInTheDocument();
    expect(screen.queryByText('Total')).not.toBeInTheDocument();
    expect(screen.queryByText('This expense')).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('renders only "This expense" when singleSeriesLabel is set', async () => {
    renderWithTheme(
      'light',
      <ExpensesProjectionChart
        rows={ROWS}
        markers={MARKERS}
        members={MEMBERS}
        singleSeriesLabel="This expense"
      />,
    );
    expect(await screen.findByText('This expense')).toBeInTheDocument();
    expect(screen.queryByText('Total')).not.toBeInTheDocument();
    expect(screen.queryByText('Essential')).not.toBeInTheDocument();
    expect(screen.queryByText('Discretionary')).not.toBeInTheDocument();
  });
});

describe('ExpensesProjectionChart — theme reactivity', () => {
  const renderThemed = (theme: 'light' | 'dark'): HTMLElement =>
    renderWithTheme(
      theme,
      <ExpensesProjectionChartInner rows={ROWS} markers={MARKERS} members={MEMBERS} />,
    );

  it('sources the Essential area fill from the map and flips light↔dark', () => {
    expect(CHART_COLORS.light.essential).not.toBe(CHART_COLORS.dark.essential);
    expect(seriesColor(renderThemed('light'), 'Essential', 'stroke')).toBe(
      CHART_COLORS.light.essential,
    );
    expect(seriesColor(renderThemed('dark'), 'Essential', 'stroke')).toBe(
      CHART_COLORS.dark.essential,
    );
  });
});

describe('ExpensesProjectionChartInner — markers', () => {
  it('renders a marker past the data tail when unzoomed', () => {
    const markerPastData: CashflowChartMarker = {
      fractionalYear: ROWS[ROWS.length - 1].fractionalYear + 2,
      label: 'Retire later',
      color: '#000000',
    };
    const container = renderWithTheme(
      'light',
      <ExpensesProjectionChartInner
        rows={ROWS}
        markers={[markerPastData]}
        members={MEMBERS}
      />,
    );
    expect(
      container.querySelector('[data-marker-label="Retire later"]'),
    ).not.toBeNull();
  });
});

describe('ExpensesProjectionChartInner — drag-zoom', () => {
  it('renders the marquee during a drag selection', () => {
    const container = renderWithTheme(
      'light',
      <ExpensesProjectionChartInner
        rows={ROWS}
        markers={MARKERS}
        members={MEMBERS}
        dragSelection={[2035, 2036]}
      />,
    );
    expect(
      container.querySelector('[data-testid="chart-drag-marquee"]'),
    ).not.toBeNull();
  });
});
