/** RmdChartInner: stacked RMD bars (met below shortfall) and theme-reactive series colours. */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/react';

import InnerChart from './RmdChartInner';
import { renderWithTheme, seriesColor } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';
import { CHART_COLORS } from '../lib/tokens';

const rows = [
  { year: 2030, rmdMet: 20_000, rmdShortfall: 0, rmdRetained: 0 },
  { year: 2031, rmdMet: 22_000, rmdShortfall: 3_000, rmdRetained: 0 },
  { year: 2032, rmdMet: 24_000, rmdShortfall: 0, rmdRetained: 0 },
];

const splitRows = [
  { year: 2030, rmdMet: 20_000, rmdShortfall: 0, rmdRetained: 8_000 },
  { year: 2031, rmdMet: 22_000, rmdShortfall: 0, rmdRetained: 0 },
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

describe('RmdChartInner', () => {
  it('stacks the shortfall segment on top of the met segment', () => {
    const container = renderWithTheme('light', <InnerChart rows={rows} dragSelection={[2030, 2032]} />);

    const metBars = getBars(container, 'RMD met');
    const shortfallBars = getBars(container, 'Shortfall');

    expect(metBars).toHaveLength(3); // every year has a met segment
    expect(shortfallBars).toHaveLength(1); // only 2031 has a shortfall

    const metTop2031 = metBars[1].y;
    const shortfallBottom = shortfallBars[0].y + shortfallBars[0].height;
    expect(shortfallBars[0].y).toBeLessThan(metTop2031);
    expect(shortfallBottom).toBeCloseTo(metTop2031, 0);

    expect(
      container.querySelector('[data-testid="chart-drag-marquee"]'),
    ).not.toBeNull();
  });

  it('sources the rmdMet and rmdShortfall bar fills from the map and flips light↔dark', () => {
    const themed = (theme: 'light' | 'dark'): HTMLElement =>
      renderWithTheme(theme, <InnerChart rows={rows} />);
    expect(CHART_COLORS.light.rmdMet).not.toBe(CHART_COLORS.dark.rmdMet);
    expect(seriesColor(themed('light'), 'RMD met')).toBe(
      CHART_COLORS.light.rmdMet,
    );
    expect(seriesColor(themed('dark'), 'RMD met')).toBe(
      CHART_COLORS.dark.rmdMet,
    );
    expect(CHART_COLORS.light.rmdShortfall).not.toBe(
      CHART_COLORS.dark.rmdShortfall,
    );
    expect(seriesColor(themed('light'), 'Shortfall')).toBe(
      CHART_COLORS.light.rmdShortfall,
    );
    expect(seriesColor(themed('dark'), 'Shortfall')).toBe(
      CHART_COLORS.dark.rmdShortfall,
    );
  });
});

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

describe('RmdChartInner — surplus (kept) split', () => {
  it('shows a green Surplus (kept) band beside the teal Used-for-spending-and-taxes band when a year over-withdraws', () => {
    const container = renderWithTheme('light', <InnerChart rows={splitRows} />);

    expect(getBars(container, 'RMD met')).toHaveLength(0);
    const spentBars = getBars(container, 'Used for spending and taxes');
    const surplusBars = getBars(container, 'Surplus (kept)');
    expect(spentBars).toHaveLength(2); // both years carry a spent segment
    expect(surplusBars).toHaveLength(1); // only the over-withdraw year (2030)

    expect(seriesColor(container, 'Surplus (kept)')).toBe(
      CHART_COLORS.light.rmdRetained,
    );
    expect(seriesColor(container, 'Used for spending and taxes')).toBe(
      CHART_COLORS.light.rmdMet,
    );
  });

  it('shows the Surplus (kept) tooltip row in split mode', () => {
    const container = renderWithTheme('light', <InnerChart rows={splitRows} />);
    const tip = hoverTooltip(container);
    expect(tip.textContent).toContain('RMD required');
    expect(tip.textContent).toContain('Used for spending and taxes');
    expect(tip.textContent).toContain('Surplus (kept)');
  });

  it('keeps the met + shortfall view when no year over-withdraws', () => {
    const container = renderWithTheme('light', <InnerChart rows={rows} />);
    expect(getBars(container, 'RMD met')).toHaveLength(3);
    expect(getBars(container, 'Surplus (kept)')).toHaveLength(0);
    const tip = hoverTooltip(container);
    expect(tip.textContent).toContain('RMD met');
    expect(tip.textContent).not.toContain('Surplus (kept)');
  });

  it('drops the spent segment to zero height when retained equals met', () => {
    const tieRows = [
      { year: 2030, rmdMet: 20_000, rmdShortfall: 0, rmdRetained: 20_000 },
    ];
    const container = renderWithTheme('light', <InnerChart rows={tieRows} />);
    expect(getBars(container, 'Used for spending and taxes')).toHaveLength(0);
    const surplus = getBars(container, 'Surplus (kept)');
    expect(surplus).toHaveLength(1);
    expect(surplus[0].height).toBeGreaterThan(0);
  });

  it('clamps retained to met (no bar overshoot) when retained exceeds met by 1¢', () => {
    const overshootRows = [
      { year: 2030, rmdMet: 20_000, rmdShortfall: 0, rmdRetained: 20_000.01 },
    ];
    const container = renderWithTheme('light', <InnerChart rows={overshootRows} />);
    expect(getBars(container, 'Used for spending and taxes')).toHaveLength(0);
    const surplus = getBars(container, 'Surplus (kept)');
    expect(surplus).toHaveLength(1);
    expect(surplus[0].height).toBeGreaterThan(0);
  });

  it('sources the Surplus (kept) fill from the map and flips light↔dark', () => {
    const themed = (theme: 'light' | 'dark'): HTMLElement =>
      renderWithTheme(theme, <InnerChart rows={splitRows} />);
    expect(CHART_COLORS.light.rmdRetained).not.toBe(CHART_COLORS.dark.rmdRetained);
    expect(seriesColor(themed('light'), 'Surplus (kept)')).toBe(
      CHART_COLORS.light.rmdRetained,
    );
    expect(seriesColor(themed('dark'), 'Surplus (kept)')).toBe(
      CHART_COLORS.dark.rmdRetained,
    );
  });

  it('renders the split state without a11y violations', async () => {
    const container = renderWithTheme('light', <InnerChart rows={splitRows} />);
    await expectNoA11yViolations(container);
  });
});

describe('RmdChartInner — legend show/hide (isolate-first)', () => {
  it('hides the met bars when another series is isolated, then restores all', () => {
    const container = renderWithTheme('light', <InnerChart rows={rows} />);
    expect(getBars(container, 'RMD met')).toHaveLength(3);

    const shortfallToggle = within(container).getByRole('button', {
      name: 'Shortfall',
    });
    fireEvent.click(shortfallToggle);
    expect(getBars(container, 'RMD met')).toHaveLength(0);
    expect(getBars(container, 'Shortfall')).toHaveLength(1);
    const metToggle = within(container).getByRole('button', { name: 'RMD met' });
    expect(metToggle).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(shortfallToggle);
    expect(getBars(container, 'RMD met')).toHaveLength(3);
    expect(metToggle).toHaveAttribute('aria-pressed', 'false');
  });
});
