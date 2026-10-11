/**
 * Render-level test for QcdRmdSplitChartInner on the SVG engine — asserts the
 * two stacked segments render (the tax-free "Covered by QCD" slice below
 * the "Net taxable" slice), the tooltip content (gross = offset + net, offset,
 * net), the empty/zero-row handling, the single-year y-axis domain scaling (no
 * `[0,1]` fallback), the legend show/hide toggle, theme-reactivity for both
 * series colours (`qcdOffset` / `rmdMet`), and an a11y smoke.
 *
 * Mirrors `QcdChart.test.tsx` + `RmdChartInner.test.tsx`.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/react';

import InnerChart from './QcdRmdSplitChartInner';
import type { QcdRmdSplitRow } from './QcdRmdSplitChart';
import { renderWithTheme, seriesColor } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';
import { CHART_COLORS } from '../lib/tokens';

const OFFSET = 'Covered by QCD (tax-free)';
const NET = 'Net taxable';

const rows: QcdRmdSplitRow[] = [
  { year: 2047, rmdOffsetDollars: 10_000, netTaxableDollars: 20_000 },
  { year: 2048, rmdOffsetDollars: 8_000, netTaxableDollars: 12_000 },
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

function hoverTooltip(container: HTMLElement): HTMLElement {
  const svg = container.querySelector('svg') as SVGSVGElement;
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width: 600,
    height: 320,
    top: 0,
    left: 0,
    right: 600,
    bottom: 320,
    toJSON: () => ({}),
  } as DOMRect);
  fireEvent.pointerMove(svg, { clientX: 40 });
  const tip = container.querySelector('[role="tooltip"]') as HTMLElement;
  expect(tip).not.toBeNull();
  return tip;
}

describe('QcdRmdSplitChartInner', () => {
  it('stacks the net-taxable segment on top of the covered-by-gift segment', () => {
    const container = renderWithTheme('light', <InnerChart rows={rows} />);
    const offsetBars = getBars(container, OFFSET);
    const netBars = getBars(container, NET);
    expect(offsetBars).toHaveLength(2); // one per gross-IRA-RMD year
    expect(netBars).toHaveLength(2);

    // The net-taxable segment (2047) sits ABOVE its offset segment: a smaller
    // SVG `y` (higher on screen) and its bottom meets the offset top.
    const offsetTop2047 = offsetBars[0].y;
    const netBottom2047 = netBars[0].y + netBars[0].height;
    expect(netBars[0].y).toBeLessThan(offsetTop2047);
    expect(netBottom2047).toBeCloseTo(offsetTop2047, 0);
  });

  it('sources the offset and net-taxable bar fills from the map and flips light↔dark', () => {
    const themed = (theme: 'light' | 'dark'): HTMLElement =>
      renderWithTheme(theme, <InnerChart rows={rows} />);
    expect(CHART_COLORS.light.qcdOffset).not.toBe(CHART_COLORS.dark.qcdOffset);
    expect(seriesColor(themed('light'), OFFSET)).toBe(CHART_COLORS.light.qcdOffset);
    expect(seriesColor(themed('dark'), OFFSET)).toBe(CHART_COLORS.dark.qcdOffset);
    expect(CHART_COLORS.light.rmdMet).not.toBe(CHART_COLORS.dark.rmdMet);
    expect(seriesColor(themed('light'), NET)).toBe(CHART_COLORS.light.rmdMet);
    expect(seriesColor(themed('dark'), NET)).toBe(CHART_COLORS.dark.rmdMet);
  });

  it('shows gross (= offset + net), offset, and net in the tooltip', () => {
    const container = renderWithTheme('light', <InnerChart rows={rows} />);
    const tip = hoverTooltip(container);
    expect(tip.textContent).toContain('Gross IRA RMD');
    expect(tip.textContent).toContain(OFFSET);
    expect(tip.textContent).toContain(NET);
    // Gross = offset + net = $30,000 for 2047 (the leftmost bar under clientX 40).
    expect(tip.textContent).toContain('$30,000');
    expect(tip.textContent).toContain('$10,000'); // offset
    expect(tip.textContent).toContain('$20,000'); // net
  });

  it('handles an empty series without throwing (no bars, no NaN domain)', () => {
    const container = renderWithTheme('light', <InnerChart rows={[]} />);
    expect(getBars(container, OFFSET)).toHaveLength(0);
    expect(getBars(container, NET)).toHaveLength(0);
  });

  // Regression mirror of the QCD/Roth charts: a SINGLE stacked bar must still
  // scale the y-axis to its stacked height (the [0,1] fallback would top at "$1").
  it('scales the y-axis to the bar height for a single year (not the [0,1] fallback)', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart
        rows={[{ year: 2047, rmdOffsetDollars: 10_000, netTaxableDollars: 20_000 }]}
      />,
    );
    const currencyTicks = Array.from(container.querySelectorAll('text'))
      .map((t) => t.textContent ?? '')
      .filter((s) => s.startsWith('$'));
    expect(currencyTicks.length).toBeGreaterThan(0);
    expect(currencyTicks.some((s) => /\$\d+(\.\d+)?[km]/i.test(s))).toBe(true);
  });

  it('renders without a11y violations', async () => {
    const container = renderWithTheme('light', <InnerChart rows={rows} />);
    await expectNoA11yViolations(container);
  });
});

describe('QcdRmdSplitChartInner — legend show/hide (isolate-first)', () => {
  it('isolates the clicked series on the first click from all-visible', () => {
    const container = renderWithTheme('light', <InnerChart rows={rows} />);
    const offsetToggle = within(container).getByRole('button', { name: OFFSET });
    fireEvent.click(offsetToggle);
    // Only the clicked offset series stays; the net-taxable series is hidden.
    expect(getBars(container, OFFSET)).toHaveLength(2);
    expect(getBars(container, NET)).toHaveLength(0);
    expect(offsetToggle).toHaveAttribute('aria-pressed', 'false');
    expect(
      within(container).getByRole('button', { name: NET }),
    ).toHaveAttribute('aria-pressed', 'true');

    // Clicking the lone-visible offset series restores every series.
    fireEvent.click(offsetToggle);
    expect(getBars(container, NET)).toHaveLength(2);
    expect(
      within(container).getByRole('button', { name: NET }),
    ).toHaveAttribute('aria-pressed', 'false');
  });
});
