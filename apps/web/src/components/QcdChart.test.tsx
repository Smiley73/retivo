/**
 * Render-level test for the charitable-distributions (QCD) chart inner on the
 * SVG engine — asserts one bar per QCD year, the pink `qcd` series colour,
 * theme-reactivity (light↔dark), empty-rows handling, and a11y smoke. The
 * series arrives pre-deflated, so bar heights are read verbatim.
 *
 * Mirrors `RothConversionsChart.test.tsx`.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';

import InnerChart from './QcdChartInner';
import type { QcdChartRow } from './QcdChart';
import { renderWithTheme, seriesColor } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';
import { CHART_COLORS } from '../lib/tokens';

const SERIES = 'Charitable distribution (QCD)';

const rows: QcdChartRow[] = [
  { year: 2047, dollars: 30_000 },
  { year: 2048, dollars: 18_500 },
];

describe('QcdChartInner', () => {
  it('renders one bar per QCD year', () => {
    const container = renderWithTheme('light', <InnerChart rows={rows} />);
    expect(container.querySelectorAll(`rect[name="${SERIES}"]`)).toHaveLength(2);
  });

  it('sources the bar fill from the qcd token and flips light↔dark', () => {
    const themed = (theme: 'light' | 'dark'): HTMLElement =>
      renderWithTheme(theme, <InnerChart rows={rows} />);
    expect(CHART_COLORS.light.qcd).not.toBe(CHART_COLORS.dark.qcd);
    expect(seriesColor(themed('light'), SERIES)).toBe(CHART_COLORS.light.qcd);
    expect(seriesColor(themed('dark'), SERIES)).toBe(CHART_COLORS.dark.qcd);
  });

  it('renders without a11y violations', async () => {
    const container = renderWithTheme('light', <InnerChart rows={rows} />);
    await expectNoA11yViolations(container);
  });

  it('handles an empty series without throwing (no bars, no NaN domain)', () => {
    const container = renderWithTheme('light', <InnerChart rows={[]} />);
    expect(container.querySelectorAll(`rect[name="${SERIES}"]`)).toHaveLength(0);
  });

  // Regression mirror of the Roth chart: a SINGLE un-stacked bar must still
  // scale the y-axis to its value (the [0,1] fallback would top out at "$1").
  it('scales the y-axis to the gift amount for a single year (not the [0,1] fallback)', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={[{ year: 2047, dollars: 30_000 }]} />,
    );
    const currencyTicks = Array.from(container.querySelectorAll('text'))
      .map((t) => t.textContent ?? '')
      .filter((s) => s.startsWith('$'));
    expect(currencyTicks.length).toBeGreaterThan(0);
    expect(currencyTicks.some((s) => /\$\d+(\.\d+)?[km]/i.test(s))).toBe(true);
  });
});
