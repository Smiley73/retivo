/**
 * Public entry points of the balance-projection runner: the deterministic runs and the Monte Carlo input
 * builder.
 */
import { MissingCustomDrawdownOrderError } from './drawdown-engine-per-account';
import type { MonteCarloInput } from './monte-carlo';
import type { GuardrailConfig } from './guardrails';
import {
  CbpUnconfiguredError,
  NoPrimaryRetirementError,
  MagiCapCalibrationError,
  type CashflowSeries,
  type MonthlyCashflowSeriesPublic,
  type PageDrawdownMethodResult,
  type PageSharedContext,
  type PipelineContext,
  type ProjectionMethod,
  type RunBalanceProjectionArgs,
  type RunBalanceProjectionFullResult,
  type RunBalanceProjectionPageResult,
} from './balance-projection-runner-types';
import { buildPipelineContext } from './balance-projection-runner-context';
import { deriveTwrAvailability } from './balance-projection-runner-projection';
import { buildCashflowSeries } from './balance-projection-runner-cashflow';
import { assembleMcBundle } from './monte-carlo-input-bundle';
import {
  buildMcTaxContext,
  buildMcRmdContext,
  buildMcQcdContext,
  buildMcStrategyOptsFromContext,
  mcInputFromBundle,
} from './balance-projection-runner-mc';
import {
  buildAccountYearsMap,
  buildDrawdownYearRows,
  buildEmptyFullResult,
  buildLifeExpectancyMarkers,
  buildRetirementMarkersFromCtx,
  buildWithdrawalEvents,
} from './balance-projection-runner-result';
import { runDrawdownForMethod } from './balance-projection-runner-drawdown';

export type {
  CandidateOverlay,
  RunBalanceProjectionArgs,
  RunBalanceProjectionResult,
  RunBalanceProjectionAtHorizonResult,
  RunBalanceProjectionFullResult,
  RunBalanceProjectionPageResult,
  PageDrawdownMethodResult,
  PageSharedContext,
  AccountYearRow,
  DrawdownYearRow,
  LifeExpectancyMarker,
  RetirementMarkerOutput,
  MonthlyCashflowSeriesPublic,
  WithdrawalEvent,
} from './balance-projection-runner-types';
export {
  CbpUnconfiguredError,
  NoPrimaryRetirementError,
  MagiCapCalibrationError,
} from './balance-projection-runner-types';
export { computePlannedAtHorizonToday } from './balance-projection-runner-result';

/**
 * Runs the Balance Projection pipeline and returns the full bundle the page consumes. `cbpResolution` is set
 * on every result, including when later phases short-circuit; an unconfigured CBP returns `ok === false`
 * rather than throwing.
 */
export function runBalanceProjection(
  args: RunBalanceProjectionArgs,
): RunBalanceProjectionFullResult {
  const ctx = buildPipelineContext(args);
  if (!ctx) throw new NoPrimaryRetirementError();
  if (ctx.cbpValidation && !ctx.cbpValidation.ok) {
    return buildEmptyFullResult(args, ctx);
  }
  if (!ctx.methodAvailable) {
    return buildEmptyFullResult(args, ctx);
  }
  return computeFullResult(args, ctx);
}

/**
 * Builds the MC input bundle. Throws `CbpUnconfiguredError` when a CBP election is unconfigured; callers
 * check `cbpResolution` from the deterministic run first.
 */
export function runBalanceProjectionMc(
  args: RunBalanceProjectionArgs,
  opts?: { readonly guardrailOverrideConfig?: GuardrailConfig },
): MonteCarloInput {
  const ctx = buildPipelineContext(args);
  if (!ctx) throw new NoPrimaryRetirementError();
  if (ctx.cbpValidation && !ctx.cbpValidation.ok) {
    throw new CbpUnconfiguredError();
  }
  const series = buildCashflowSeries(args, ctx);
  const bundle = assembleMcBundle({
    runArgs: args,
    ctx,
    cashflowSeries: series,
    ...(opts?.guardrailOverrideConfig !== undefined
      ? { guardrailOverrideConfig: opts.guardrailOverrideConfig }
      : {}),
  });
  const taxContext = buildMcTaxContext(ctx, series.ssRows);
  const strategyOpts = buildMcStrategyOptsFromContext(args, ctx, bundle);
  return mcInputFromBundle(
    bundle,
    taxContext,
    strategyOpts,
    buildMcRmdContext(ctx),
    buildMcQcdContext(ctx),
  );
}

/**
 * Deterministic page entry: runs the shared setup once and both methods (Planned, TWR) off it, returning
 * `{ planned, twr, sharedCtx }`.
 * Unlike `runBalanceProjection`, a `MagiCapCalibrationError` or `MissingCustomDrawdownOrderError` degrades
 * that method to `null`; an unconfigured CBP returns `null` for both with `sharedCtx.cbpResolution` set.
 */
