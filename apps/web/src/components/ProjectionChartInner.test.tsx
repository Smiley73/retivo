import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, within } from '@testing-library/react';

import InnerChart from './ProjectionChartInner';
import type {
  ProjectionChartRow,
  RetirementMarker,
} from './ProjectionChart';
import { expectNoA11yViolations } from '../test/a11y';
import { renderWithTheme, seriesColor } from '../test/theme-render';
import { CHART_COLORS } from '../lib/tokens';

const ROWS: ProjectionChartRow[] = [
  { year: 2030, x: 2031, plannedSolid: 100_000, plannedDashed: null, twrSolid: 110_000, twrDashed: null, plannedGrowth: 5_000, twrGrowth: 6_000 },
  { year: 2031, x: 2032, plannedSolid: 120_000, plannedDashed: null, twrSolid: 130_000, twrDashed: null, plannedGrowth: 5_500, twrGrowth: 6_500 },
];

const ENABLED = new Set<'twr'>(['twr']);

function renderThemed(theme: 'light' | 'dark'): HTMLElement {
  return renderWithTheme(
    theme,
    <InnerChart
      rows={ROWS}
      enabledCalculatedMethods={ENABLED}
      retirementMarkers={[]}
      lifeExpectancyMarkers={[]}
      tooltipMembers={[]}
    />,
  );
}

describe('ProjectionChartInner — theme reactivity', () => {
  it('sources the TWR line stroke from the map and flips light↔dark', () => {
    expect(CHART_COLORS.light.twr).not.toBe(CHART_COLORS.dark.twr);
    expect(seriesColor(renderThemed('light'), 'Historical', 'stroke')).toBe(
      CHART_COLORS.light.twr,
    );
    expect(seriesColor(renderThemed('dark'), 'Historical', 'stroke')).toBe(
      CHART_COLORS.dark.twr,
    );
  });

  it('sources the Planned line stroke from the map and flips light↔dark', () => {
    expect(CHART_COLORS.light.plannedSeries).not.toBe(
      CHART_COLORS.dark.plannedSeries,
    );
    expect(seriesColor(renderThemed('light'), 'Planned', 'stroke')).toBe(
      CHART_COLORS.light.plannedSeries,
    );
    expect(seriesColor(renderThemed('dark'), 'Planned', 'stroke')).toBe(
      CHART_COLORS.dark.plannedSeries,
    );
  });
});

describe('ProjectionChartInner — Monte-Carlo overlay (dashboard)', () => {
  const OVERLAY = {
    firstYear: 2030,
    typical: [105_000, 125_000],
    pessimistic: [95_000, 115_000],
  };

  function renderWithOverlay(theme: 'light' | 'dark'): HTMLElement {
    return renderWithTheme(
      theme,
      <InnerChart
        rows={ROWS}
        enabledCalculatedMethods={ENABLED}
        retirementMarkers={[]}
        lifeExpectancyMarkers={[]}
        tooltipMembers={[]}
        mcOverlay={OVERLAY}
      />,
    );
  }

  it('draws the two MC lines with map-sourced strokes that flip light↔dark', () => {
    expect(CHART_COLORS.light.mcTypical).not.toBe(CHART_COLORS.dark.mcTypical);
    expect(CHART_COLORS.light.mcPessimistic).not.toBe(
      CHART_COLORS.dark.mcPessimistic,
    );
    const light = renderWithOverlay('light');
    expect(seriesColor(light, 'Typical', 'stroke')).toBe(
      CHART_COLORS.light.mcTypical,
    );
    expect(seriesColor(light, 'Pessimistic', 'stroke')).toBe(
      CHART_COLORS.light.mcPessimistic,
    );
    const dark = renderWithOverlay('dark');
    expect(seriesColor(dark, 'Typical', 'stroke')).toBe(
      CHART_COLORS.dark.mcTypical,
    );
    expect(seriesColor(dark, 'Pessimistic', 'stroke')).toBe(
      CHART_COLORS.dark.mcPessimistic,
    );
  });

  it('draws no MC line series without an overlay', () => {
    const container = renderThemed('light');
    expect(container.querySelector('[name="Typical"]')).toBeNull();
    expect(container.querySelector('[name="Pessimistic"]')).toBeNull();
  });

  it('turns the MC lines dashed past retirement (like Planned/TWR)', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart
        rows={ROWS}
        enabledCalculatedMethods={ENABLED}
        retirementMarkers={[{ fractionalYear: 2031.5, label: 'Retire' }]}
        lifeExpectancyMarkers={[]}
        tooltipMembers={[]}
        mcOverlay={OVERLAY}
      />,
    );
    expect(
      container.querySelectorAll('path[name="Typical"][stroke-dasharray]')
        .length,
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll('path[name="Pessimistic"][stroke-dasharray]')
        .length,
    ).toBeGreaterThan(0);
  });

  it('has no a11y violations with the overlay present', async () => {
    await expectNoA11yViolations(renderWithOverlay('light'));
  });
});

