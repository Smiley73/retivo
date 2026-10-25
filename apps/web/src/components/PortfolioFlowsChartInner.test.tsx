/** PortfolioFlowsChartInner: signed stacking of flow bars, theme-reactive fills, drag-zoom and markers. */
import React from 'react';
import { describe, expect, it } from 'vitest';

import InnerChart from './PortfolioFlowsChartInner';
import type {
  CashflowChartMarker,
} from './CashflowProjectionChart';
import type { PortfolioFlowsChartRow } from './PortfolioFlowsChart';
import { renderWithTheme, seriesColor } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';
import { CHART_COLORS } from '../lib/tokens';

const rows: PortfolioFlowsChartRow[] = [
  { year: 2026, contributions: 10000, gains: 5000, deposits: 0, withdrawals: 0, qcd: 0, netChange: 15000 },
  { year: 2027, contributions: 10000, gains: 6000, deposits: 0, withdrawals: 0, qcd: 0, netChange: 16000 },
  // 2028-29 are drawdown years: withdrawals are net of forced-RMD surplus, and 2029 also carries a QCD stripe.
  { year: 2028, contributions: 0, gains: 4000, deposits: 0, withdrawals: -10000, qcd: 0, netChange: -6000 },
  { year: 2029, contributions: 0, gains: 3000, deposits: 0, withdrawals: -15000, qcd: -5000, netChange: -17000 },
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

describe('PortfolioFlowsChartInner', () => {
  it('renders gains and withdrawals at the same X column with withdrawals below zero', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart
        rows={rows}
        markers={[]}
        depletionYear={null}
        members={[]}
        dragSelection={[2026, 2028]}
      />,
    );
    const gains = getBars(container, 'Investment gains');
    const contrib = getBars(container, 'Contributions');
    const withdrawals = getBars(container, 'Withdrawals');
    const zeroY = findZeroLineY(container);

    expect(gains).toHaveLength(rows.length);
    expect(contrib).toHaveLength(2); // rows 0-1 only
    expect(withdrawals).toHaveLength(2); // rows 2-3 only

    expect(contrib[0].x).toBe(gains[0].x);
    expect(contrib[1].x).toBe(gains[1].x);
    expect(withdrawals[0].x).toBe(gains[2].x);
    expect(withdrawals[1].x).toBe(gains[3].x);

    for (const c of contrib) {
      expect(c.y + c.height).toBeLessThanOrEqual(zeroY + 1);
    }
    for (const w of withdrawals) {
      expect(w.y).toBeCloseTo(zeroY, 0);
      expect(w.y + w.height).toBeGreaterThan(zeroY);
    }

    expect(
      container.querySelector('[data-testid="chart-drag-marquee"]'),
    ).not.toBeNull();
  });

  it('renders the Charitable (QCD) stripe below zero only in QCD years, sourced from the qcd token', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={rows} markers={[]} depletionYear={null} members={[]} />,
    );
    const qcd = getBars(container, 'Charitable (QCD)');
    const withdrawals = getBars(container, 'Withdrawals');
    const zeroY = findZeroLineY(container);
    expect(qcd).toHaveLength(1);
    const w2029 = withdrawals.find((b) => b.x === qcd[0].x)!;
    expect(qcd[0].y).toBeGreaterThan(zeroY);
    expect(qcd[0].y).toBeGreaterThanOrEqual(w2029.y + w2029.height - 1);
    expect(seriesColor(container, 'Charitable (QCD)')).toBe(CHART_COLORS.light.qcd);
    expect(CHART_COLORS.light.qcd).not.toBe(CHART_COLORS.light.incomeWithdrawal);
  });

  it('exposes a Charitable (QCD) legend entry', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={rows} markers={[]} depletionYear={null} members={[]} />,
    );
    const labels = Array.from(
      container.querySelectorAll('ul li span'),
    ).map((s) => s.textContent);
    expect(labels).toContain('Charitable (QCD)');
  });

  it('renders no Charitable (QCD) stripe when every year has zero qcd', () => {
    const noQcdRows = rows.map((r) => ({ ...r, qcd: 0 }));
    const container = renderWithTheme(
      'light',
      <InnerChart rows={noQcdRows} markers={[]} depletionYear={null} members={[]} />,
    );
    expect(getBars(container, 'Charitable (QCD)')).toHaveLength(0);
  });

  it('sources the Contributions bar fill from the map and flips light↔dark', () => {
    const themed = (theme: 'light' | 'dark'): HTMLElement =>
      renderWithTheme(
        theme,
        <InnerChart rows={rows} markers={[]} depletionYear={null} members={[]} />,
      );
    expect(CHART_COLORS.light.incomePartTime).not.toBe(
      CHART_COLORS.dark.incomePartTime,
    );
    expect(seriesColor(themed('light'), 'Contributions')).toBe(
      CHART_COLORS.light.incomePartTime,
    );
    expect(seriesColor(themed('dark'), 'Contributions')).toBe(
      CHART_COLORS.dark.incomePartTime,
    );
  });
});

