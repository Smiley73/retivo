/**
 * IncomeBreakdownChartInner — tooltip granularity adaptation,
 * theme-reactivity, marker rendering + drag-zoom, on the SVG engine.
 * Monthly shows "<Mon> <Year>", Yearly shows just "<Year>"; member age
 * is whole-year in both. Theme: the Social Security area fill is
 * map-sourced and flips light↔dark. expectNoA11yViolations satisfies
 * the AGENTS component-test mandate.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import InnerChart, { makeIncomeTooltip } from './IncomeBreakdownChartInner';
import type {
  IncomeBreakdownMarker,
  IncomeBreakdownPoint,
} from './IncomeBreakdownChart';
import type { TooltipMember } from './tooltip-member';
import type { ChartDatum } from './charts';
import { expectNoA11yViolations } from '../test/a11y';
import { renderWithTheme, seriesColor } from '../test/theme-render';
import { CHART_COLORS, CHART_CHROME } from '../lib/tokens';

const POINT: IncomeBreakdownPoint = {
  fractionalYear: 2035 + 8 / 12,
  year: 2035,
  month0: 8, // September
  ss: 24_000,
  pensionAnnuity: 12_000,
  partTime: 6_000,
  oneOff: 3_000,
  portfolioAdd: 1_000,
  withdrawal: 9_000,
  total: 55_000,
  expenses: 40_000,
};

const MEMBERS: TooltipMember[] = [{ firstName: 'Jordan', birthYear: 1970 }];

function renderTip(
  granularity: 'monthly' | 'yearly',
): ReturnType<typeof render> {
  const tip = makeIncomeTooltip(
    MEMBERS,
    granularity,
    CHART_COLORS.light,
    CHART_CHROME.light,
  );
  const node = tip({ ...POINT, x: POINT.fractionalYear } as ChartDatum);
  return render(<>{node}</>);
}

describe('IncomeBreakdownChartInner — tooltip granularity', () => {
  it('shows "Sep 2035" + whole-year age in monthly mode', () => {
    const { getByText } = renderTip('monthly');
    expect(getByText('Sep 2035')).toBeTruthy();
    expect(getByText('Jordan (age 65)')).toBeTruthy();
  });

  it('omits the month (just "2035") + whole-year age in yearly mode', () => {
    const { queryByText, getByText } = renderTip('yearly');
    expect(queryByText('Sep 2035')).toBeNull();
    expect(getByText('2035')).toBeTruthy();
    expect(getByText('Jordan (age 65)')).toBeTruthy();
  });
});

const ROWS: IncomeBreakdownPoint[] = [
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
    />,
  );
}

describe('IncomeBreakdownChartInner — theme reactivity', () => {
  it('sources the Social Security area fill from the map and flips light↔dark', () => {
    expect(CHART_COLORS.light.incomeSs).not.toBe(CHART_COLORS.dark.incomeSs);
    expect(seriesColor(renderThemed('light'), 'Social Security')).toBe(
      CHART_COLORS.light.incomeSs,
    );
    expect(seriesColor(renderThemed('dark'), 'Social Security')).toBe(
      CHART_COLORS.dark.incomeSs,
    );
  });
});

describe('IncomeBreakdownChartInner — a11y', () => {
  it('renders without a11y violations', async () => {
    const container = renderThemed('light');
    await expectNoA11yViolations(container);
  });
});

describe('IncomeBreakdownChartInner — markers', () => {
  it('renders a marker past the data tail when unzoomed', () => {
    const markerPastData: IncomeBreakdownMarker = {
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
      />,
    );
    expect(
      container.querySelector('[data-marker-label="Retire later"]'),
    ).not.toBeNull();
  });

  it('renders the teal Retires <Mon YYYY> marker fed by the host', () => {
    const retirement: IncomeBreakdownMarker = {
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

describe('IncomeBreakdownChartInner — drag-zoom', () => {
  it('renders the marquee during a drag selection', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart
        rows={ROWS}
        markers={[]}
        depletionYear={null}
        members={MEMBERS}
        granularity="yearly"
        dragSelection={[2035, 2036]}
      />,
    );
    expect(
      container.querySelector('[data-testid="chart-drag-marquee"]'),
    ).not.toBeNull();
  });
});
