/**
 * AccountHistoryChartsInner — pure return-bounds math, theme reactivity,
 * drag-zoom rendering, return-chart zoom isolation, hover tooltip and a11y
 * smoke tests, on the SVG chart engine.
 *
 * Regression guard (computeReturnBounds): the green/red gradient on the
 * per-account return chart. The bug: an all-positive line was rendering with
 * a red sliver at its lowest extreme because the gradient's zero offset was
 * computed against the chart's padded axis (which includes 0), then SVG
 * `objectBoundingBox` stretched that mostly-green / tiny-red split onto the
 * line's own bbox. Rule (see AccountHistoryChartsInner.tsx →
 * ReturnGradientBounds): `zeroOffset` is bbox-relative — 1 when every value
 * is >= 0, 0 when every value is <= 0, else `dataMax / (dataMax − dataMin)`.
 *
 * Theme: the return-chart gradient and per-point return dots take their
 * colors from the `CHART_COLORS` map via `useChartColors()`.
 *
 * Note: InnerCharts renders TWO charts (balance + return), so a drag
 * marquee renders once per chart.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import InnerCharts, { computeReturnBounds } from './AccountHistoryChartsInner';
import type { AccountHistoryRow } from './AccountHistoryCharts';
import { renderWithTheme } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';
import { CHART_COLORS } from '../lib/tokens';

describe('computeReturnBounds', () => {
  it('returns zeroOffset 1 (full green) when every value is positive', () => {
    const r = computeReturnBounds([5, 10, 15]);
    expect(r.zeroOffset).toBe(1);
    // Axis still includes zero so the dashed reference line stays visible.
    expect(r.yMin).toBeLessThanOrEqual(0);
    expect(r.yMax).toBeGreaterThan(15);
  });

  it('returns zeroOffset 1 (full green) when every value is exactly zero', () => {
    expect(computeReturnBounds([0, 0, 0]).zeroOffset).toBe(1);
  });

  it('returns zeroOffset 0 (full red) when every value is negative', () => {
    const r = computeReturnBounds([-2, -8, -15]);
    expect(r.zeroOffset).toBe(0);
    expect(r.yMin).toBeLessThan(-15);
    expect(r.yMax).toBeGreaterThanOrEqual(0);
  });

  it('places the cut at y=0 within the line\'s bbox when values cross zero', () => {
    // Top of bbox at +15, bottom at -5. Zero sits 15/20 = 0.75 from top.
    const r = computeReturnBounds([15, 5, -5, 10]);
    expect(r.zeroOffset).toBeCloseTo(0.75, 5);
  });

  it('handles a single positive value without going red', () => {
    expect(computeReturnBounds([7.5]).zeroOffset).toBe(1);
  });

  it('handles a single negative value as fully red', () => {
    expect(computeReturnBounds([-3]).zeroOffset).toBe(0);
  });

  it('handles empty input without crashing', () => {
    const r = computeReturnBounds([]);
    expect(r.zeroOffset).toBe(1);
    expect(r.yMin).toBeLessThan(0);
    expect(r.yMax).toBeGreaterThan(0);
  });
});

const THEME_ROWS: AccountHistoryRow[] = [
  { year: 2030, endingBalance: 100_000, returnPct: 8 },
  { year: 2031, endingBalance: 92_000, returnPct: -4 },
];

function gradientStops(container: HTMLElement): Set<string> {
  return new Set(
    Array.from(container.querySelectorAll<SVGStopElement>('stop')).map(
      (s) => s.getAttribute('stop-color') ?? '',
    ),
  );
}

function renderThemed(theme: 'light' | 'dark'): HTMLElement {
  return renderWithTheme(theme, <InnerCharts rows={THEME_ROWS} />);
}

describe('AccountHistoryChartsInner — theme reactivity', () => {
  it('sources the return-gradient stop colors from the map and flips light↔dark', () => {
    expect(CHART_COLORS.light.accountReturnPositive).not.toBe(
      CHART_COLORS.dark.accountReturnPositive,
    );
    expect(CHART_COLORS.light.accountReturnNegative).not.toBe(
      CHART_COLORS.dark.accountReturnNegative,
    );

    const light = gradientStops(renderThemed('light'));
    expect(light.has(CHART_COLORS.light.accountReturnPositive)).toBe(true);
    expect(light.has(CHART_COLORS.light.accountReturnNegative)).toBe(true);
    expect(light.has(CHART_COLORS.dark.accountReturnPositive)).toBe(false);

    const dark = gradientStops(renderThemed('dark'));
    expect(dark.has(CHART_COLORS.dark.accountReturnPositive)).toBe(true);
    expect(dark.has(CHART_COLORS.dark.accountReturnNegative)).toBe(true);
    expect(dark.has(CHART_COLORS.light.accountReturnPositive)).toBe(false);
  });
});

describe('AccountHistoryChartsInner — a11y', () => {
  it('renders without a11y violations', async () => {
    const container = renderThemed('light');
    await expectNoA11yViolations(container);
  });
});

const ROWS: AccountHistoryRow[] = [
  { year: 2025, endingBalance: 100_000, returnPct: 5 },
  { year: 2026, endingBalance: 110_000, returnPct: 10 },
];

/** Mock both sub-chart SVGs to an 800px-wide plot so pointer math runs. */
function mockSvgRects(container: HTMLElement): SVGSVGElement[] {
  const svgs = Array.from(container.querySelectorAll('svg')) as SVGSVGElement[];
  for (const svg of svgs) {
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 800, height: 256, right: 800, bottom: 256, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
  }
  return svgs;
}

