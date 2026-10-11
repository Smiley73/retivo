/**
 * View-model reroll behavior ("show another likely path").
 *
 * Drives `useBalanceProjectionViewModel`'s session-only reroll state through a
 * mocked `usePlanStressTestVm`: a stub `MonteCarloSummary` carrying a per-tier
 * `representativeBandsByBasis` + `representativeByBasis`, and a `replayPath`
 * spy. Asserts:
 *   - `showAnotherPath()` swaps `activeRepresentativeRun` to a replayed
 *     alternative band path (not the default element 0);
 *   - the depletion cards + percentile series on the summary are byte-for-byte
 *     unchanged after a reroll (only the basis line moves);
 *   - `canShowAnotherPath` is false when the active tier's band has <2 members
 *     or no MC basis is active;
 *   - a new summary clears the override (session-only).
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { MonteCarloSummary, RepresentativeRun, McBasis } from '../lib/monte-carlo';
import type { PlanStressTestVm } from '../components/PlanStressTestSection';
import { ThemeProvider } from '../contexts/ThemeContext';

// The view model reads chart tokens via `useChartColors()`, which needs the
// ThemeProvider context.
function wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

// Controllable mock surface for the stress VM the view model consumes.
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
import type { PipelineData } from './balance-projection-page-pipeline';

/** Minimal `PipelineData` stub carrying just the `pageResult.sharedCtx`
 *  fields the toggle-availability + fallback-disclosure derivations read.
 *  Other `data.*` consumers tolerate the empty / null fields. */
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

/** Minimal `RepresentativeRun` tagged with `seed` so the spy + assertions can
 *  tell the default pick from a replayed alternative. */
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
      // Element 0 = the default reconciled pick's seed; 1..N−1 are alternatives.
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

    // Default: element-0 pick.
    expect(result.current.activeRepresentativeRun?.seed).toBe(DEFAULT_PESS_SEED);
    expect(result.current.canShowAnotherPath).toBe(true);

    // Snapshot the summary cards/percentiles BEFORE the reroll.
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

    // replayPath was called with one of the ALTERNATIVE band seeds (never the
    // default element-0 seed).
    expect(replayPathMock).toHaveBeenCalledTimes(1);
    const calledSeed = replayPathMock.mock.calls[0][0] as number;
    expect(ALT_SEEDS).toContain(calledSeed);
    expect(calledSeed).not.toBe(DEFAULT_PESS_SEED);

    // The basis line is now the replayed alternative.
    expect(result.current.activeRepresentativeRun?.seed).toBe(ALT_SEEDS[0]);

    // Cards + percentile series are byte-for-byte unchanged (same summary object).
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
    // showAnotherPath is a guarded no-op — replayPath never called.
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

    // A fresh worker run lands (new summary object) → override drops, basis line
    // reverts to the new summary's default element-0 pick.
    act(() => {
      mockResult = makeSummary();
    });
    rerender();
    expect(result.current.activeRepresentativeRun?.seed).toBe(DEFAULT_PESS_SEED);
  });
});

describe('useBalanceProjectionViewModel — Historical toggle availability', () => {
  // A mixed portfolio (≥1 empirical + ≥1 fallback) keeps Historical
  // available — sourced from the runner's `methodAvailable`, NOT
  // `outputs.twr !== null` (which is always true).
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

  // Degenerate: no non-CBP account has empirical history → Historical
  // hidden even though `outputs.twr` is non-null for every account.
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
