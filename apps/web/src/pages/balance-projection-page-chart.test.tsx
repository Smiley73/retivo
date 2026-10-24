// BalanceProjectionChartSection: the Reset-zoom button, y-axis scale radiogroup, inline recalculating status and historical planned-rate fallback note. ProjectionChart and useChartZoom are mocked so isZoomed can be driven without a real drag.
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../components/ProjectionChart', () => ({
  ProjectionChart: () => <div data-testid="projection-chart" />,
}));

import { vm as stressVmFixture } from '../components/__fixtures__/plan-stress-test-vm';

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

import { BalanceProjectionChartSection } from './balance-projection-page-chart';
import { ThemeWrapper } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';
import type { ProjectionChartRow } from '../components/ProjectionChart';

const row = (year: number): ProjectionChartRow => ({
  x: year + 1,
  year,
  plannedSolid: 500_000,
  plannedDashed: null,
  twrSolid: 500_000,
  twrDashed: null,
  plannedGrowth: null,
  twrGrowth: null,
});

const baseProps = {
  rows: [row(2025), row(2026)],
  enabledCalculatedMethods: new Set(['twr'] as const),
  retirementMarkers: [],
  lifeExpectancyMarkers: [],
  tooltipMembers: [],
  yScale: 'linear' as const,
  onYScaleChange: vi.fn(),
  // Built from the shared fixture so the ~30 required PlanStressTestVm fields are not duplicated.
  stressVm: stressVmFixture(),
  activeMethod: 'twr' as const,
  fallbackAccounts: [] as ReadonlyArray<{ id: string; name: string }>,
};

const MC_BANNER_LEAD = 'This is one example, not an average.';

describe('BalanceProjectionChartSection', () => {
  beforeEach(() => {
    mockIsZoomed = false;
    mockReset.mockClear();
  });

  it('reset_visible_when_zoomed', () => {
    mockIsZoomed = true;
    render(<BalanceProjectionChartSection {...baseProps} />, { wrapper: ThemeWrapper });
    expect(
      screen.getByRole('button', { name: /reset view/i }),
    ).toBeInTheDocument();
  });

  it('renders a Linear/Log radiogroup (replacing the Log y-axis toggle) wired to yScale', async () => {
    const user = userEvent.setup();
    const onYScaleChange = vi.fn();
    render(
      <BalanceProjectionChartSection
        {...baseProps}
        yScale="linear"
        onYScaleChange={onYScaleChange}
      />,
      { wrapper: ThemeWrapper },
    );
    const group = screen.getByRole('radiogroup', { name: 'Y-axis scale' });
    const linear = within(group).getByRole('radio', { name: 'Linear' });
    const log = within(group).getByRole('radio', { name: 'Log' });
    expect(linear).toBeChecked();
    expect(log).not.toBeChecked();
    expect(
      screen.queryByRole('switch', { name: /Log/i }),
    ).not.toBeInTheDocument();

    await user.click(log);
    expect(onYScaleChange).toHaveBeenCalledWith('log');
  });

  it('renders the one-example banner under an MC basis', () => {
    render(
      <BalanceProjectionChartSection
        {...baseProps}
        activeMcBasis="mc-pessimistic"
      />,
      { wrapper: ThemeWrapper },
    );
    expect(screen.getByText(MC_BANNER_LEAD)).toBeInTheDocument();
  });

  it('renders no banner under a deterministic basis', () => {
    render(
      <BalanceProjectionChartSection {...baseProps} activeMcBasis={null} />,
      { wrapper: ThemeWrapper },
    );
    expect(screen.queryByText(MC_BANNER_LEAD)).not.toBeInTheDocument();
  });

  it('shows a polite "Recalculating…" status while running', () => {
    render(
      <BalanceProjectionChartSection
        {...baseProps}
        activeMcBasis="mc-typical"
        stressVm={stressVmFixture({ isRunning: true })}
      />,
      { wrapper: ThemeWrapper },
    );
    // The banner is also a role="status" region, so scope to the inline running indicator by its text.
    const status = screen.getByText('Recalculating…');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('shows a role="alert" error message when the VM errored', () => {
    render(
      <BalanceProjectionChartSection
        {...baseProps}
        activeMcBasis="mc-typical"
        stressVm={stressVmFixture({ error: 'worker crashed' })}
      />,
      { wrapper: ThemeWrapper },
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Stress-test failed: worker crashed');
  });

  describe('Historical planned-rate fallback note', () => {
    const fallback = [
      { id: 'a1', name: '401(k)' },
      { id: 'a2', name: 'Roth IRA' },
    ];

    it('renders and names the fallback accounts under the Historical basis', () => {
      render(
        <BalanceProjectionChartSection
          {...baseProps}
          activeMethod="twr"
          fallbackAccounts={fallback}
        />,
        { wrapper: ThemeWrapper },
      );
      expect(
        screen.getByText(/Historical uses your planned return for/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/401\(k\) and Roth IRA/)).toBeInTheDocument();
    });

    it('hides the note under the Planned basis even when accounts fell back', () => {
      render(
        <BalanceProjectionChartSection
          {...baseProps}
          activeMethod="planned"
          fallbackAccounts={fallback}
        />,
        { wrapper: ThemeWrapper },
      );
      expect(
        screen.queryByText(/Historical uses your planned return for/i),
      ).not.toBeInTheDocument();
    });

    it('hides the note when no account fell back', () => {
      render(
        <BalanceProjectionChartSection
          {...baseProps}
          activeMethod="twr"
          fallbackAccounts={[]}
        />,
        { wrapper: ThemeWrapper },
      );
      expect(
        screen.queryByText(/Historical uses your planned return for/i),
      ).not.toBeInTheDocument();
    });

    it('has no a11y violations when the note renders', async () => {
      const { container } = render(
        <BalanceProjectionChartSection
          {...baseProps}
          activeMethod="twr"
          fallbackAccounts={fallback}
        />,
        { wrapper: ThemeWrapper },
      );
      await expectNoA11yViolations(container);
    });

    it('hides the note under an MC basis even when Historical is active and accounts fell back', () => {
      render(
        <BalanceProjectionChartSection
          {...baseProps}
          activeMethod="twr"
          activeMcBasis="mc-typical"
          fallbackAccounts={fallback}
        />,
        { wrapper: ThemeWrapper },
      );
      expect(
        screen.queryByText(/Historical uses your planned return for/i),
      ).not.toBeInTheDocument();
    });
  });
});
