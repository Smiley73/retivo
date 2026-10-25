/** MonteCarloFanSection: Reset button visibility, with useChartZoom and the fan chart mocked. */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expectNoA11yViolations } from '../test/a11y';

vi.mock('./MonteCarloFanChart', () => ({
  MonteCarloFanChart: () => <div data-testid="mc-fan-chart" />,
}));

let mockIsZoomed = false;
const mockReset = vi.fn();

vi.mock('../lib/use-chart-zoom', () => ({
  useChartZoom: () => ({
    xDomain: undefined,
    yDomain: null,
    isZoomed: mockIsZoomed,
    isDragging: false,
    dragSelection: null,
    mouseHandlers: {},
    reset: mockReset,
  }),
}));

import { MonteCarloFanSection } from './monte-carlo-fan-section';
import type { MonteCarloSummary } from '../lib/monte-carlo';

function makeSummary(): MonteCarloSummary {
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

describe('MonteCarloFanSection', () => {
  beforeEach(() => {
    mockIsZoomed = false;
    mockReset.mockClear();
  });

  it('reset_visible_when_zoomed', () => {
    mockIsZoomed = true;
    render(
      <MonteCarloFanSection
        result={makeSummary()}
        real={true}
        retirementYear={2032}
      />,
    );
    expect(
      screen.getByRole('button', { name: /reset view/i }),
    ).toBeInTheDocument();
  });

  it('a11y_smoke', async () => {
    mockIsZoomed = true;
    const { container } = render(
      <MonteCarloFanSection
        result={makeSummary()}
        real={false}
        retirementYear={null}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
