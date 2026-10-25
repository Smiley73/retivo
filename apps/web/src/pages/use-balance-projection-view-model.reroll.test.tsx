// View-model reroll ("show another likely path"): drives `useBalanceProjectionViewModel`'s session-only override through a mocked `usePlanStressTestVm` (a stub summary with `representativeBandsByBasis` / `representativeByBasis` and a `replayPath` spy).
// `showAnotherPath()` swaps to a replayed alternative band path; cards and percentile series stay byte-identical; `canShowAnotherPath` is false with <2 band members or no MC basis; a new summary clears the override.
import React from 'react';
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { MonteCarloSummary, RepresentativeRun, McBasis } from '../lib/monte-carlo';
import type { PlanStressTestVm } from '../components/PlanStressTestSection';
import { ThemeProvider } from '../contexts/ThemeContext';

// The view model reads chart tokens via `useChartColors()`, which needs the ThemeProvider context.
function wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

let mockResult: MonteCarloSummary | null = null;
const replayPathMock: Mock = vi.fn();

vi.mock('../components/PlanStressTestSection', () => ({
  usePlanStressTestVm: (): Partial<PlanStressTestVm> => ({
    result: mockResult,
    replayPath: replayPathMock,
    hasNoAccounts: false,
    isRunning: false,
    isStale: false,
    error: null,
  }),
}));

import { useBalanceProjectionViewModel } from './use-balance-projection-view-model';
import type { PipelineData } from './balance-projection-page-data';

// Minimal `PipelineData` stub carrying only the `pageResult.sharedCtx` fields the toggle-availability and fallback-disclosure derivations read.
function makeData(opts: {
  methodAvailable: boolean;
  fallbackAccounts: ReadonlyArray<{ id: string; name: string }>;
}): PipelineData {
  return {
    scenarios: [],
    selectedScenarioId: 's',
    resolved: {},
    members: [],
    primaryMember: null,
    memberRetirementById: new Map(),
    rows: [],
    accounts: [],
    hiddenInactiveCount: 0,
    hiddenZeroHistoryCount: 0,
    primaryRetirementAbsMonth: null,
    pageResult: {
      planned: null,
      twr: null,
      sharedCtx: {
        methodAvailable: opts.methodAvailable,
        fallbackAccounts: opts.fallbackAccounts,
      },
    },
  } as unknown as PipelineData;
}

// Minimal `RepresentativeRun` tagged with `seed` so assertions can tell the default pick from a replayed alternative.
function makeRun(seed: number, depletionYear: number | null): RepresentativeRun {
  return {
    firstYear: 2026,
    seed,
    years: [],
    depletionYear,
    perMonthWithdrawal: new Float64Array(0),
    realBalanceByYear: [],
    realGrowthByYear: [],
    realFactorByYear: [],
  };
}

const DEFAULT_PESS_SEED = 1000;
const ALT_SEEDS = [2000, 3000, 4000];

function makeSummary(
  overrides: Partial<MonteCarloSummary> = {},
): MonteCarloSummary {
  const byBasis: Record<McBasis, RepresentativeRun | null> = {
    'mc-typical': makeRun(500, 2080),
    'mc-pessimistic': makeRun(DEFAULT_PESS_SEED, 2070),
    'mc-bad-luck': makeRun(100, 2060),
  };
  return {
    engineVersion: 27,
    seed: 42,
    pathCount: 100,
    computedAt: 0,
    firstYear: 2026,
    horizonYears: 3,
    percentilesNominal: { p10: [1, 2, 3], p25: [4, 5, 6], p50: [7, 8, 9] },
    percentilesReal: { p10: [10, 20, 30], p25: [40, 50, 60], p50: [70, 80, 90] },
    successProbability: 0.4,
    medianDepletionYear: 2080,
    p10DepletionYear: 2060,
    p25DepletionYear: 2070,
    medianEndingBalanceNominal: 0,
    medianEndingBalanceReal: 0,
    p10EndingBalanceNominal: 0,
    p10EndingBalanceReal: 0,
    p25EndingBalanceNominal: 0,
    p25EndingBalanceReal: 0,
    failureYearHistogram: [],
    endingBalanceHistogramNominal: [],
    endingBalanceHistogramReal: [],
    plannedOverlay: [],
    representativeByBasis: byBasis,
    representativeBandsByBasis: {
      // Element 0 is the default reconciled pick's seed; 1..N−1 are alternatives.
      'mc-typical': [500],
      'mc-pessimistic': [DEFAULT_PESS_SEED, ...ALT_SEEDS],
      'mc-bad-luck': [100, 999],
    },
    ...overrides,
  };
}

const baseInput = {
  data: null,
  selectedScenarioId: null,
  canonicalBalances: [],
  canonicalExpenses: [],
  expenseCategories: [],
  canonicalIncome: [],
  ssBenefits: [],
  displayMode: 'today' as const,
  cashflowGranularity: 'yearly' as const,
  incomeBreakdownGranularity: 'yearly' as const,
  activeMethod: 'planned' as const,
  setActiveMethod: () => {},
  nowYear: 2026,
  nowMonthIndex: 4,
  nowDay: 1,
  resolvedTheme: 'light' as const,
};

beforeEach(() => {
  mockResult = makeSummary();
  replayPathMock.mockReset();
});

