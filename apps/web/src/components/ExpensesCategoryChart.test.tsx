import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ExpensesCategoryChart } from './ExpensesCategoryChart';
import ExpensesCategoryChartInner from './ExpensesCategoryChartInner';
import type { ExpenseCategoryMonthlyPoint } from '../lib/expense-projection';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import type { TooltipMember } from './tooltip-member';
import { expectNoA11yViolations } from '../test/a11y';
import { renderWithTheme, seriesColor, withTheme } from '../test/theme-render';
import { CHART_CHROME, CHART_COLORS } from '../lib/tokens';

const CATEGORIES = [
  { id: 'cat-housing', name: 'Housing', color: '#1f77b4' },
  { id: 'cat-travel', name: 'Travel', color: '#ff7f0e' },
] as const;

const point = (
  year: number,
  month0: number,
): ExpenseCategoryMonthlyPoint => ({
  fractionalYear: year + month0 / 12,
  year,
  month0,
  byCategoryId: { 'cat-housing': 24_000, 'cat-travel': 12_000 },
  total: 36_000,
  recurringByCategoryId: { 'cat-housing': 24_000, 'cat-travel': 12_000 },
  oneOffByCategoryId: {},
});

const ROWS: ExpenseCategoryMonthlyPoint[] = [
  point(2035, 0),
  point(2035, 6),
  point(2036, 0),
];

const MARKERS: CashflowChartMarker[] = [
  { fractionalYear: 2040.5, label: 'Retires Jun 2040', color: '#2ca02c' },
  { fractionalYear: 2055.5, label: 'Alex life expectancy 90', color: '#d62728' },
];

const MEMBERS: TooltipMember[] = [{ firstName: 'Alex', birthYear: 1975 }];

