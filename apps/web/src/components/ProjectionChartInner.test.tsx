/**
 * ProjectionChartInner — theme-reactivity, log-scale floor, marker
 * + drag-zoom rendering, a11y smoke, on the SVG chart engine.
 *
 * The method lines (Planned, TWR) take their stroke from `CHART_COLORS`
 * via `useChartColors()`; this asserts the stroke is map-sourced and
 * FLIPS light↔dark. The log-scale domain clamp is exercised
 * directly against the engine's pure `resolveYDomain` helper since the engine resolves the y-domain internally.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, within } from '@testing-library/react';

import InnerChart, {
  buildProjectionData,
  type McCell,
} from './ProjectionChartInner';
import type {
  ProjectionChartRow,
  RetirementMarker,
} from './ProjectionChart';
import { expectNoA11yViolations } from '../test/a11y';
import { renderWithTheme, seriesColor } from '../test/theme-render';
import { CHART_COLORS } from '../lib/tokens';
import { LOG_FLOOR, resolveYDomain } from './charts';

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
    // With a retirement marker the overlay splits into a solid (pre-) +
    // dashed (post-retirement) channel sharing the line's name, so the
    // dashed stretch carries the same dash pattern the deterministic lines
    // use. (No marker → the all-solid case is covered above.)
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

describe('buildProjectionData — MC lines outlive the deterministic rows', () => {
  const detRow = (x: number): ProjectionChartRow => ({
    year: x - 1,
    x,
    plannedSolid: 100,
    plannedDashed: null,
    twrSolid: 110,
    twrDashed: null,
    plannedGrowth: null,
    twrGrowth: null,
  });
  const cell = (v: number): McCell => ({
    typicalSolid: null,
    typicalDashed: v,
    pessimisticSolid: null,
    pessimisticDashed: v - 5,
  });

  it('adds MC-only rows past the last deterministic row, clipped to domainMax', () => {
    // Deterministic rows stop at x=2032 (Planned/TWR depleted); the overlay
    // runs to 2035. domainMax=2034 → 2033/2034 get MC-only carrier rows,
    // 2035 is clipped.
    const visible = [detRow(2031), detRow(2032)];
    const mcByX = new Map<number, McCell>([
      [2031, cell(200)],
      [2032, cell(210)],
      [2033, cell(220)],
      [2034, cell(230)],
      [2035, cell(240)],
    ]);
    const data = buildProjectionData(visible, mcByX, 2034);
    expect(data.map((d) => d.x)).toEqual([2031, 2032, 2033, 2034]);
    // The extension row carries the MC value but no deterministic value.
    const r2034 = data.find((d) => d.x === 2034) as Record<string, unknown>;
    expect(r2034.plannedSolid).toBeNull();
    expect(r2034.twrSolid).toBeNull();
    expect(r2034.mcTypicalDashed).toBe(230);
    expect(r2034.mcPessimisticDashed).toBe(225);
    // A merged row keeps its deterministic value + gains the MC value.
    const r2031 = data.find((d) => d.x === 2031) as Record<string, unknown>;
    expect(r2031.plannedSolid).toBe(100);
    expect(r2031.mcTypicalDashed).toBe(200);
  });

  it('skips MC-only carrier rows once both paths have depleted', () => {
    const nullCell: McCell = {
      typicalSolid: null,
      typicalDashed: null,
      pessimisticSolid: null,
      pessimisticDashed: null,
    };
    const data = buildProjectionData(
      [detRow(2031)],
      new Map<number, McCell>([
        [2031, cell(200)],
        [2032, cell(150)],
        [2033, nullCell], // both depleted → no carrier row
      ]),
      2040,
    );
    expect(data.map((d) => d.x)).toEqual([2031, 2032]);
  });

  it('returns plain deterministic rows when there is no overlay', () => {
    const data = buildProjectionData(
      [detRow(2031), detRow(2032)],
      new Map(),
      Infinity,
    );
    expect(data.map((d) => d.x)).toEqual([2031, 2032]);
    expect((data[0] as Record<string, unknown>).mcTypicalDashed).toBeUndefined();
  });
});

describe('ProjectionChartInner — log-scale Y-axis floor', () => {
  it('pins the floor at $10k', () => {
    expect(LOG_FLOOR).toBe(10000);
  });

  it('floors the log-scale domain at $10k', () => {
    const d = resolveYDomain(ROWS.map((r) => ({ ...r, x: r.x })), [], null, 'log');
    expect(d[0]).toBe(LOG_FLOOR);
  });

  it('guards inversion when an explicit yDomain falls below the floor', () => {
    // Both ends below floor → lo clamps to floor, hi NOT > floor → not [10000, 50].
    const d = resolveYDomain([], [], [1, 50], 'log');
    expect(d[0]).toBe(LOG_FLOOR);
    expect(d[1]).toBeGreaterThan(d[0]);
  });

  it('clamps the lower bound only when the upper is above the floor', () => {
    expect(resolveYDomain([], [], [500, 200000], 'log')).toEqual([
      LOG_FLOOR,
      200000,
    ]);
  });

  it('leaves the linear-scale domain auto-ranged (padded extent)', () => {
    const d = resolveYDomain(ROWS.map((r) => ({ ...r, x: r.x })), [], null, 'linear');
    expect(d[0]).toBe(0);
    expect(d[1]).toBeGreaterThan(0);
  });
});

describe('ProjectionChartInner — legend show/hide (isolate-first)', () => {
  it('drops BOTH the solid + dashed channels of a method hidden by isolate', () => {
    // One legend entry ("Planned") maps to two specs sharing the name —
    // the solid pre-retirement + dashed post-retirement channels. Hiding the
    // entry must drop both (the filter keys off `name`, not `dataKey`).
    // Under isolate-first, isolating Historical hides every Planned channel.
    const container = renderThemed('light');
    expect(container.querySelectorAll('path[name="Planned"]')).toHaveLength(2);

    const historicalToggle = within(container).getByRole('button', {
      name: 'Historical',
    });
    fireEvent.click(historicalToggle);

    expect(container.querySelectorAll('path[name="Planned"]')).toHaveLength(0);
    // The isolated method (Historical) survives.
    expect(
      container.querySelectorAll('path[name="Historical"]').length,
    ).toBeGreaterThan(0);
  });

  it('isolates BOTH channels of the clicked method on the first click', () => {
    // Clicking "Planned" from all-visible focuses it: both Planned channels
    // stay; Historical is hidden.
    const container = renderThemed('light');

    const plannedToggle = within(container).getByRole('button', {
      name: 'Planned',
    });
    fireEvent.click(plannedToggle);

    expect(container.querySelectorAll('path[name="Planned"]')).toHaveLength(2);
    expect(container.querySelectorAll('path[name="Historical"]')).toHaveLength(0);
  });
});

describe('ProjectionChartInner — a11y', () => {
  it('renders without a11y violations', async () => {
    const container = renderThemed('light');
    await expectNoA11yViolations(container);
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