describe('useBalanceProjectionViewModel — reroll (show another likely path)', () => {
  it('swaps activeRepresentativeRun to a replayed alternative; cards/percentiles unchanged', () => {
    const replayed = makeRun(ALT_SEEDS[0], 2071);
    replayPathMock.mockReturnValue(replayed);

    let activeMcBasis: McBasis | null = 'mc-pessimistic';
    const setActiveMcBasis = (b: McBasis | null) => {
      activeMcBasis = b;
    };
    const { result, rerender } = renderHook(
      (props: { activeMcBasis: McBasis | null }) =>
        useBalanceProjectionViewModel({
          ...baseInput,
          activeMcBasis: props.activeMcBasis,
          setActiveMcBasis,
        }),
      { initialProps: { activeMcBasis }, wrapper },
    );

    expect(result.current.activeRepresentativeRun?.seed).toBe(DEFAULT_PESS_SEED);
    expect(result.current.canShowAnotherPath).toBe(true);

    const cardsBefore = {
      median: mockResult!.medianDepletionYear,
      p25: mockResult!.p25DepletionYear,
      p10: mockResult!.p10DepletionYear,
      p50Real: mockResult!.percentilesReal.p50,
      p25Real: mockResult!.percentilesReal.p25,
    };

    act(() => {
      result.current.showAnotherPath();
    });
    rerender({ activeMcBasis });

    // replayPath is called with an alternative band seed, never the default element-0 seed.
    expect(replayPathMock).toHaveBeenCalledTimes(1);
    const calledSeed = replayPathMock.mock.calls[0][0] as number;
    expect(ALT_SEEDS).toContain(calledSeed);
    expect(calledSeed).not.toBe(DEFAULT_PESS_SEED);

    expect(result.current.activeRepresentativeRun?.seed).toBe(ALT_SEEDS[0]);

    expect(mockResult!.medianDepletionYear).toBe(cardsBefore.median);
    expect(mockResult!.p25DepletionYear).toBe(cardsBefore.p25);
    expect(mockResult!.p10DepletionYear).toBe(cardsBefore.p10);
    expect(mockResult!.percentilesReal.p50).toBe(cardsBefore.p50Real);
    expect(mockResult!.percentilesReal.p25).toBe(cardsBefore.p25Real);
  });

  it('canShowAnotherPath is false for a single-member band', () => {
    const { result } = renderHook(
      () =>
        useBalanceProjectionViewModel({
          ...baseInput,
          activeMcBasis: 'mc-typical', // band has 1 member
          setActiveMcBasis: () => {},
        }),
      { wrapper },
    );
    expect(result.current.canShowAnotherPath).toBe(false);
    act(() => {
      result.current.showAnotherPath();
    });
    expect(replayPathMock).not.toHaveBeenCalled();
  });

  it('canShowAnotherPath is false when no MC basis is active', () => {
    const { result } = renderHook(
      () =>
        useBalanceProjectionViewModel({
          ...baseInput,
          activeMcBasis: null,
          setActiveMcBasis: () => {},
        }),
      { wrapper },
    );
    expect(result.current.canShowAnotherPath).toBe(false);
  });

  it('clears the reroll override when a new summary arrives (session-only)', () => {
    replayPathMock.mockReturnValue(makeRun(ALT_SEEDS[0], 2071));
    const { result, rerender } = renderHook(
      () =>
        useBalanceProjectionViewModel({
          ...baseInput,
          activeMcBasis: 'mc-pessimistic',
          setActiveMcBasis: () => {},
        }),
      { wrapper },
    );
    act(() => {
      result.current.showAnotherPath();
    });
    rerender();
    expect(result.current.activeRepresentativeRun?.seed).toBe(ALT_SEEDS[0]);

    // A fresh worker run lands (a new summary object): the override drops and the basis line reverts to the new summary's default element-0 pick.
    act(() => {
      mockResult = makeSummary();
    });
    rerender();
    expect(result.current.activeRepresentativeRun?.seed).toBe(DEFAULT_PESS_SEED);
  });
});

describe('useBalanceProjectionViewModel — Historical toggle availability', () => {
  // A mixed portfolio (≥1 empirical, ≥1 fallback) keeps Historical available, sourced from the runner's `methodAvailable`, not `outputs.twr !== null` (always true).
  it('enables Historical from the methodAvailable flag and surfaces fallbacks', () => {
    const { result } = renderHook(
      () =>
        useBalanceProjectionViewModel({
          ...baseInput,
          data: makeData({
            methodAvailable: true,
            fallbackAccounts: [{ id: 'short', name: 'New Roth' }],
          }),
          activeMcBasis: null,
          setActiveMcBasis: () => {},
        }),
      { wrapper },
    );
    expect(result.current.enabledCalculatedMethods.has('twr')).toBe(true);
    expect(result.current.fallbackAccounts).toEqual([
      { id: 'short', name: 'New Roth' },
    ]);
  });

  // Degenerate: no non-CBP account has empirical history, so Historical is hidden even though `outputs.twr` is non-null for every account.
  it('hides Historical in the degenerate all-fallback case', () => {
    const { result } = renderHook(
      () =>
        useBalanceProjectionViewModel({
          ...baseInput,
          data: makeData({
            methodAvailable: false,
            fallbackAccounts: [{ id: 'a1', name: 'Brokerage' }],
          }),
          activeMcBasis: null,
          setActiveMcBasis: () => {},
        }),
      { wrapper },
    );
    expect(result.current.enabledCalculatedMethods.has('twr')).toBe(false);
  });
});