describe('PortfolioFlowsChartInner — integer death-year terminal bar', () => {
  it('places the integer death-year marker on the last (full) bar, with no fractional terminal bar', () => {
    const deathMarker: CashflowChartMarker = {
      fractionalYear: 2029, // integer deathYear == the last data year
      label: 'Pat life expectancy 90',
      color: '#000000',
      kind: 'death',
    };
    const container = renderWithTheme(
      'light',
      <InnerChart rows={rows} markers={[deathMarker]} depletionYear={null} members={[]} />,
    );
    const noMarker = renderWithTheme(
      'light',
      <InnerChart rows={rows} markers={[]} depletionYear={null} members={[]} />,
    );
    const withMarkerX = getBars(container, 'Investment gains').at(-1)!.x;
    const noMarkerX = getBars(noMarker, 'Investment gains').at(-1)!.x;
    expect(withMarkerX).toBeCloseTo(noMarkerX, 5);
    expect(
      container.querySelector('[data-marker-label="Pat life expectancy 90"]'),
    ).not.toBeNull();
  });
});

describe('PortfolioFlowsChartInner — a11y', () => {
  it('renders without a11y violations', async () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={rows} markers={[]} depletionYear={null} members={[]} />,
    );
    await expectNoA11yViolations(container);
  });
});

describe('PortfolioFlowsChartInner — markers', () => {
  it('renders a marker past the data tail when unzoomed', () => {
    const markerPastData: CashflowChartMarker = {
      fractionalYear: rows[rows.length - 1].year + 2,
      label: 'Retire later',
      color: '#000000',
    };
    const container = renderWithTheme(
      'light',
      <InnerChart
        rows={rows}
        markers={[markerPastData]}
        depletionYear={null}
        members={[]}
      />,
    );
    expect(
      container.querySelector('[data-marker-label="Retire later"]'),
    ).not.toBeNull();
  });

  it('renders the teal Retires <Mon YYYY> marker fed by the host', () => {
    const retirement: CashflowChartMarker = {
      fractionalYear: 2027 + 4 / 12,
      label: 'Retires May 2027',
      color: CHART_COLORS.light.retirementMarker,
    };
    const container = renderWithTheme(
      'light',
      <InnerChart rows={rows} markers={[retirement]} depletionYear={null} members={[]} />,
    );
    const line = container.querySelector(
      '[data-marker-label="Retires May 2027"]',
    );
    expect(line).not.toBeNull();
    expect(line?.getAttribute('stroke')).toBe(
      CHART_COLORS.light.retirementMarker,
    );
  });
  it('strokes the net-change line as solid green/red sign segments (PDF-safe, no gradient)', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={rows} markers={[]} depletionYear={null} members={[]} />,
    );
    const strokes = Array.from(
      container.querySelectorAll<SVGPathElement>('path[name="Net change"]'),
    ).map((p) => p.getAttribute('stroke'));
    expect(strokes).toContain(CHART_COLORS.light.netChangePositive);
    expect(strokes).toContain(CHART_COLORS.light.netChangeNegative);
    // svg2pdf cannot stroke a gradient, so every segment must carry a solid colour.
    expect(strokes.some((s) => s?.startsWith('url('))).toBe(false);
  });
});
