/** RothConversionsChart inner: one bar per conversion year, the Roth series colour and theme reactivity. */
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

  it('scales the y-axis to the converted amount for a single year (not the [0,1] fallback)', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={[{ year: 2039, dollars: 27_992 }]} />,
    );
    const currencyTicks = Array.from(container.querySelectorAll('text'))
      .map((t) => t.textContent ?? '')
      .filter((s) => s.startsWith('$'));
    expect(currencyTicks.length).toBeGreaterThan(0);
    expect(currencyTicks.some((s) => /\$\d+(\.\d+)?[km]/i.test(s))).toBe(true);
  });
});
