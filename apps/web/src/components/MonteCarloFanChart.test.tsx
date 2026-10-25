import React from 'react';
import { fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MonteCarloFanChart } from './MonteCarloFanChart';
import type { MonteCarloSummary } from '../lib/monte-carlo';
import { expectNoA11yViolations } from '../test/a11y';
import { renderWithTheme, seriesColor } from '../test/theme-render';
import { CHART_COLORS } from '../lib/tokens';

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
    const container = renderWithTheme(
      'light',
      <MonteCarloFanChart result={summary()} real={false} retirementYear={2031} lifeMarkers={[]} />,
    );
    const svg = container.querySelector('svg') as SVGSVGElement;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 800, height: 320, right: 800, bottom: 320, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    fireEvent.pointerMove(svg, { clientX: 100 });
    const tooltip = within(
      within(container).getByText('Year 2030').parentElement as HTMLElement,
    );
    expect(tooltip.getByText('Typical')).toBeInTheDocument();
    expect(tooltip.getByText('Pessimistic')).toBeInTheDocument();
    expect(tooltip.getByText('Bad-luck')).toBeInTheDocument();
    expect(tooltip.queryByText(/\(P\d+\)/)).toBeNull();
    expect(tooltip.queryByText('Good-luck')).toBeNull();
    expect(tooltip.queryByText('Optimistic')).toBeNull();
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