describe('ExpensesCategoryChart — category-tab path', () => {
  it('renders one legend entry per category plus the death/retirement markers', async () => {
    const { container } = render(
      withTheme(
        'light',
        <ExpensesCategoryChart
          rows={ROWS}
          categories={CATEGORIES}
          markers={MARKERS}
          members={MEMBERS}
        />,
      ),
    );
    expect(await screen.findByText('Housing')).toBeInTheDocument();
    expect(screen.getByText('Travel')).toBeInTheDocument();
    expect(screen.getByText('Retires Jun 2040')).toBeInTheDocument();
    expect(screen.getByText('Alex life expectancy 90')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('renders the empty-state guard when there are no rows', () => {
    render(<ExpensesCategoryChart rows={[]} categories={CATEGORIES} />);
    expect(
      screen.getByText('No retirement-year expenses to chart yet.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Housing')).not.toBeInTheDocument();
  });

  it('renders the empty-state guard when there are no categories', () => {
    render(<ExpensesCategoryChart rows={ROWS} categories={[]} />);
    expect(
      screen.getByText('No retirement-year expenses to chart yet.'),
    ).toBeInTheDocument();
  });
});

describe('ExpensesCategoryChart — tooltip alphabetical order', () => {
  const unsorted = [
    { id: 'c-travel', name: 'Travel', color: '#ff7f0e' },
    { id: 'c-auto', name: 'Auto', color: '#2ca02c' },
    { id: 'c-housing', name: 'Housing', color: '#1f77b4' },
  ];

  function hoverTooltipNames(byCategoryId: Record<string, number>): string[] {
    const row: ExpenseCategoryMonthlyPoint = {
      ...point(2035, 0),
      byCategoryId,
      total: Object.values(byCategoryId).reduce((a, b) => a + b, 0),
    };
    const { container } = render(
      withTheme(
        'light',
        <ExpensesCategoryChartInner
          rows={[row, point(2036, 0)]}
          categories={unsorted}
          markers={[]}
          members={[]}
        />,
      ),
    );
    const svg = container.querySelector('svg') as SVGSVGElement;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 800, height: 256, right: 800, bottom: 256, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    fireEvent.pointerMove(svg, { clientX: 100 });
    const tooltip = container.querySelector('[role="tooltip"]') as HTMLElement;
    return Array.from(tooltip.querySelectorAll('div.flex.justify-between > span:first-child'))
      .map((el) => el.textContent ?? '')
      .filter((t) => t !== 'Total');
  }

  it('lists tooltip categories strictly A→Z regardless of prop order', () => {
    expect(hoverTooltipNames({ 'c-travel': 1_000, 'c-auto': 2_000, 'c-housing': 3_000 })).toEqual([
      'Auto',
      'Housing',
      'Travel',
    ]);
  });

  it('omits zero-value categories from the tooltip', () => {
    expect(hoverTooltipNames({ 'c-travel': 0, 'c-auto': 0, 'c-housing': 3_000 })).toEqual(['Housing']);
  });

  it('sorts a copy, never mutating the caller-supplied stack order', () => {
    hoverTooltipNames({ 'c-travel': 1_000, 'c-auto': 2_000, 'c-housing': 3_000 });
    expect(unsorted.map((c) => c.name)).toEqual(['Travel', 'Auto', 'Housing']);
  });
});

describe('ExpensesCategoryChartInner — markers', () => {
  it('renders a marker past the data tail when unzoomed', () => {
    const markerPastData: CashflowChartMarker = {
      fractionalYear: ROWS[ROWS.length - 1].fractionalYear + 2,
      label: 'Retire later',
      color: '#000000',
    };
    const container = renderWithTheme(
      'light',
      <ExpensesCategoryChartInner
        rows={ROWS}
        categories={[...CATEGORIES]}
        markers={[markerPastData]}
        members={MEMBERS}
      />,
    );
    expect(
      container.querySelector('[data-marker-label="Retire later"]'),
    ).not.toBeNull();
  });
});

describe('ExpensesCategoryChartInner — drag-zoom', () => {
  it('renders the marquee during a drag selection', () => {
    const container = renderWithTheme(
      'light',
      <ExpensesCategoryChartInner
        rows={ROWS}
        categories={[...CATEGORIES]}
        markers={[]}
        members={MEMBERS}
        dragSelection={[2035, 2036]}
      />,
    );
    expect(
      container.querySelector('[data-testid="chart-drag-marquee"]'),
    ).not.toBeNull();
  });
});

describe('ExpensesCategoryChart — theme contract', () => {
  it('renders the supplied (map-sourced) category color as the area fill', () => {
    for (const theme of ['light', 'dark'] as const) {
      const c = CHART_COLORS[theme];
      const { container, unmount } = render(
        withTheme(
          theme,
          <ExpensesCategoryChartInner
            rows={ROWS}
            categories={[
              { id: 'cat-housing', name: 'Housing', color: c.essential },
              { id: 'cat-travel', name: 'Travel', color: c.discretionary },
            ]}
            markers={[]}
            members={MEMBERS}
          />,
        ),
      );
      expect(seriesColor(container, 'Housing')).toBe(c.essential);
      expect(seriesColor(container, 'Travel')).toBe(c.discretionary);
      unmount();
    }
    expect(CHART_COLORS.light.essential).not.toBe(CHART_COLORS.dark.essential);
  });

  it('re-flips the grid chrome when the live theme toggles (no data change)', () => {
    const gridStroke = (container: HTMLElement): string => {
      const grid = container.querySelector<SVGLineElement>('.chart-grid-line');
      if (!grid) throw new Error('chart grid line not found');
      return grid.getAttribute('stroke') ?? '';
    };
    const chartFor = (theme: 'light' | 'dark'): HTMLElement =>
      renderWithTheme(
        theme,
        <ExpensesCategoryChartInner
          rows={ROWS}
          categories={[...CATEGORIES]}
          markers={[]}
          members={MEMBERS}
        />,
      );
    expect(CHART_CHROME.light.grid).not.toBe(CHART_CHROME.dark.grid);
    expect(gridStroke(chartFor('light'))).toBe(CHART_CHROME.light.grid);
    expect(gridStroke(chartFor('dark'))).toBe(CHART_CHROME.dark.grid);
  });
});