describe('ProjectionChartInner — MC lines outlive the deterministic rows', () => {
  const pointCount = (container: HTMLElement): number => {
    const d = container
      .querySelector('path[name="Typical"]:not([stroke-dasharray])')
      ?.getAttribute('d');
    return (d?.match(/[ML]/g) ?? []).length;
  };
  const axisYears = (container: HTMLElement): string[] =>
    Array.from(container.querySelectorAll('svg text')).map((t) => t.textContent ?? '');

  it('extends the MC lines past the last deterministic row, clipped to the last death year', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart
        rows={ROWS}
        enabledCalculatedMethods={ENABLED}
        retirementMarkers={[]}
        lifeExpectancyMarkers={[{ fractionalYear: 2032.5, label: 'Life expectancy', color: '#000000' }]}
        tooltipMembers={[]}
        mcOverlay={{
          firstYear: 2030,
          typical: [105_000, 125_000, 130_000, 135_000, 140_000],
          pessimistic: [95_000, 115_000, 120_000, 125_000, 130_000],
        }}
      />,
    );
    expect(pointCount(container)).toBe(4);
    expect(axisYears(container)).not.toContain('2035');
  });

  it('adds no carrier row once both MC paths have depleted', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart
        rows={ROWS}
        enabledCalculatedMethods={ENABLED}
        retirementMarkers={[]}
        lifeExpectancyMarkers={[]}
        tooltipMembers={[]}
        mcOverlay={{
          firstYear: 2030,
          typical: [105_000, 125_000, 130_000, 0],
          pessimistic: [95_000, 115_000, 120_000, 0],
        }}
      />,
    );
    expect(pointCount(container)).toBe(3);
    expect(axisYears(container)).toContain('2033');
    expect(axisYears(container)).not.toContain('2034');
  });
});

describe('ProjectionChartInner — legend show/hide (isolate-first)', () => {
  it('drops both the solid + dashed channels of a method hidden by isolate', () => {
    const container = renderThemed('light');
    expect(container.querySelectorAll('path[name="Planned"]')).toHaveLength(2);

    const historicalToggle = within(container).getByRole('button', {
      name: 'Historical',
    });
    fireEvent.click(historicalToggle);

    expect(container.querySelectorAll('path[name="Planned"]')).toHaveLength(0);
    expect(
      container.querySelectorAll('path[name="Historical"]').length,
    ).toBeGreaterThan(0);
  });

  it('isolates both channels of the clicked method on the first click', () => {
    const container = renderThemed('light');

    const plannedToggle = within(container).getByRole('button', {
      name: 'Planned',
    });
    fireEvent.click(plannedToggle);

    expect(container.querySelectorAll('path[name="Planned"]')).toHaveLength(2);
    expect(container.querySelectorAll('path[name="Historical"]')).toHaveLength(0);
  });
});

describe('ProjectionChartInner — markers', () => {
  it('renders a retirement marker past the data tail when unzoomed', () => {
    const markerPastData: RetirementMarker = {
      fractionalYear: ROWS[ROWS.length - 1].x + 2,
      label: 'Retire later',
    };
    const container = renderWithTheme(
      'light',
      <InnerChart
        rows={ROWS}
        enabledCalculatedMethods={ENABLED}
        retirementMarkers={[markerPastData]}
        lifeExpectancyMarkers={[]}
        tooltipMembers={[]}
      />,
    );
    expect(
      container.querySelector('[data-marker-label="Retire later"]'),
    ).not.toBeNull();
  });
});

describe('ProjectionChartInner — drag-zoom', () => {
  it('renders the marquee during a drag selection', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart
        rows={ROWS}
        enabledCalculatedMethods={ENABLED}
        retirementMarkers={[]}
        lifeExpectancyMarkers={[]}
        tooltipMembers={[]}
        dragSelection={[2031, 2032]}
      />,
    );
    expect(
      container.querySelector('[data-testid="chart-drag-marquee"]'),
    ).not.toBeNull();
  });
});
