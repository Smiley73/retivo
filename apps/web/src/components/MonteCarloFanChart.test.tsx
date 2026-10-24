/**
 * MonteCarloFanChart — tooltip percentile-label coverage, theme
 * reactivity, log-scale floor, marker + drag-zoom rendering, a11y, on
 * the SVG chart engine.
 *
 * The hover tooltip is the only fan-chart surface that names each
 * percentile band; the consistent naming scheme (Bad-luck / Pessimistic
 * / Typical / Optimistic / Good-luck) is shared with the stress-test
 * cards + data table. The exported
 * tooltip factory is exercised directly with the hovered datum.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MonteCarloFanChart, makeTooltipContent } from './MonteCarloFanChart';
import type { MonteCarloSummary } from '../lib/monte-carlo';
import type { ChartDatum } from './charts';
import { LOG_FLOOR, resolveYDomain } from './charts';
import { expectNoA11yViolations } from '../test/a11y';
import { renderWithTheme, seriesColor } from '../test/theme-render';
import { CHART_COLORS, CHART_CHROME } from '../lib/tokens';

function summary(): MonteCarloSummary {
  return {
    engineVersion: 4,
    seed: 1,
    pathCount: 100,
    computedAt: 0,
    firstYear: 2030,
    horizonYears: 3,
    percentilesNominal: {
      p10: [100, 200, 300],
      p25: [110, 210, 310],
      p50: [120, 220, 320],
    },
    percentilesReal: {
      p10: [10, 20, 30],
      p25: [11, 21, 31],
      p50: [12, 22, 32],
    },
    successProbability: 0.5,
    medianDepletionYear: null,
    p10DepletionYear: null,
    p25DepletionYear: null,
    medianEndingBalanceNominal: 320,
    medianEndingBalanceReal: 32,
    p10EndingBalanceNominal: 300,
    p10EndingBalanceReal: 30,
    p25EndingBalanceNominal: 310,
    p25EndingBalanceReal: 31,
    failureYearHistogram: [0, 0, 0],
    endingBalanceHistogramNominal: [],
    endingBalanceHistogramReal: [],
    plannedOverlay: [0, 0, 0],
  };
}

describe('MonteCarloFanChart — tooltip percentile labels', () => {
  it('names every band with the consistent scheme', () => {
    const node = makeTooltipContent(CHART_CHROME.light)({
      year: 2035,
      x: 2036,
      p10: 100,
      p25: 200,
      p50: 300,
      band_p10_to_p25: 100,
      band_p25_to_p50: 100,
    } as ChartDatum);
    const { getByText, queryByText } = render(<>{node}</>);
    expect(getByText('Typical')).toBeTruthy();
    expect(getByText('Pessimistic')).toBeTruthy();
    expect(getByText('Bad-luck')).toBeTruthy();
    // No percentile (Pxx) jargon in the tooltip labels.
    expect(queryByText(/\(P\d+\)/)).toBeNull();
    expect(queryByText('Good-luck')).toBeNull();
    expect(queryByText('Optimistic')).toBeNull();
    expect(queryByText(/Worse-than-typical/)).toBeNull();
    expect(queryByText(/Better-than-typical/)).toBeNull();
  });
});

describe('MonteCarloFanChart — theme reactivity', () => {
  const themed = (theme: 'light' | 'dark'): HTMLElement =>
    renderWithTheme(
      theme,
      <MonteCarloFanChart result={summary()} real={false} retirementYear={2031} lifeMarkers={[]} />,
    );

  it('sources the P50 median line stroke from the map and flips light↔dark', () => {
    expect(CHART_COLORS.light.mcMedian).not.toBe(CHART_COLORS.dark.mcMedian);
    expect(seriesColor(themed('light'), 'Typical', 'stroke')).toBe(
      CHART_COLORS.light.mcMedian,
    );
    expect(seriesColor(themed('dark'), 'Typical', 'stroke')).toBe(
      CHART_COLORS.dark.mcMedian,
    );
  });
});

describe('MonteCarloFanChart — log-scale Y-axis floor', () => {
  it('pins the floor at $10k', () => {
    expect(LOG_FLOOR).toBe(10000);
  });

  it('floors the log-scale domain at $10k', () => {
    expect(resolveYDomain([], [], null, 'log')[0]).toBe(LOG_FLOOR);
  });

  it('guards inversion when both yDomain ends are below the floor', () => {
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
});

describe('MonteCarloFanChart — a11y', () => {
  it('renders without a11y violations', async () => {
    const container = renderWithTheme(
      'light',
      <MonteCarloFanChart result={summary()} real={false} retirementYear={2031} lifeMarkers={[]} />,
    );
    await expectNoA11yViolations(container);
  });
});

describe('MonteCarloFanChart — markers', () => {
  it('renders a life marker past the data tail when unzoomed', () => {
    const markerFractionalYear = 2032 + 3; // beyond last data row (2032)
    const container = renderWithTheme(
      'light',
      <MonteCarloFanChart
        result={summary()}
        real={false}
        retirementYear={2031}
        lifeMarkers={[{ fractionalYear: markerFractionalYear, label: 'Life expectancy', color: '#000000' }]}
      />,
    );
    expect(
      container.querySelector('[data-marker-label="Life expectancy"]'),
    ).not.toBeNull();
  });

  it('renders the teal retirement marker + threaded Retires <Mon YYYY> label', () => {
    const container = renderWithTheme(
      'light',
      <MonteCarloFanChart
        result={summary()}
        real={false}
        retirementYear={2031 + 4 / 12}
        retirementLabel="Retires May 2031"
        lifeMarkers={[]}
      />,
    );
    const line = container.querySelector(
      '[data-marker-label="Retires May 2031"]',
    );
    expect(line).not.toBeNull();
    expect(line?.getAttribute('stroke')).toBe(
      CHART_COLORS.light.retirementMarker,
    );
  });

  it('falls back to the Retire label when no retirementLabel is threaded', () => {
    const container = renderWithTheme(
      'light',
      <MonteCarloFanChart result={summary()} real={false} retirementYear={2031} lifeMarkers={[]} />,
    );
    expect(container.querySelector('[data-marker-label="Retire"]')).not.toBeNull();
  });
});

describe('MonteCarloFanChart — drag-zoom', () => {
  it('renders the marquee during a drag selection', () => {
    const container = renderWithTheme(
      'light',
      <MonteCarloFanChart
        result={summary()}
        real={false}
        retirementYear={2031}
        lifeMarkers={[]}
        dragSelection={[2031, 2032]}
      />,
    );
    expect(
      container.querySelector('[data-testid="chart-drag-marquee"]'),
    ).not.toBeNull();
  });
});
