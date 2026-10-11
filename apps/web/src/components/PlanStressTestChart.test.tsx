/**
 * PlanStressTestChart — collapsible stress-test data table render +
 * collapse a11y semantics (print force-expands the table).
 *
 * The yearly percentile table is now always mounted inside a `<div hidden>`
 * wrapper (so print can force-expand it) but drops out of the a11y tree when
 * collapsed. These assertions are the regression guard: they pass only if
 * `hidden` is applied correctly when `dataTableOpen` is false, and the
 * `result &&` guard still holds so the table never mounts without a result.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import {
  PlanStressTestChart,
  PlanStressTestStressFanChart,
} from './PlanStressTestChart';
import { vm, summary } from './__fixtures__/plan-stress-test-vm';
import { withTheme } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';

describe('PlanStressTestChart — collapsible data table (print force-expand)', () => {
  it('hides the data table (grid + scroll-region landmark) when collapsed', () => {
    render(
      withTheme(
        'light',
        <PlanStressTestChart
          vm={vm()}
          dataTableOpen={false}
          onToggleDataTable={() => undefined}
        />,
      ),
    );
    // The disclosure button is present (a result exists), but the table is
    // out of the a11y tree behind the `<div hidden>` wrapper.
    expect(
      screen.getByRole('button', { name: 'Show stress-test data table' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('grid', { name: 'Plan stress-test yearly outcomes' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', {
        name: 'Plan stress-test yearly outcomes',
      }),
    ).not.toBeInTheDocument();
  });

  it('renders the data table grid when open', async () => {
    const { container } = render(
      withTheme(
        'light',
        <PlanStressTestChart
          vm={vm()}
          dataTableOpen
          onToggleDataTable={() => undefined}
        />,
      ),
    );
    expect(
      screen.getByRole('grid', { name: 'Plan stress-test yearly outcomes' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Year' }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('never mounts the table with no result even when dataTableOpen is true (reliability guard)', () => {
    // The `result &&` guard MUST hold: a vm with no result renders neither the
    // disclosure button nor the table, regardless of `dataTableOpen` — so the
    // table body never dereferences a null `result.percentilesReal`.
    render(
      withTheme(
        'light',
        <PlanStressTestChart
          vm={vm({ result: null })}
          dataTableOpen
          onToggleDataTable={() => undefined}
        />,
      ),
    );
    expect(
      screen.queryByRole('button', { name: /stress-test data table/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('grid', { name: 'Plan stress-test yearly outcomes' }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Stressed outcome band plotted on the same terms as the base
// ---------------------------------------------------------------------------

describe('PlanStressTestStressFanChart — stressed outcome band', () => {
  it('names the plotted stress and states it shares the base run’s histories', () => {
    render(
      withTheme(
        'light',
        <PlanStressTestStressFanChart
          caseName="Higher fees"
          stressResult={summary({ successProbability: 0.42 })}
          vm={vm()}
        />,
      ),
    );
    expect(
      screen.getByRole('heading', { name: 'Outcomes with higher fees' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /same simulated market histories as the chart above, with higher fees applied/i,
      ),
    ).toBeInTheDocument();
  });

  it('exposes the plotted band as a named region so it is reachable by landmark', () => {
    render(
      withTheme(
        'light',
        <PlanStressTestStressFanChart
          caseName="Higher inflation"
          stressResult={summary()}
          vm={vm()}
        />,
      ),
    );
    expect(
      screen.getByRole('region', { name: 'Outcomes with higher inflation' }),
    ).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      withTheme(
        'light',
        <PlanStressTestStressFanChart
          caseName="Lower returns"
          stressResult={summary()}
          vm={vm()}
        />,
      ),
    );
    await expectNoA11yViolations(container);
  });

  it('qualifies the same-paths claim on a horizon-EXTENDING case, and only there', () => {
    // This fan's note is one of the four surfaces that carry the
    // longevity-approximation qualification, so it needs its own coverage.
    const { unmount } = render(
      withTheme(
        'light',
        <PlanStressTestStressFanChart
          caseName="Longer life"
          stressResult={summary()}
          vm={vm()}
          extendsHorizon
        />,
      ),
    );
    expect(
      screen.getByText(
        /added years past the original end of your plan use fresh market draws/i,
      ),
    ).toBeInTheDocument();
    unmount();

    // Negative control: a re-pricing case makes no such claim, because its
    // paths really are identical to the base run's for the whole horizon.
    render(
      withTheme(
        'light',
        <PlanStressTestStressFanChart
          caseName="Higher fees"
          stressResult={summary()}
          vm={vm()}
        />,
      ),
    );
    expect(
      screen.queryByText(/use fresh market draws/i),
    ).not.toBeInTheDocument();
  });

  it('plots NO life markers on a horizon-EXTENDING case, and says they are left off', () => {
    // `vm.lifeMarkers` are the BASE run's projected death years. Plotting them
    // on a longer-life fan drew a member's death marker with five more years of
    // portfolio band past it — the chart contradicting the stress it shows.
    const lifeMarkers = [
      { fractionalYear: 2032, label: 'Life expectancy', color: '#000000' },
    ];
    const { container, unmount } = render(
      withTheme(
        'light',
        <PlanStressTestStressFanChart
          caseName="Longer life"
          stressResult={summary()}
          vm={vm({ lifeMarkers })}
          extendsHorizon
        />,
      ),
    );
    expect(
      container.querySelector('[data-marker-label="Life expectancy"]'),
    ).toBeNull();
    expect(
      screen.getByText(/life expectancy markers are left off/i),
    ).toBeInTheDocument();
    unmount();

    // A re-pricing case ends at the SAME year as the base run, so its markers
    // are still correct and must still be drawn.
    const repriced = render(
      withTheme(
        'light',
        <PlanStressTestStressFanChart
          caseName="Higher fees"
          stressResult={summary()}
          vm={vm({ lifeMarkers })}
        />,
      ),
    );
    expect(
      repriced.container.querySelector('[data-marker-label="Life expectancy"]'),
    ).not.toBeNull();
    expect(
      screen.queryByText(/life expectancy markers are left off/i),
    ).not.toBeInTheDocument();
  });
});

describe('PlanStressTestChart — percentile naming scheme', () => {
  it('uses the consistent Bad-luck/Pessimistic/Typical/Optimistic/Good-luck headers', () => {
    // The chart embeds MonteCarloFanChart → useChartColors() → needs a
    // ThemeProvider ancestor, as in the real app shell.
    render(
      withTheme(
        'light',
        <MemoryRouter>
          <PlanStressTestChart
            vm={vm()}
            dataTableOpen
            onToggleDataTable={() => undefined}
          />
        </MemoryRouter>,
      ),
    );
    expect(screen.getAllByText('Bad-luck').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Pessimistic').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Typical').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Optimistic')).not.toBeInTheDocument();
    expect(screen.queryByText('Good-luck')).not.toBeInTheDocument();
    // No percentile (Pxx) jargon survives on any label.
    expect(screen.queryByText(/\(P\d+\)/)).not.toBeInTheDocument();
  });

  it('renders the percentile data table as an RA grid with sticky-top Columns', () => {
    // This nested-in-projection percentile table uses RA Table
    // primitives; sticky-top columns are wired via utility classes on
    // each Column. The full arrow-key keyboard model is checked by hand,
    // not in this suite.
    render(
      withTheme(
        'light',
        <MemoryRouter>
          <PlanStressTestChart
            vm={vm()}
            dataTableOpen
            onToggleDataTable={() => undefined}
          />
        </MemoryRouter>,
      ),
    );
    const grid = screen.getByRole('grid', {
      name: 'Plan stress-test yearly outcomes',
    });
    expect(grid).toBeInTheDocument();
    // Sticky-top utility class wired on the Year column (jsdom-safe
    // className wiring check — paint behavior is the manual gate).
    const yearHeader = screen.getByRole('columnheader', { name: 'Year' });
    expect(yearHeader.className).toContain('sticky');
    expect(yearHeader.className).toContain('top-0');
  });

  it('renders the remediation banner when cbpValidation.ok === false', () => {
    const failing = vm({
      cbpValidation: {
        ok: false,
        unconfigured: ['cbp-1'],
        annuityMissingStream: [],
        annuityDuplicateStream: [],
      },
      result: null,
    });
    const { container } = render(
      <MemoryRouter>
        <PlanStressTestChart vm={failing} dataTableOpen={false} onToggleDataTable={() => undefined} />
      </MemoryRouter>,
    );
    // CbpRemediationBanner renders an alert role with the per-CBP detail.
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
