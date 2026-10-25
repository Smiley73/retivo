/** CashflowProjectionChartInner: tooltip granularity, theme-reactive fills, legend isolation, category mode, markers and drag-zoom. */
import React from 'react';
import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import InnerChart from './CashflowProjectionChartInner';
import { makeCashflowTooltip } from './CashflowProjectionChartInner.tooltip';
import type {
  CashflowChartMarker,
  CashflowMonthlyPoint,
} from './CashflowProjectionChart';
import type { TooltipMember } from './tooltip-member';
import type { ChartDatum } from './charts';
import { expectNoA11yViolations } from '../test/a11y';
import { renderWithTheme, seriesColor } from '../test/theme-render';
import { CHART_COLORS, CHART_CHROME } from '../lib/tokens';

const POINT: CashflowMonthlyPoint = {
  fractionalYear: 2035 + 8 / 12,
  year: 2035,
  month0: 8, // September
  essential: 30_000,
  discretionary: 10_000,
  taxes: 0,
  total: 40_000,
  earned: 25_000,
  withdrawal: 15_000,
  totalIncome: 40_000,
  shortfallBase: 40_000,
  shortfallHeight: 0,
};

const MEMBERS: TooltipMember[] = [{ firstName: 'Alex', birthYear: 1975 }];

function renderTip(
  granularity: 'monthly' | 'yearly',
): ReturnType<typeof render> {
  const tip = makeCashflowTooltip(
    MEMBERS,
    granularity,
    CHART_COLORS.light,
    CHART_CHROME.light,
  );
  const node = tip({ ...POINT, x: POINT.fractionalYear } as unknown as ChartDatum);
  return render(<>{node}</>);
}

describe('CashflowProjectionChartInner — tooltip granularity', () => {
  it('shows "Sep 2035" + whole-year age in monthly mode', () => {
    const { getByText } = renderTip('monthly');
    expect(getByText('Sep 2035')).toBeTruthy();
    expect(getByText('Alex (age 60)')).toBeTruthy();
  });

  it('omits the month (just "2035") + whole-year age in yearly mode', () => {
    const { queryByText, getByText } = renderTip('yearly');
    expect(queryByText('Sep 2035')).toBeNull();
    expect(getByText('2035')).toBeTruthy();
    expect(getByText('Alex (age 60)')).toBeTruthy();
  });

  it('renders a Taxes row with the point.taxes value', () => {
    const tip = makeCashflowTooltip(
      MEMBERS,
      'yearly',
      CHART_COLORS.light,
      CHART_CHROME.light,
    );
    const taxed: CashflowMonthlyPoint = { ...POINT, taxes: 7_000, total: 47_000 };
    const node = tip({ ...taxed, x: taxed.fractionalYear } as unknown as ChartDatum);
    const { getByText } = render(<>{node}</>);
    const label = getByText('Taxes');
    expect(label).toBeTruthy();
    expect(label.parentElement?.textContent).toContain('$7,000');
  });

  it('names a negative Taxes band the credit applied to premiums', () => {
    const tip = makeCashflowTooltip(
      MEMBERS,
      'yearly',
      CHART_COLORS.light,
      CHART_CHROME.light,
    );
    const credited: CashflowMonthlyPoint = { ...POINT, taxes: -5_134.2, total: 34_865.8 };
    const node = tip({ ...credited, x: credited.fractionalYear } as unknown as ChartDatum);
    const { getByText, queryByText } = render(<>{node}</>);
    const label = getByText('Credit applied to premiums');
    expect(label.parentElement?.textContent).toContain('$5,134');
    expect(queryByText('Taxes')).toBeNull();
  });

  it('category mode lists per-category rows + Taxes + Total income (no essential/discretionary)', () => {
    const tip = makeCashflowTooltip(
      MEMBERS,
      'yearly',
      CHART_COLORS.light,
      CHART_CHROME.light,
      new Set(),
      {
        expenseMode: 'category',
        categoryMeta: [
          { id: 'cat-housing', name: 'Housing', color: '#0d9488' },
          { id: 'cat-medical', name: 'Medical', color: '#7c3aed' },
        ],
      },
    );
    const point: CashflowMonthlyPoint = {
      ...POINT,
      taxes: 5_000,
      total: 45_000,
      byCategory: { 'cat-housing': 24_000, 'cat-medical': 16_000 },
    };
    const { byCategory, ...flat } = point;
    const datum = { ...flat, x: point.fractionalYear } as unknown as ChartDatum;
    for (const [id, v] of Object.entries(byCategory ?? {})) {
      datum[`cat-${id}`] = v;
    }
    const node = tip(datum);
    const { getByText, queryByText } = render(<>{node}</>);
    expect(getByText('Housing')).toBeTruthy();
    expect(getByText('Medical')).toBeTruthy();
    expect(getByText('Taxes')).toBeTruthy();
    expect(getByText('Total income')).toBeTruthy();
    expect(queryByText('Essential')).toBeNull();
    expect(queryByText('Discretionary')).toBeNull();
  });
});

const ROWS: CashflowMonthlyPoint[] = [
  POINT,
  { ...POINT, year: 2036, month0: 0, fractionalYear: 2036 },
];

function renderThemed(theme: 'light' | 'dark'): HTMLElement {
  return renderWithTheme(
    theme,
    <InnerChart
      rows={ROWS}
      markers={[]}
      depletionYear={null}
      members={MEMBERS}
      granularity="yearly"
      expenseMode="total"
      categoryMeta={[]}
    />,
  );
}

