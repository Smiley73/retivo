/**
 * Render-level test for AccountBalanceStackChartInner — asserts the
 * stacked area series render, series colors source from the CHART_COLORS
 * map and flip light↔dark, and zoom/drag props drive the SVG
 * engine (marquee rect on drag selection).
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, within } from '@testing-library/react';

import InnerChart from './AccountBalanceStackChartInner';
import type {
  AccountBalanceStackSeries,
  AccountBalanceStackRow,
} from './AccountBalanceStackChartInner';
import { renderWithTheme, seriesColor } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';
import { CHART_COLORS } from '../lib/tokens';

const series: AccountBalanceStackSeries[] = [
  { dataKey: 'preTax', name: 'Tax-deferred', color: CHART_COLORS.light.acctPreTax },
  { dataKey: 'roth', name: 'Tax-free (Roth)', color: CHART_COLORS.light.acctRoth },
];

const rows: AccountBalanceStackRow[] = [
  { year: 2026, preTax: 400_000, roth: 80_000 },
  { year: 2027, preTax: 420_000, roth: 85_000 },
  { year: 2028, preTax: 440_000, roth: 90_000 },
];

describe('AccountBalanceStackChartInner', () => {
  it('renders area paths for each series', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={rows} series={series} />,
    );
    expect(container.querySelector('path[name="Tax-deferred"]')).not.toBeNull();
    expect(container.querySelector('path[name="Tax-free (Roth)"]')).not.toBeNull();
  });

  it('sources acctPreTax fill from the map and flips light↔dark', () => {
    const lightSeries: AccountBalanceStackSeries[] = [
      { dataKey: 'preTax', name: 'Tax-deferred', color: CHART_COLORS.light.acctPreTax },
    ];
    const darkSeries: AccountBalanceStackSeries[] = [
      { dataKey: 'preTax', name: 'Tax-deferred', color: CHART_COLORS.dark.acctPreTax },
    ];
    const lightContainer = renderWithTheme(
      'light',
      <InnerChart rows={rows} series={lightSeries} />,
    );
    const darkContainer = renderWithTheme(
      'dark',
      <InnerChart rows={rows} series={darkSeries} />,
    );
    expect(CHART_COLORS.light.acctPreTax).not.toBe(CHART_COLORS.dark.acctPreTax);
    expect(seriesColor(lightContainer, 'Tax-deferred')).toBe(
      CHART_COLORS.light.acctPreTax,
    );
    expect(seriesColor(darkContainer, 'Tax-deferred')).toBe(
      CHART_COLORS.dark.acctPreTax,
    );
  });
});

describe('AccountBalanceStackChartInner — drag-zoom', () => {
  it('renders the drag marquee during a drag selection', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={rows} series={series} dragSelection={[2026, 2028]} />,
    );
    expect(container.querySelector('[data-testid="chart-drag-marquee"]')).not.toBeNull();
  });

  it('renders no marquee when there is no drag selection', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={rows} series={series} dragSelection={null} />,
    );
    expect(container.querySelector('[data-testid="chart-drag-marquee"]')).toBeNull();
  });
});

describe('AccountBalanceStackChartInner — legend show/hide', () => {
  it('resolves same-named accounts independently (legendId = dataKey)', () => {
    // Two accounts named "Checking" — account names aren't unique. Each legend
    // button keys off its unique dataKey, so isolating one (isolate-first: the
    // first click hides every other key) leaves exactly its own series, not both.
    const dupes = [
      { dataKey: 'acctA', name: 'Checking', color: CHART_COLORS.light.acctTaxable },
      { dataKey: 'acctB', name: 'Checking', color: CHART_COLORS.light.acctCash },
    ];
    const dupeRows = [
      { year: 2026, acctA: 100_000, acctB: 20_000 },
      { year: 2027, acctA: 110_000, acctB: 25_000 },
    ];
    const container = renderWithTheme(
      'light',
      <InnerChart rows={dupeRows} series={dupes} />,
    );
    expect(container.querySelectorAll('path[name="Checking"]')).toHaveLength(2);

    // Click the first of the two "Checking" toggle buttons → isolate it.
    const buttons = within(container).getAllByRole('button', { name: 'Checking' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);

    // The isolated account survives; the other (distinct dataKey) hides.
    expect(container.querySelectorAll('path[name="Checking"]')).toHaveLength(1);
  });
});

describe('AccountBalanceStackChartInner — a11y', () => {
  it('renders without a11y violations', async () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={rows} series={series} />,
    );
    await expectNoA11yViolations(container);
  });
});