describe('AccountHistoryChartsInner — a11y smoke', () => {
  it('renders without a11y violations', async () => {
    const container = renderWithTheme('light', <InnerCharts rows={ROWS} />);
    await expectNoA11yViolations(container);
  });
});

describe('AccountHistoryChartsInner — drag-zoom rendering', () => {
  it('renders the drag marquee on both sub-charts during a drag', () => {
    const container = renderWithTheme(
      'light',
      <InnerCharts rows={ROWS} dragSelection={[2025, 2026]} />,
    );
    expect(
      container.querySelectorAll('[data-testid="chart-drag-marquee"]'),
    ).toHaveLength(2);
  });
});

describe('AccountHistoryChartsInner — return chart ignores balance zoom', () => {
  // Regression: the shared `yDomain` prop is the drag-zoom's BALANCE-dollar
  // domain (account-history-section computeY uses endingBalance). The return
  // chart is on a percent scale and must ALWAYS use its own returnBounds,
  // never the dollar domain — otherwise a zoom renders -5%..12% values against
  // a $50k..$200k axis and the line + zero baseline collapse. With the buggy
  // `yDomain ?? [...]`, the return chart below would render dollar-scale ticks
  // (e.g. "200000.0%") and push its y=0 baseline off-plot.
  const ZOOM_ROWS: AccountHistoryRow[] = [
    { year: 2021, endingBalance: 60_000, returnPct: -5 },
    { year: 2022, endingBalance: 90_000, returnPct: 8 },
    { year: 2023, endingBalance: 150_000, returnPct: 12 },
  ];

  /** Parse the numeric magnitudes from a chart's y-axis percent tick labels. */
  function yTickMagnitudes(svg: SVGSVGElement): number[] {
    return Array.from(svg.querySelectorAll('text'))
      .map((t) => t.textContent ?? '')
      .filter((s) => s.trim().endsWith('%'))
      .map((s) => Math.abs(parseFloat(s.replace('%', ''))))
      .filter((n) => Number.isFinite(n));
  }

  it('renders percent-scale (not dollar-scale) y ticks while balance is zoomed', () => {
    const container = renderWithTheme(
      'light',
      <InnerCharts
        rows={ZOOM_ROWS}
        xDomain={[2021, 2023]}
        yDomain={[50_000, 200_000]}
      />,
    );
    const [, returnSvg] = Array.from(
      container.querySelectorAll('svg'),
    ) as SVGSVGElement[];
    const mags = yTickMagnitudes(returnSvg);
    expect(mags.length).toBeGreaterThan(0);
    // Percent bounds for [-5,12] are roughly [-6.7,13.7]; nothing approaches the
    // dollar-scale ticks the bug produced (50k..200k → "...%").
    expect(Math.max(...mags)).toBeLessThan(100);
  });

  it('keeps the return zero baseline inside the plot while balance is zoomed', () => {
    const container = renderWithTheme(
      'light',
      <InnerCharts
        rows={ZOOM_ROWS}
        xDomain={[2021, 2023]}
        yDomain={[50_000, 200_000]}
      />,
    );
    const [, returnSvg] = Array.from(
      container.querySelectorAll('svg'),
    ) as SVGSVGElement[];
    const hline = returnSvg.querySelector('[data-testid="chart-hline"]');
    expect(hline).not.toBeNull();
    // Return chart: height 256, margin top 8 / bottom 28 → plot spans y∈[8,228].
    // With the percent domain (≈ -6.7..13.7) y=0 lands inside the plot. Under
    // the bug ([50k,200k]) y=0 maps below the bottom edge, off-plot.
    const y1 = Number(hline?.getAttribute('y1'));
    expect(y1).toBeGreaterThanOrEqual(8);
    expect(y1).toBeLessThanOrEqual(228);
  });
});

describe('AccountHistoryChartsInner — hover tooltip', () => {
  it('shows year + formatted ending balance on the balance chart', () => {
    const container = renderWithTheme('light', <InnerCharts rows={ROWS} />);
    const [balanceSvg] = mockSvgRects(container);
    fireEvent.pointerMove(balanceSvg, { clientX: 100 });
    const tooltip = container.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toContain('Year 2025');
    expect(tooltip?.textContent).toContain('$100,000');
  });

  it('shows year + formatted return percent on the return chart', () => {
    const container = renderWithTheme('light', <InnerCharts rows={ROWS} />);
    const [, returnSvg] = mockSvgRects(container);
    fireEvent.pointerMove(returnSvg, { clientX: 100 });
    const tooltip = container.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toContain('Year 2025');
    expect(tooltip?.textContent).toContain('5.0%');
  });

  it('suppresses the tooltip while a drag-zoom is active', () => {
    const container = renderWithTheme(
      'light',
      <InnerCharts rows={ROWS} isDragging />,
    );
    const [balanceSvg] = mockSvgRects(container);
    fireEvent.pointerMove(balanceSvg, { clientX: 100 });
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });
});
