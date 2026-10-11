/**
 * Test factory for `RunBalanceProjectionFullResult` bundles. Defaults
 * produce a minimal valid bundle (empty drawdown, no markers,
 * `methodAvailable: true`, pinned anchor `todayYear: 2026,
 * todayMonthIndex: 5`). Sibling render-page unit tests override only
 * the fields under test; runner-shape changes become one factory edit.
 */
import type { ProjectionContext } from '../lib/projection-context';
import type {
  AccountYearRow,
  CbpValidationResult,
  DrawdownYearRow,
  LifeExpectancyMarker,
  MonthlyCashflowSeriesPublic,
  RetirementMarkerOutput,
  RunBalanceProjectionFullResult,
  WithdrawalEvent,
} from '../lib/balance-projection-runner-types';

export type DeepPartial<T> = T extends ReadonlyMap<infer K, infer V>
  ? ReadonlyMap<K, V>
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepPartial<U>>
    : T extends object
      ? { readonly [P in keyof T]?: DeepPartial<T[P]> }
      : T;

/** Pinned anchor — May 2026 (the migration plan's reference). */
const DEFAULT_TODAY_YEAR = 2026;
const DEFAULT_TODAY_MONTH = 5;

function defaultCtx(): ProjectionContext {
  const asOfMonth = DEFAULT_TODAY_YEAR * 12 + DEFAULT_TODAY_MONTH;
  return {
    asOfYear: DEFAULT_TODAY_YEAR,
    asOfMonthIndex: DEFAULT_TODAY_MONTH,
    asOfMonth,
    firstProjectionMonth: asOfMonth,
    primaryRetirementMonth: (DEFAULT_TODAY_YEAR + 20) * 12,
    horizonMonth: (DEFAULT_TODAY_YEAR + 50) * 12 + 11,
    inflationPct: 3,
  };
}

function emptyCashflow(): MonthlyCashflowSeriesPublic {
  const empty = {
    startYear: DEFAULT_TODAY_YEAR,
    startMonthIndex: DEFAULT_TODAY_MONTH,
    values: new Float64Array(0),
  };
  return {
    incomeByMonth: empty,
    expensesByMonth: empty,
    depositsByMonth: empty,
  };
}

function defaultResult(): RunBalanceProjectionFullResult {
  return {
    atHorizonTodayDollars: 0,
    ssStartYear: DEFAULT_TODAY_YEAR + 20,
    retirementYear: DEFAULT_TODAY_YEAR + 20,
    horizonYear: DEFAULT_TODAY_YEAR + 50,
    ctx: defaultCtx(),
    methodAvailable: true,
    accountYears: new Map<string, ReadonlyArray<AccountYearRow>>(),
    drawdownYears: [] as ReadonlyArray<DrawdownYearRow>,
    withdrawalEvents: [] as ReadonlyArray<WithdrawalEvent>,
    monthlyCashflowSeries: emptyCashflow(),
    lifeExpectancyMarkers: [] as ReadonlyArray<LifeExpectancyMarker>,
    retirementMarkers: [] as ReadonlyArray<RetirementMarkerOutput>,
    cbpResolution: null as CbpValidationResult | null,
    todayYear: DEFAULT_TODAY_YEAR,
    todayMonthIndex: DEFAULT_TODAY_MONTH,
  };
}

export function buildRunnerBundle(
  overrides: DeepPartial<RunBalanceProjectionFullResult> = {},
): RunBalanceProjectionFullResult {
  const base = defaultResult();
  // Shallow merge — `overrides` carry whole new collections in their
  // typed shape; recursive deep-merge would require knowledge of every
  // collection's identity rules and add no value here.
  return { ...base, ...(overrides as Partial<RunBalanceProjectionFullResult>) };
}
