/**
 * Shared test fixtures for `PlanStressTestVm` (and its backing
 * `MonteCarloSummary`). Lifted out of `PlanStressTestSection.test.tsx`
 * so both the stress-test slot suite and the Balance Projection
 * chart-section suite build a full VM from one factory instead of
 * duplicating ~30 required fields (a partial literal will not
 * typecheck).
 *
 * Test-only — not imported by production code.
 */
import type { MonteCarloSummary } from '../../lib/monte-carlo';
import type { PlanStressTestVm, DisplayMode } from '../PlanStressTestSection';

/** Baseline `MonteCarloSummary`. Exported so a test can stage a STRESSED
 *  sibling summary that differs from the base only where the test says. */
export function summary(
  overrides: Partial<MonteCarloSummary> = {},
): MonteCarloSummary {
  const horizon = 3;
  return {
    engineVersion: 4,
    seed: 1,
    pathCount: 100,
    computedAt: 0,
    firstYear: 2030,
    horizonYears: horizon,
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
    ...overrides,
  };
}

export function vm(
  overrides: Partial<PlanStressTestVm> & { displayMode?: DisplayMode } = {},
): PlanStressTestVm {
  const displayMode: DisplayMode = overrides.displayMode ?? 'today';
  const base: PlanStressTestVm = {
    hasNoAccounts: false,
    isRunning: false,
    isStale: false,
    error: null,
    result: summary(),
    progressDone: 0,
    progressTotal: 0,
    cancel: () => undefined,
    retry: () => undefined,
    recalculate: () => undefined,
    startTypical: 1_000_000,
    startPessimistic: 900_000,
    startBadLuck: 800_000,
    endTypical: 500_000,
    endPessimistic: 300_000,
    endBadLuck: 100_000,
    typicalDepletionYear: null,
    pessimisticDepletionYear: null,
    badLuckDepletionYear: null,
    successPct: 50,
    successTier: 'danger',
    retirementFractionalYear: 2046,
    retirementLabel: null,
    lifeMarkers: [],
    lastDeathYear: 2086,
    displayMode,
    cbpValidation: {
      ok: true,
      unconfigured: [],
      annuityMissingStream: [],
      annuityDuplicateStream: [],
    },
    cbpAccounts: [],
    cbpMembers: [],
    stressBaseInput: null,
    stressPairSignature: null,
    longestLivedBirthYear: null,
    lastSurvivor: null,
    replayPath: () => null,
  };
  return { ...base, ...overrides };
}
