/**
 * Render-level test for TaxBurdenChartInner on the SVG engine — asserts
 * positive cost bars (federal tax + IRMAA surcharge) render above zero
 * and the ACA-PTC subsidy bar (stored negative) renders below zero, plus
 * theme-reactivity for all three series colors.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';

import InnerChart from './TaxBurdenChartInner';
import { renderWithTheme, seriesColor } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';
import { CHART_COLORS } from '../lib/tokens';

const rows = [
  { year: 2026, federalTax: 8000, irmaaSurcharge: 0, acaPtcSubsidy: 0, acaCreditApplied: 0 },
  { year: 2027, federalTax: 9500, irmaaSurcharge: 800, acaPtcSubsidy: 0, acaCreditApplied: 0 },
  { year: 2028, federalTax: 0, irmaaSurcharge: 0, acaPtcSubsidy: -3200, acaCreditApplied: 0 },
  { year: 2029, federalTax: 4000, irmaaSurcharge: 600, acaPtcSubsidy: -1500, acaCreditApplied: 0 },
];

interface BarRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function getBars(container: HTMLElement, name: string): BarRect[] {
  const rects = container.querySelectorAll<SVGRectElement>(
    `rect[name="${name}"]`,
  );
  return Array.from(rects).map((p) => ({
    x: Number(p.getAttribute('x')),
    y: Number(p.getAttribute('y')),
    width: Number(p.getAttribute('width')),
    height: Number(p.getAttribute('height')),
  }));
}

function findZeroLineY(container: HTMLElement): number {
  const line = container.querySelector<SVGLineElement>(
    '[data-testid="chart-bar-zero"]',
  );
  if (!line) throw new Error('zero baseline not found');
  return Number(line.getAttribute('y1'));
}

describe('TaxBurdenChartInner', () => {
  it('renders cost bars above zero and subsidy bar below zero', () => {
    const container = renderWithTheme('light', <InnerChart rows={rows} dragSelection={[2026, 2029]} />);

    const federalTaxBars = getBars(container, 'Federal income tax');
    const irmaaBars = getBars(container, 'IRMAA surcharge');
    const ptcBars = getBars(container, 'ACA-PTC subsidy');
    const zeroY = findZeroLineY(container);

    expect(federalTaxBars).toHaveLength(3); // rows 0,1,3
    expect(irmaaBars).toHaveLength(2); // rows 1,3
    expect(ptcBars).toHaveLength(2); // rows 2,3

    for (const bar of [...federalTaxBars, ...irmaaBars]) {
      expect(bar.y + bar.height).toBeLessThanOrEqual(zeroY + 1);
    }
    for (const bar of ptcBars) {
      expect(bar.y).toBeCloseTo(zeroY, 0);
      expect(bar.y + bar.height).toBeGreaterThan(zeroY);
    }

    // Drag selection renders the zoom marquee.
    expect(
      container.querySelector('[data-testid="chart-drag-marquee"]'),
    ).not.toBeNull();
  });

  it('sources every bar fill from the map and flips light↔dark', () => {
    const themed = (theme: 'light' | 'dark'): HTMLElement =>
      renderWithTheme(theme, <InnerChart rows={rows} />);
    expect(CHART_COLORS.light.federalTax).not.toBe(CHART_COLORS.dark.federalTax);
    expect(seriesColor(themed('light'), 'Federal income tax')).toBe(
      CHART_COLORS.light.federalTax,
    );
    expect(seriesColor(themed('dark'), 'Federal income tax')).toBe(
      CHART_COLORS.dark.federalTax,
    );
    expect(CHART_COLORS.light.irmaa).not.toBe(CHART_COLORS.dark.irmaa);
    expect(seriesColor(themed('light'), 'IRMAA surcharge')).toBe(
      CHART_COLORS.light.irmaa,
    );
    expect(seriesColor(themed('dark'), 'IRMAA surcharge')).toBe(
      CHART_COLORS.dark.irmaa,
    );
    expect(CHART_COLORS.light.acaPtc).not.toBe(CHART_COLORS.dark.acaPtc);
    expect(seriesColor(themed('light'), 'ACA-PTC subsidy')).toBe(
      CHART_COLORS.light.acaPtc,
    );
    expect(seriesColor(themed('dark'), 'ACA-PTC subsidy')).toBe(
      CHART_COLORS.dark.acaPtc,
    );
  });
});

describe('TaxBurdenChartInner — integer death-year terminal bar + marker domain', () => {
  // Death = Dec 31 of `deathYear` (the terminal year): the death-year bar
  // is a FULL bar at its integer year and the death marker is the integer
  // `deathYear`, landing on the last bar — no fractional terminal bar.
  it('lands the integer death-year marker on the last (full) bar with no fractional terminal bar', () => {
    const marker = {
      fractionalYear: 2029, // integer deathYear == the last data year
      label: 'Pat life expectancy 90',
      color: '#000000',
      kind: 'death' as const,
    };
    const withMarkerX = getBars(
      renderWithTheme('light', <InnerChart rows={rows} markers={[marker]} />),
      'Federal income tax',
    ).at(-1)!.x;
    const noMarkerX = getBars(
      renderWithTheme('light', <InnerChart rows={rows} markers={[]} />),
      'Federal income tax',
    ).at(-1)!.x;
    // No fractional row was injected — the terminal bar stays on its
    // integer year (same X as the no-marker layout).
    expect(withMarkerX).toBeCloseTo(noMarkerX, 5);
    // The death marker line renders (on the last bar).
    const container = renderWithTheme(
      'light',
      <InnerChart rows={rows} markers={[marker]} />,
    );
    expect(
      container.querySelector('[data-marker-label="Pat life expectancy 90"]'),
    ).not.toBeNull();
  });
});

describe('TaxBurdenChartInner — credit applied to premiums', () => {
  // The dollars are already inside the ACA-PTC bar, so the figure rides the
  // tooltip and the lifetime tiles only: a second negative bar would double
  // count them.
  const withCredit = [
    { year: 2026, federalTax: 0, irmaaSurcharge: 0, acaPtcSubsidy: -5134.2, acaCreditApplied: 5134.2 },
    { year: 2027, federalTax: 0, irmaaSurcharge: 0, acaPtcSubsidy: -3000, acaCreditApplied: 2700 },
  ];

  it('draws no bar of its own and leaves the ACA-PTC bar at the full subsidy', () => {
    const container = renderWithTheme('light', <InnerChart rows={withCredit} />);
    expect(getBars(container, 'Credit applied to premiums')).toHaveLength(0);
    expect(getBars(container, 'ACA-PTC subsidy')).toHaveLength(2);
  });

  it('renders without a11y violations', async () => {
    const container = renderWithTheme('light', <InnerChart rows={withCredit} />);
    await expectNoA11yViolations(container);
  });
});

describe('TaxBurdenChartInner — a11y', () => {
  it('renders without a11y violations', async () => {
    const container = renderWithTheme('light', <InnerChart rows={rows} />);
    await expectNoA11yViolations(container);
  });
});
