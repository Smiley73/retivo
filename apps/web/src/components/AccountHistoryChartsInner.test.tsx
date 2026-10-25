import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import InnerCharts from './AccountHistoryChartsInner';
import type { AccountHistoryRow } from './AccountHistoryCharts';
import { renderWithTheme } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';
import { CHART_COLORS } from '../lib/tokens';

const rowsFor = (returns: number[]): AccountHistoryRow[] =>
  returns.map((returnPct, i) => ({ year: 2025 + i, endingBalance: 100_000 + i, returnPct }));

describe('AccountHistoryChartsInner — return gradient', () => {
  // The cut is relative to the line's own bounding box, and the zero baseline stays inside the plot
  // (height 256, margins 8 top / 28 bottom: y in [8, 228]).
  it.each([
    ['every value is positive', [5, 10, 15], '100.00%'],
    ['every value is negative', [-2, -8, -15], '0.00%'],
    ['values cross zero', [15, 5, -5, 10], '75.00%'],
    ['there are no values', [], '100.00%'],
  ] as Array<[string, number[], string]>)('cuts the gradient when %s', (_name, returns, offset) => {
    const container = renderWithTheme('light', <InnerCharts rows={rowsFor(returns)} />);
    const stops = Array.from(container.querySelectorAll('stop'));
    expect(stops[1].getAttribute('offset')).toBe(offset);
    expect(stops[2].getAttribute('offset')).toBe(offset);
    const [, returnSvg] = Array.from(container.querySelectorAll('svg'));
    const y1 = Number(returnSvg.querySelector('[data-testid="chart-hline"]')?.getAttribute('y1'));
    expect(y1).toBeGreaterThanOrEqual(8);
    expect(y1).toBeLessThanOrEqual(228);
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

const ROWS: AccountHistoryRow[] = [
  { year: 2025, endingBalance: 100_000, returnPct: 5 },
  { year: 2026, endingBalance: 110_000, returnPct: 10 },
];

function mockSvgRects(container: HTMLElement): SVGSVGElement[] {
  const svgs = Array.from(container.querySelectorAll('svg')) as SVGSVGElement[];
  for (const svg of svgs) {
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 800, height: 256, right: 800, bottom: 256, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
  }
  return svgs;
}

describe('AccountHistoryChartsInner — a11y', () => {
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
  // The shared `yDomain` is the balance chart's dollar domain; the return chart must keep its own percent bounds.
  const ZOOM_ROWS: AccountHistoryRow[] = [
    { year: 2021, endingBalance: 60_000, returnPct: -5 },
    { year: 2022, endingBalance: 90_000, returnPct: 8 },
    { year: 2023, endingBalance: 150_000, returnPct: 12 },
  ];

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