describe('CashflowProjectionChartInner — theme reactivity', () => {
  it('sources the Essential area fill from the map and flips light↔dark', () => {
    expect(CHART_COLORS.light.essential).not.toBe(CHART_COLORS.dark.essential);
    expect(seriesColor(renderThemed('light'), 'Essential')).toBe(
      CHART_COLORS.light.essential,
    );
    expect(seriesColor(renderThemed('dark'), 'Essential')).toBe(
      CHART_COLORS.dark.essential,
    );
  });
});

describe('CashflowProjectionChartInner — legend show/hide (isolate-first)', () => {
  it('hides the invisible shortfall-base helper together with Shortfall', () => {
    const shortfallRows: CashflowMonthlyPoint[] = [
      { ...POINT, totalIncome: 35_000, shortfallBase: 35_000, shortfallHeight: 5_000 },
      { ...POINT, year: 2036, month0: 0, fractionalYear: 2036, totalIncome: 35_000, shortfallBase: 35_000, shortfallHeight: 5_000 },
    ];
    const container = renderWithTheme(
      'light',
      <InnerChart
        rows={shortfallRows}
        markers={[]}
        depletionYear={null}
        members={MEMBERS}
        granularity="yearly"
        expenseMode="total"
        categoryMeta={[]}
      />,
    );
    expect(container.querySelector('path[name="Shortfall"]')).not.toBeNull();
    expect(container.querySelector('path[name="shortfall-base"]')).not.toBeNull();

    // The invisible shortfall base shares legendId 'Shortfall', so isolating another entry hides both and the base cannot keep inflating Y.
    fireEvent.click(
      within(container).getByRole('button', { name: 'Total income' }),
    );
    expect(container.querySelector('path[name="Shortfall"]')).toBeNull();
    expect(container.querySelector('path[name="shortfall-base"]')).toBeNull();
  });
});

describe('CashflowProjectionChartInner — category mode', () => {
  const CATEGORY_META = [
    { id: 'cat-housing', name: 'Housing', color: '#0d9488' },
    { id: 'cat-medical', name: 'Medical', color: '#7c3aed' },
  ];
  const CAT_ROWS: CashflowMonthlyPoint[] = [
    { ...POINT, byCategory: { 'cat-housing': 24_000, 'cat-medical': 16_000 } },
    {
      ...POINT,
      year: 2036,
      month0: 0,
      fractionalYear: 2036,
      byCategory: { 'cat-housing': 24_000, 'cat-medical': 16_000 },
    },
  ];

  function renderCategory(): HTMLElement {
    return renderWithTheme(
      'light',
      <InnerChart
        rows={CAT_ROWS}
        markers={[]}
        depletionYear={null}
        members={MEMBERS}
        granularity="yearly"
        expenseMode="category"
        categoryMeta={CATEGORY_META}
      />,
    );
  }

  it('renders one expense band per category (replacing essential/discretionary) + Taxes + income line', () => {
    const container = renderCategory();
    expect(container.querySelector('path[name="Housing"]')).not.toBeNull();
    expect(container.querySelector('path[name="Medical"]')).not.toBeNull();
    expect(container.querySelector('path[name="Essential"]')).toBeNull();
    expect(container.querySelector('path[name="Discretionary"]')).toBeNull();
    expect(container.querySelector('path[name="Taxes"]')).not.toBeNull();
    expect(container.querySelector('path[name="Total income"]')).not.toBeNull();
    expect(seriesColor(container, 'Housing')).toBe('#0d9488');
  });

  it('total mode renders essential/discretionary, not category bands', () => {
    const container = renderThemed('light');
    expect(container.querySelector('path[name="Essential"]')).not.toBeNull();
    expect(container.querySelector('path[name="Housing"]')).toBeNull();
  });

  it('renders without a11y violations in category mode', async () => {
    await expectNoA11yViolations(renderCategory());
  });
});

describe('CashflowProjectionChartInner — markers', () => {
  it('renders a marker past the data tail when unzoomed (extends domain)', () => {
    const markerPastData: CashflowChartMarker = {
      fractionalYear: ROWS[ROWS.length - 1].fractionalYear + 2,
      label: 'Retire later',
      color: '#000000',
    };
    const container = renderWithTheme(
      'light',
      <InnerChart
        rows={ROWS}
        markers={[markerPastData]}
        depletionYear={null}
        members={MEMBERS}
        granularity="yearly"
        expenseMode="total"
        categoryMeta={[]}
      />,
    );
    expect(
      container.querySelector('[data-marker-label="Retire later"]'),
    ).not.toBeNull();
  });

  it('renders the teal Retires <Mon YYYY> marker fed by the host', () => {
    const retirement: CashflowChartMarker = {
      fractionalYear: 2035 + 5 / 12,
      label: 'Retires May 2035',
      color: CHART_COLORS.light.retirementMarker,
    };
    const container = renderWithTheme(
      'light',
      <InnerChart
        rows={ROWS}
        markers={[retirement]}
        depletionYear={null}
        members={MEMBERS}
        granularity="yearly"
        expenseMode="total"
        categoryMeta={[]}
      />,
    );
    const line = container.querySelector(
      '[data-marker-label="Retires May 2035"]',
    );
    expect(line).not.toBeNull();
    expect(line?.getAttribute('stroke')).toBe(
      CHART_COLORS.light.retirementMarker,
    );
  });
});

describe('CashflowProjectionChartInner — drag-zoom', () => {
  it('renders the marquee during a drag selection', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart
        rows={ROWS}
        markers={[]}
        depletionYear={null}
        members={MEMBERS}
        granularity="yearly"
        expenseMode="total"
        categoryMeta={[]}
        dragSelection={[2035, 2036]}
      />,
    );
    expect(
      container.querySelector('[data-testid="chart-drag-marquee"]'),
    ).not.toBeNull();
  });
});