export function runBalanceProjectionForPage(
  args: RunBalanceProjectionArgs,
): RunBalanceProjectionPageResult {
  const ctx = buildPipelineContext(args);
  if (!ctx) throw new NoPrimaryRetirementError();
  const series = buildCashflowSeries(args, ctx);
  const twrAvailable = deriveTwrAvailability(ctx.accountProjections);
  const sharedCtx: PageSharedContext = {
    accountProjections: ctx.accountProjections,
    monthlyCashflowSeries: {
      incomeByMonth: series.incomeByMonth,
      expensesByMonth: series.expensesByMonth,
      depositsByMonth: series.depositsByMonth,
    },
    lifeExpectancyMarkers: buildLifeExpectancyMarkers(ctx),
    retirementMarkers: buildRetirementMarkersFromCtx(ctx),
    cbpResolution: ctx.cbpValidation,
    ctx: ctx.projCtx,
    retirementYear: ctx.primaryRetirementYear,
    horizonYear: ctx.horizonYear,
    ssStartYear: ctx.ssStartYear,
    medicalInflationRatePct: ctx.medicalInflationRatePct,
    methodAvailable: twrAvailable,
    fallbackAccounts: ctx.fallbackAccounts,
    preRetirementConversionCentsByYear: ctx.preRetirementConversionCentsByYear,
    todayYear: args.todayYear,
    todayMonthIndex: args.todayMonthIndex,
  };
  if (ctx.cbpValidation && !ctx.cbpValidation.ok) {
    return { planned: null, twr: null, sharedCtx };
  }
  return {
    planned: runDrawdownForMethodSafe(args, ctx, series, 'planned'),
    // An unavailable TWR returns the null sentinel, not a planned-fallback drawdown the renderer would
    // mistake for real TWR numbers.
    twr: twrAvailable ? runDrawdownForMethodSafe(args, ctx, series, 'twr') : null,
    sharedCtx,
  };
}

// Swallows `MissingCustomDrawdownOrderError` and `MagiCapCalibrationError` so one method's calibration gap
// does not blank the page; other errors propagate.
function runDrawdownForMethodSafe(
  args: RunBalanceProjectionArgs,
  ctx: PipelineContext,
  series: CashflowSeries,
  method: ProjectionMethod,
): PageDrawdownMethodResult | null {
  try {
    return runDrawdownForMethod(args, ctx, series, method);
  } catch (err) {
    if (
      err instanceof MissingCustomDrawdownOrderError ||
      err instanceof MagiCapCalibrationError
    ) {
      console.warn('[balance-projection] drawdown skipped for method', method, err);
      return null;
    }
    throw err;
  }
}

function computeFullResult(
  args: RunBalanceProjectionArgs,
  ctx: PipelineContext,
): RunBalanceProjectionFullResult {
  const series = buildCashflowSeries(args, ctx);
  const monthlyCashflowSeries: MonthlyCashflowSeriesPublic = {
    incomeByMonth: series.incomeByMonth,
    expensesByMonth: series.expensesByMonth,
    depositsByMonth: series.depositsByMonth,
  };
  const result = runDrawdownForMethod(args, ctx, series, ctx.method);
  const accountYears = result?.accountYears ?? buildAccountYearsMap(ctx);
  if (!result) {
    return {
      atHorizonTodayDollars: 0,
      ssStartYear: ctx.ssStartYear,
      retirementYear: ctx.primaryRetirementYear,
      horizonYear: ctx.horizonYear,
      ctx: ctx.projCtx,
      methodAvailable: ctx.methodAvailable,
      accountYears,
      drawdownYears: [],
      withdrawalEvents: [],
      monthlyCashflowSeries,
      lifeExpectancyMarkers: buildLifeExpectancyMarkers(ctx),
      retirementMarkers: buildRetirementMarkersFromCtx(ctx),
      cbpResolution: ctx.cbpValidation,
      todayYear: args.todayYear,
      todayMonthIndex: args.todayMonthIndex,
    };
  }
  return {
    atHorizonTodayDollars: result.atHorizonTodayDollars,
    ssStartYear: ctx.ssStartYear,
    retirementYear: ctx.primaryRetirementYear,
    horizonYear: ctx.horizonYear,
    ctx: ctx.projCtx,
    methodAvailable: ctx.methodAvailable,
    accountYears,
    drawdownYears: buildDrawdownYearRows(result.years),
    withdrawalEvents: buildWithdrawalEvents(result.years),
    monthlyCashflowSeries,
    lifeExpectancyMarkers: buildLifeExpectancyMarkers(ctx),
    retirementMarkers: buildRetirementMarkersFromCtx(ctx),
    cbpResolution: ctx.cbpValidation,
    todayYear: args.todayYear,
    todayMonthIndex: args.todayMonthIndex,
  };
}
