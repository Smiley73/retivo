/**
 * Shared BPP-equivalent full-projection helper. Routes per-scenario
 * inputs through the same library helpers Balance Projection routes
 * through — `resolveScenario` → CBP validation + election resolution →
 * targeted-deposit routing → per-account `project()` → expense / income
 * / deposit series builders → `simulateDrawdown`. Returns the at-horizon
 * Today's-dollar portfolio balance for the `planned` `ProjectionMethod`.
 *
 * Why pinned to `planned`:
 *  - The user-default BPP render is `twr` with `planned` as the fallback
 *    when TWR's 2-year history gate isn't met. The optimizer picks
 *    `planned` because it is **always available**, **deterministic
 *    across the candidate grid**, and `displayedTotals.planned` is one
 *    of the two methods BPP itself exposes — the optimizer metric stays
 *    explicitly comparable.
 *
 * CBP-unconfigured contract: the deterministic `runBalanceProjection`
 * returns with `cbpResolution.ok === false` on the result (does NOT
 * throw); only `runBalanceProjectionMc` throws `CbpUnconfiguredError`,
 * which the optimizer's per-candidate MC orchestrator catches.
 *
 * File split: context-building + per-account projection lives
 * in `balance-projection-runner-context.ts`; cashflow assembly lives in
 * `balance-projection-runner-cashflow.ts`; MC bundle assembly lives in
 * `balance-projection-runner-mc.ts`. This file is the public API +
 * orchestration only.
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
// `computePlannedAtHorizonToday` moved to `balance-projection-runner-result.ts`
// (pure shape transform); re-exported here so existing callers importing it
// from the runner keep working.
export { computePlannedAtHorizonToday } from './balance-projection-runner-result';

/**
 * Run the BPP-equivalent projection. Returns the full bundle BPP
 * consumes — at-horizon stat-card number, per-account / per-year
 * balances, drawdown rows, monthly cashflow series, marker arrays,
 * CBP validation. The optimizer reads only
 * `{ atHorizonTodayDollars, methodAvailable, … }` — those fields
 * carry forward unchanged on the full result.
 *
 * Phase order: CBP-validation → method-availability check →
 * projection. `cbpResolution` is unconditional on the result —
 * populated even when later phases short-circuit. The renderer
 * checks `cbpResolution?.ok === false` and short-circuits to the
 * remediation banner without inspecting any other field.
 */
export function runBalanceProjection(
  args: RunBalanceProjectionArgs,
): RunBalanceProjectionFullResult {
  const ctx = buildPipelineContext(args);
  if (!ctx) throw new NoPrimaryRetirementError();
  // CBP-unconfigured short-circuit. `cbpResolution` is set
  // unconditionally; downstream pipeline phases are skipped because
  // BPP renders the remediation banner from this field alone.
  if (ctx.cbpValidation && !ctx.cbpValidation.ok) {
    return buildEmptyFullResult(args, ctx);
  }
  // TWR-insufficient short-circuit. Historical method is unavailable
  // only in the degenerate case where ALL active non-CBP accounts lack
  // empirical TWR history (pure fallback with no empirical anchor). Per-account
  // planned-rate fallback accounts are projected at their planned rate instead
  // of vetoing the method. `cbpResolution` still surfaces (set
  // above to the validated-ok shape).
  if (!ctx.methodAvailable) {
    return buildEmptyFullResult(args, ctx);
  }
  return computeFullResult(args, ctx);
}

/**
 * MC input-builder entry point. Throws `CbpUnconfiguredError` when
 * the scenario has unconfigured CBP elections — the optimizer's
 * existing per-candidate hot path keeps catching this. BPP's
 * Plan Stress Test card checks `result.cbpResolution` from the
 * deterministic call upstream and skips this entry when invalid,
 * so the throw is unreachable from the BPP path.
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
    // Forward the live-advisory override when present.
    // The BPP / optimizer callers pass no `opts`, so the field is undefined and
    // the assembled bundle is unaffected.
    ...(opts?.guardrailOverrideConfig !== undefined
      ? { guardrailOverrideConfig: opts.guardrailOverrideConfig }
      : {}),
  });
  // Thread the SS run-rate rows so MC attributes each spouse's own
  // Social Security to their own return (parity with the deterministic engine's
  // `ownSsByMemberForYear`); inert for one-member / no-SS households.
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
 * Deterministic page entry. Runs the agnostic phase ONCE
 * (`buildPipelineContext` + `buildCashflowSeries`) and both methods
 * (Planned + TWR) off that shared work, returning
 * `{ planned, twr, sharedCtx }`. The Balance Projection page calls this
 * once per scenario instead of two `runBalanceProjection` calls, so the
 * setup is not duplicated per method.
 *
 * Unlike `runBalanceProjection` (fail-fast — re-throws
 * `MagiCapCalibrationError` / `MissingCustomDrawdownOrderError`), each
 * per-method drawdown is wrapped so a calibration / custom-order failure
 * on one method degrades that method to `null` and the page still renders
 * the other surfaces.
 *
 * CBP-unconfigured short-circuit returns `null` for both methods with a
 * populated `sharedCtx.cbpResolution` so the page renders the remediation
 * banner from that field alone (ordering invariant).
 */
export function runBalanceProjectionForPage(
  args: RunBalanceProjectionArgs,
): RunBalanceProjectionPageResult {
  const ctx = buildPipelineContext(args);
  if (!ctx) throw new NoPrimaryRetirementError();
  const series = buildCashflowSeries(args, ctx);
  // Re-derive TWR availability from the shared projection set (no
  // re-projection — single-phase). Historical is available ⟺ ≥1 non-CBP
  // account carries an empirical TWR rate; a single empty / short-history
  // account does not veto it (it falls back to its planned rate).
  // Only the degenerate all-fallback portfolio hides the toggle.
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
    // Planned is always available; TWR follows the re-derived predicate.
    methodAvailable: twrAvailable,
    // Surface the planned-rate fallback set so the page renders the
    // inline disclosure note (always present; `[]` when none fell back).
    fallbackAccounts: ctx.fallbackAccounts,
    preRetirementConversionCentsByYear: ctx.preRetirementConversionCentsByYear,
    todayYear: args.todayYear,
    todayMonthIndex: args.todayMonthIndex,
  };
  // CBP-unconfigured short-circuit — no drawdown for either method.
  if (ctx.cbpValidation && !ctx.cbpValidation.ok) {
    return { planned: null, twr: null, sharedCtx };
  }
  return {
    planned: runDrawdownForMethodSafe(args, ctx, series, 'planned'),
    // When TWR is unavailable, return the null sentinel — matching
    // `runBalanceProjection({ method: 'twr' })`'s empty short-circuit —
    // rather than a planned-fallback drawdown the renderer would mistake
    // for real TWR numbers.
    twr: twrAvailable ? runDrawdownForMethodSafe(args, ctx, series, 'twr') : null,
    sharedCtx,
  };
}

/**
 * Page wrapper over `runDrawdownForMethod` that swallows the per-method
 * recoverable failures (`MissingCustomDrawdownOrderError`,
 * `MagiCapCalibrationError`) so a single method's calibration gap doesn't
 * blank the whole page. Mirrors the prior page-local `buildDrawdownByMethod`
 * try/catch contract. Other errors propagate.
 */
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
