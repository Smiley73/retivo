// BalanceProjectionSwrSection, the "Safe withdrawal rate" tab panel body. The resolver is mocked (module-scoped `result`, reassigned per test) to prove the panel's own wiring in isolation: which state renders which body, the card figures, the forwarded resolver input, the chart mount gate and the valuation-year disclosure.
// The resolver's arithmetic and the chart's internals are proven in their own suites.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { renderWithTheme, withTheme } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';
import { BalanceProjectionSwrSection } from './balance-projection-page-swr';
import type { BalanceProjectionSwrSectionProps } from './balance-projection-page-swr';
import type { BalanceProjectionViewModel } from './use-balance-projection-view-model';
import type {
  SwrComparisonBundle,
  SwrComparisonResult,
} from '../lib/safe-withdrawal-rate-chart-types';
import type { UseBalanceProjectionSwrDataInput } from './use-balance-projection-swr-data';

let result: SwrComparisonResult;
// Records the resolver's argument object so a test can prove `displayMode`, `activeMethod` and `activeMcBasis` actually reach the resolver, not just that some result renders.
let lastResolverInput: UseBalanceProjectionSwrDataInput | undefined;
vi.mock('./use-balance-projection-swr-data', () => ({
  useBalanceProjectionSwrData: (input: UseBalanceProjectionSwrDataInput) => {
    lastResolverInput = input;
    return result;
  },
}));

function makeVm(primaryRetirementYear: number | null): BalanceProjectionViewModel {
  return { primaryRetirementYear } as unknown as BalanceProjectionViewModel;
}

// Read a Stat tile through its label, never a bare `getAllByText(value)`, which cannot tell one card figure from another sharing the same formatted text.
function statText(label: string): string {
  const wrapper = screen.getByText(label).parentElement as HTMLElement;
  return wrapper.children[1]?.textContent ?? '';
}

// Every fixture figure is a different number (anchor draw 37_000, 4% implied spend 40_000, 4.5% implied spend 45_000, portfolio 1_000_000) and `anchorYear` (2033) never collides with `vm.primaryRetirementYear` (2032), so a figure wired to the wrong quantity, or "Retirement year" falling back to `bundle.anchorYear`, fails a test.
function makeBundle(over: Partial<SwrComparisonBundle> = {}): SwrComparisonBundle {
  return {
    rows: [
      {
        year: 2033,
        guaranteedIncome: 20_000,
        otherIncome: 0,
        afterTaxDraw: 37_000,
        tax: 8_000,
        guaranteedIncomeSplit: { socialSecurity: 15_000, pension: 5_000 },
        guaranteedIncomeSurplus: 0,
        fourPercentRuleValue: 40_000,
        fourPointFivePercentRuleValue: 45_000,
        isPartialYear: false,
      },
      {
        year: 2034,
        guaranteedIncome: 20_500,
        otherIncome: 3_000,
        afterTaxDraw: 38_000,
        tax: 8_200,
        guaranteedIncomeSplit: { socialSecurity: 15_300, pension: 5_200 },
        guaranteedIncomeSurplus: 0,
        fourPercentRuleValue: 40_000,
        fourPointFivePercentRuleValue: 45_000,
        isPartialYear: false,
      },
    ],
    portfolioAtRetirement: 1_000_000,
    anchorYear: 2033,
    anchorAfterTaxDraw: 37_000,
    fourPercentRule: {
      ratePct: 4,
      impliedFirstYearAnnualSpend: 40_000,
      lineValuesByYear: [{ year: 2033, value: 40_000 }],
      plannedMinusRuleFirstYearDelta: -3_000,
    },
    fourPointFivePercentRule: {
      ratePct: 4.5,
      impliedFirstYearAnnualSpend: 45_000,
      lineValuesByYear: [{ year: 2033, value: 45_000 }],
      plannedMinusRuleFirstYearDelta: -8_000,
    },
    depletionYear: null,
    noTaxFigures: false,
    valuationOffsetYears: 0,
    ...over,
  };
}

const BASE_PROPS: Omit<BalanceProjectionSwrSectionProps, 'vm' | 'resolvedLabel' | 'isMcBasisActive' | 'displayMode'> = {
  data: null,
  selectedScenarioId: 's1',
  canonicalIncome: [],
  canonicalExpenses: [],
  ssBenefits: [],
  activeMethod: 'planned',
  activeMcBasis: null,
  nowYear: 2026,
  nowMonthIndex: 0,
  tooltipMembers: [],
};

