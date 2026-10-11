/**
 * Render-level test for the Roth conversions chart inner on the SVG
 * engine — asserts one bar per conversion year, the violet `acctRoth`
 * series colour, theme-reactivity, and a11y smoke. The series arrives
 * pre-deflated, so bar heights are read verbatim.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';

import InnerChart from './RothConversionsChartInner';
import type { RothConversionsChartRow } from './RothConversionsChart';
import { renderWithTheme, seriesColor } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';
import { CHART_COLORS } from '../lib/tokens';

const rows: RothConversionsChartRow[] = [
  { year: 2039, dollars: 27_992 },
  { year: 2040, dollars: 18_500 },
];

describe('RothConversionsChartInner', () => {
  it('renders one bar per conversion year', () => {
    const container = renderWithTheme('light', <InnerChart rows={rows} />);
    expect(
      container.querySelectorAll('rect[name="Roth converted"]'),
    ).toHaveLength(2);
  });

  it('sources the bar fill from the acctRoth token and flips light↔dark', () => {
    const themed = (theme: 'light' | 'dark'): HTMLElement =>
      renderWithTheme(theme, <InnerChart rows={rows} />);
    expect(CHART_COLORS.light.acctRoth).not.toBe(CHART_COLORS.dark.acctRoth);
    expect(seriesColor(themed('light'), 'Roth converted')).toBe(
      CHART_COLORS.light.acctRoth,
    );
    expect(seriesColor(themed('dark'), 'Roth converted')).toBe(
      CHART_COLORS.dark.acctRoth,
    );
  });

  it('renders without a11y violations', async () => {
    const container = renderWithTheme('light', <InnerChart rows={rows} />);
    await expectNoA11yViolations(container);
  });

  // Regression: a SINGLE un-stacked bar must still scale the y-axis to its
  // value. Without a stackId the auto y-domain fell through `computeYExtent`'s
  // stacked/line branches and collapsed to the [0, 1] fallback — the axis
  // topped out at "$1" while the lone bar overflowed (every other test uses
  // two years, so the single-year case slipped through).
  it('scales the y-axis to the converted amount for a single year (not the [0,1] fallback)', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={[{ year: 2039, dollars: 27_992 }]} />,
    );
    const currencyTicks = Array.from(container.querySelectorAll('text'))
      .map((t) => t.textContent ?? '')
      .filter((s) => s.startsWith('$'));
    expect(currencyTicks.length).toBeGreaterThan(0);
    // formatCurrencyShort($27,992) → "$28k"; the buggy [0,1] domain only ever
    // renders "$0"/"$1" ticks, so a thousands tick proves the fix.
    expect(currencyTicks.some((s) => /\$\d+(\.\d+)?[km]/i.test(s))).toBe(true);
  });
});