function renderPanel(props: Partial<BalanceProjectionSwrSectionProps> = {}) {
  return render(
    withTheme(
      'light',
      <MemoryRouter>
        <BalanceProjectionSwrSection
          {...BASE_PROPS}
          vm={makeVm(2032)}
          resolvedLabel="Planned"
          isMcBasisActive={false}
          displayMode="today"
          {...props}
        />
      </MemoryRouter>,
    ),
  );
}

beforeEach(() => {
  result = { state: 'ok', bundle: makeBundle() };
  lastResolverInput = undefined;
});

describe('BalanceProjectionSwrSection — state routing', () => {
  it('renders nothing for the two inherited states (no bespoke copy)', () => {
    for (const state of ['historical-unavailable', 'mc-run-unavailable'] as const) {
      result = { state, bundle: null };
      const { container, unmount } = renderPanel();
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('renders a bespoke, non-blank state for mc-index-out-of-range — it is NOT an inherited state', () => {
    result = { state: 'mc-index-out-of-range', bundle: null };
    renderPanel({ isMcBasisActive: true, resolvedLabel: 'Typical' });
    // The heading still renders (unlike the two inherited states) because the tier stays enabled on the Basis select; a blank panel would leave no explanation.
    expect(
      screen.getByRole('heading', { name: /Safe withdrawal rate comparison \(Typical\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/no earlier year-end balance/)).toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    // The copy must not point to "Show another likely path": the reroll replays a different seed against the same `firstYear`, so the index test comes out identical every press; only a different basis clears it.
    expect(screen.queryByText(/reroll/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/another likely path/i)).not.toBeInTheDocument();
    expect(screen.getByText(/different basis/)).toBeInTheDocument();
  });

  it('renders the already-retired state with no CTA and no $0/blank figure', () => {
    result = { state: 'no-retirement-year', bundle: null };
    renderPanel();
    expect(screen.getByText(/retirement date has already passed/)).toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders the insufficient-data state with a route to fix it, no $0/blank figure', () => {
    for (const state of ['no-runner-result', 'no-full-retirement-year'] as const) {
      result = { state, bundle: null };
      const { unmount } = renderPanel();
      expect(
        screen.getByText(/can.t compare this scenario/),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open the scenario editor' })).toHaveAttribute(
        'href',
        '/scenarios/s1',
      );
      expect(screen.queryByText('$0')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('mounts no chart for a one-year window, mounts one for two or more years', async () => {
    result = { state: 'ok', bundle: makeBundle({ rows: [makeBundle().rows[0]] }) };
    const { unmount } = renderPanel();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    unmount();

    result = { state: 'ok', bundle: makeBundle() };
    renderPanel();
    expect(await screen.findByRole('img')).toBeInTheDocument();
  });
});

describe('BalanceProjectionSwrSection — card figures (ready state)', () => {
  it('states the retirement year, portfolio, first-full-year after-tax draw, both implied spends, and two SEPARATE deltas', () => {
    renderPanel();
    // Each figure is read through its own Stat label, so a figure wired to the wrong quantity (the after-tax draw fed from the 4% implied spend) fails here.
    expect(statText('Retirement year')).toBe('2032'); // vm.primaryRetirementYear, NOT bundle.anchorYear (2033).
    expect(statText('Portfolio at retirement')).toBe('$1.0M');
    expect(statText('First-full-year portfolio draw (after tax)')).toBe('$37k');
    expect(statText('4% rule: implied spend')).toBe('$40k');
    expect(statText('4.5% rule: implied spend')).toBe('$45k');
    expect(statText('Your draw vs. the 4% rule')).toBe('$3k below');
    expect(statText('Your draw vs. the 4.5% rule')).toBe('$8k below');
  });

  it('a draw above BOTH rules shows two positive deltas, never a single verdict', () => {
    result = {
      state: 'ok',
      bundle: makeBundle({
        anchorAfterTaxDraw: 50_000,
        fourPercentRule: {
          ratePct: 4,
          impliedFirstYearAnnualSpend: 40_000,
          lineValuesByYear: [{ year: 2032, value: 40_000 }],
          plannedMinusRuleFirstYearDelta: 10_000,
        },
        fourPointFivePercentRule: {
          ratePct: 4.5,
          impliedFirstYearAnnualSpend: 45_000,
          lineValuesByYear: [{ year: 2032, value: 45_000 }],
          plannedMinusRuleFirstYearDelta: 5_000,
        },
      }),
    };
    renderPanel();
    expect(screen.getByText('$10k above')).toBeInTheDocument();
    expect(screen.getByText('$5k above')).toBeInTheDocument();
  });

  it('a draw below BOTH rules shows two negative deltas, never a single verdict', () => {
    result = {
      state: 'ok',
      bundle: makeBundle({
        anchorAfterTaxDraw: 30_000,
        fourPercentRule: {
          ratePct: 4,
          impliedFirstYearAnnualSpend: 40_000,
          lineValuesByYear: [{ year: 2032, value: 40_000 }],
          plannedMinusRuleFirstYearDelta: -10_000,
        },
        fourPointFivePercentRule: {
          ratePct: 4.5,
          impliedFirstYearAnnualSpend: 45_000,
          lineValuesByYear: [{ year: 2032, value: 45_000 }],
          plannedMinusRuleFirstYearDelta: -15_000,
        },
      }),
    };
    renderPanel();
    expect(screen.getByText('$10k below')).toBeInTheDocument();
    expect(screen.getByText('$15k below')).toBeInTheDocument();
  });

  it('deltas are worded, never color-coded', () => {
    renderPanel();
    const delta = screen.getByText('$8k below');
    expect(delta.className).not.toMatch(/positive|negative/);
  });
});

describe('BalanceProjectionSwrSection — card and chart agree', () => {
  it("the chart's first compared year carries the card's after-tax draw", async () => {
    const { container } = renderPanel();
    const chartFrame = await screen.findByRole('img');
    const svg = chartFrame.querySelector('svg') as SVGSVGElement;
    const cardDraw = statText('First-full-year portfolio draw (after tax)');

    Object.defineProperty(svg, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, width: 600, height: 320, top: 0, left: 0, right: 600, bottom: 320, toJSON: () => ({}) }),
      configurable: true,
    });
    fireEvent.pointerMove(svg, { clientX: 40 });
    const tooltip = container.querySelector('[role="tooltip"]') as HTMLElement;
    expect(tooltip).not.toBeNull();
    const drawRow = within(tooltip)
      .getByText('Portfolio withdrawal (after tax)')
      .closest('div');
    expect(drawRow?.textContent).toContain('$37,000');
    expect(cardDraw).toBe('$37k');
  });

  it('the other-income layer survives the wiring for a year with part-time/one-off income', async () => {
    renderPanel();
    await screen.findByRole('img');
    expect(screen.getByText('Other income')).toBeInTheDocument();
  });
});

describe('BalanceProjectionSwrSection — forwards its resolver input', () => {
  it("passes displayMode, activeMethod, and activeMcBasis straight to 01's resolver, for both dollar modes and under an MC basis", () => {
    renderPanel({ displayMode: 'today', activeMethod: 'twr', activeMcBasis: null });
    expect(lastResolverInput?.displayMode).toBe('today');
    expect(lastResolverInput?.activeMethod).toBe('twr');
    expect(lastResolverInput?.activeMcBasis).toBeNull();

    const { unmount } = renderPanel({
      displayMode: 'future',
      activeMethod: 'planned',
      activeMcBasis: 'mc-typical',
      isMcBasisActive: true,
    });
    expect(lastResolverInput?.displayMode).toBe('future');
    expect(lastResolverInput?.activeMethod).toBe('planned');
    expect(lastResolverInput?.activeMcBasis).toBe('mc-typical');
    unmount();
  });
});

describe('BalanceProjectionSwrSection — dollar mode', () => {
  it('states which dollar mode the figures are in', () => {
    renderPanel({ displayMode: 'today' });
    expect(screen.getByText(/today's dollars/)).toBeInTheDocument();
    const { unmount } = renderPanel({ displayMode: 'future' });
    expect(screen.getByText(/future \(nominal\) dollars/)).toBeInTheDocument();
    unmount();
  });
});

describe('BalanceProjectionSwrSection — Monte Carlo tier', () => {
  it('suffixes the heading with the basis label and renders the representative-run sublabel', () => {
    renderPanel({ resolvedLabel: 'Typical', isMcBasisActive: true });
    expect(
      screen.getByRole('heading', { name: /Safe withdrawal rate comparison \(Typical\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Based on one example simulated path.')).toBeInTheDocument();
  });

  it('omits the sublabel under a deterministic basis', () => {
    renderPanel({ resolvedLabel: 'Planned', isMcBasisActive: false });
    expect(screen.queryByText('Based on one example simulated path.')).not.toBeInTheDocument();
  });

  it('reflects a rerolled bundle: the portfolio figure and BOTH rule lines move together, never a stale one left behind', () => {
    const { unmount } = renderPanel({ resolvedLabel: 'Typical', isMcBasisActive: true });
    expect(statText('Portfolio at retirement')).toBe('$1.0M');
    expect(statText('4% rule: implied spend')).toBe('$40k');
    expect(statText('4.5% rule: implied spend')).toBe('$45k');
    // A fresh mount, not a `rerender`, mirrors how the panel learns of a reroll: a new bundle object from the resolver. The prior render must unmount first or both panels' identically labelled Stats collide.
    unmount();

    // A new representative run's bundle: a different portfolio, and both rule lines (struck off that same portfolio figure) move together.
    result = {
      state: 'ok',
      bundle: makeBundle({
        portfolioAtRetirement: 1_200_000,
        fourPercentRule: {
          ratePct: 4,
          impliedFirstYearAnnualSpend: 48_000,
          lineValuesByYear: [{ year: 2033, value: 48_000 }],
          plannedMinusRuleFirstYearDelta: -11_000,
        },
        fourPointFivePercentRule: {
          ratePct: 4.5,
          impliedFirstYearAnnualSpend: 54_000,
          lineValuesByYear: [{ year: 2033, value: 54_000 }],
          plannedMinusRuleFirstYearDelta: -17_000,
        },
      }),
    };
    renderPanel({ resolvedLabel: 'Typical', isMcBasisActive: true });
    expect(statText('Portfolio at retirement')).toBe('$1.2M');
    expect(statText('4% rule: implied spend')).toBe('$48k');
    expect(statText('4.5% rule: implied spend')).toBe('$54k');
  });
});

describe('BalanceProjectionSwrSection — the disclosure is basis-aware', () => {
  it('names only the comparison-start year when valuation and anchor coincide', () => {
    result = { state: 'ok', bundle: makeBundle({ valuationOffsetYears: 0 }) };
    renderPanel();
    expect(screen.getByText(/the same year the comparison below starts/)).toBeInTheDocument();
  });

  it('names both the valuation year and the later comparison-start year when they differ', () => {
    result = { state: 'ok', bundle: makeBundle({ valuationOffsetYears: 1, anchorYear: 2032 }) };
    renderPanel();
    expect(
      screen.getByText(/valued at December 2031, the year this scenario has you retiring/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/comparison below starts 2032, the first full calendar year/),
    ).toBeInTheDocument();
  });

  it('names the representative path, not a retirement date, under a Monte Carlo tier', () => {
    result = { state: 'ok', bundle: makeBundle({ valuationOffsetYears: 1, anchorYear: 2032 }) };
    renderPanel({ isMcBasisActive: true, resolvedLabel: 'Typical' });
    expect(
      screen.getByText(/last full year before this example path reaches retirement/),
    ).toBeInTheDocument();
  });

  it('under a two-year MC offset, names the earlier valuation year AND the distinct partial transition year — never the same year twice', () => {
    // Retirement 2032-07-01 under Typical: anchorYear 2033, valuationOffsetYears 2 (valuation year 2031, a full accumulation year, not charted); 2032 is the partial retirement-transition year, marked via the first row's `isPartialYear`.
    result = {
      state: 'ok',
      bundle: makeBundle({
        valuationOffsetYears: 2,
        anchorYear: 2033,
        rows: [
          { ...makeBundle().rows[0], year: 2032, isPartialYear: true },
          { ...makeBundle().rows[0], year: 2033, isPartialYear: false },
        ],
      }),
    };
    renderPanel({ isMcBasisActive: true, resolvedLabel: 'Typical' });
    expect(
      screen.getByText(/valued at December 2031, the last full year before this example path reaches retirement/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/comparison below starts 2033, the first full calendar year/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2032, the year in between, is a partial retirement-transition year/),
    ).toBeInTheDocument();
    // 2031, the valuation year and not in the charted window, must never be called the partial year.
    expect(screen.queryByText(/2031 is a partial year/)).not.toBeInTheDocument();
  });
});

describe('BalanceProjectionSwrSection — the (i) popover names the exclusion', () => {
  it('states the cash-balance-plan exclusion, never restated in the visible card', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'About the safe withdrawal rate chart' }));
    expect(
      await screen.findByText(/excludes any cash-balance-plan account/),
    ).toBeInTheDocument();
  });
});

describe('BalanceProjectionSwrSection — a11y', () => {
  it('has no axe violations in the ready state', async () => {
    const container = renderWithTheme(
      'light',
      <MemoryRouter>
        <BalanceProjectionSwrSection
          {...BASE_PROPS}
          vm={makeVm(2032)}
          resolvedLabel="Planned"
          isMcBasisActive={false}
          displayMode="today"
        />
      </MemoryRouter>,
    );
    await screen.findByRole('img');
    await expectNoA11yViolations(container);
  });
});
