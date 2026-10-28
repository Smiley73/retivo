/**
 * What the analysis tools share: which scenario a call means, the deterministic
 * run behind the Balance Projection page (the same assembly and runner the page
 * calls, through `lib/`), the headline numbers read off it the way the app
 * reads them, and the dollar rounding every computed figure goes through.
 *
 * The share view governs what is *said*, not what is computed: a run uses the
 * whole workspace, and a dollar figure leaves here already rounded to the
 * person's choice (the envelope walk sanitizes strings, not numbers).
 */
import type { ProjectionMethod } from '@retirement/assistant-protocol';
import { runBalanceProjectionForPage } from '../../lib/balance-projection-runner';
import type { PageDrawdownMethodResult, RunBalanceProjectionPageResult } from '../../lib/balance-projection-runner';
import { assemblePageProjection, type PageProjectionAssembly } from '../../lib/page-projection-args';
import { realDeflatorAt } from '../../lib/projection-context';
import { applyRounding } from '../sharing/rounding';
import { ANALYSIS_REQUIRED_SWITCH_IDS, ANALYSIS_TOOLS_STATEMENT, type SharingSwitchId } from '../sharing/switches';
import { PROJECTION_UNAVAILABLE_MESSAGE, ToolArgsError, ToolFailure, type ToolEnv } from './define';

/** The scenario a call names, or the base scenario when it names none. */
export function resolveScenarioArg(raw: unknown, env: ToolEnv): string {
  const { scenarios } = env.workspace;
  if (typeof raw === 'string') {
    if (!scenarios.some((scenario) => scenario.id === raw)) {
      throw new ToolArgsError('No scenario has that id. Use an id from retivo_list_scenarios.');
    }
    return raw;
  }
  const base = scenarios.find((scenario) => scenario.payload.isPrimary === true);
  if (base === undefined) throw new ToolArgsError('The plan has no base scenario. Pass a scenarioId from retivo_list_scenarios.');
  return base.id;
}

/**
 * The answer that replaces every computed figure when a switch the analysis draws on is off, or `null` when the tool may
 * run. The engines use the whole workspace, so a figure cannot be attributed to one category: the answer is none.
 * Scenarios is needed when a named scenario is not the base one, or always with `scenariosRequired`.
 */
export function analysisRefusal(env: ToolEnv, scenarioIds: readonly string[], scenariosRequired = false): { data: Record<string, unknown> } | null {
  const namesNonBase = scenarioIds.some((id) => env.workspace.scenarios.find((scenario) => scenario.id === id)?.payload.isPrimary !== true);
  const required: readonly SharingSwitchId[] = [...ANALYSIS_REQUIRED_SWITCH_IDS, ...(scenariosRequired || namesNonBase ? (['scenarios'] as const) : [])];
  const off = required.filter((id) => !env.choices[id]);
  return off.length === 0 ? null : { data: { omittedSections: off, statement: ANALYSIS_TOOLS_STATEMENT } };
}

/** Rounds one dollar figure to the person's choice: exact as computed, or to the nearest $1,000. */
export function dollarsFor(env: ToolEnv): (value: number | null | undefined) => number | null {
  return (value) => (value === null || value === undefined ? null : applyRounding(value, env.choices.exactDollars));
}

export interface PlanRun {
  scenarioId: string;
  assembly: PageProjectionAssembly;
  /** `null` when the page's own gate refuses to run (no primary retirement, no active account). */
  pageResult: RunBalanceProjectionPageResult | null;
}

/** Resolves `scenarioId` and assembles the arguments the page's projection runs on, without running it. */
export function assemblePlan(scenarioId: string, env: ToolEnv): PageProjectionAssembly {
  const { workspace, now } = env;
  return assemblePageProjection({
    scenarios: workspace.scenarios,
    selectedScenarioId: scenarioId,
    members: workspace.members,
    accounts: workspace.accounts,
    balances: workspace.balances,
    expenses: workspace.expenses,
    incomeStreams: workspace.incomeStreams,
    ssBenefits: workspace.ssBenefits,
    categories: workspace.categories,
    todayYear: now.getFullYear(),
    todayMonthIndex: now.getMonth(),
  });
}

/** Runs the deterministic projection the page runs, for `scenarioId`, on the tab's clock. */
export function runPlan(scenarioId: string, env: ToolEnv): PlanRun {
  const assembly = assemblePlan(scenarioId, env);
  return { scenarioId, assembly, pageResult: assembly.canRun ? runBalanceProjectionForPage(assembly.args) : null };
}

/** Whether the runner short-circuited because a cash balance plan account has no payout election, so no slice was projected. */
function cbpUnconfigured(pageResult: RunBalanceProjectionPageResult): boolean {
  const { cbpResolution } = pageResult.sharedCtx;
  return cbpResolution !== null && cbpResolution !== undefined && !cbpResolution.ok;
}

/**
 * Whether the run produced a Planned projection. A non-null page result is not enough: with a cash balance plan
 * account that has no payout election the runner returns a result whose `planned` is `null`.
 */
export function hasPlannedProjection(pageResult: RunBalanceProjectionPageResult | null): pageResult is RunBalanceProjectionPageResult {
  return pageResult !== null && !cbpUnconfigured(pageResult) && pageResult.planned !== null;
}

/** The run, or the failure the page would explain with an empty state. */
export function requirePageResult(run: PlanRun): RunBalanceProjectionPageResult {
  if (run.pageResult === null) throw new ToolFailure('INVALID_ARGS', PROJECTION_UNAVAILABLE_MESSAGE);
  if (cbpUnconfigured(run.pageResult)) {
    throw new ToolFailure(
      'INVALID_ARGS',
      'This scenario cannot be projected until the payout election on its cash balance plan account is set in Retivo.',
    );
  }
  return run.pageResult;
}

/** The slice for `method`, or the failure for a run that produced none. */
export function requireMethodSlice(pageResult: RunBalanceProjectionPageResult, method: ProjectionMethod): PageDrawdownMethodResult {
  const slice = methodSlice(pageResult, method);
  if (slice === null) {
    throw new ToolFailure('INVALID_ARGS', 'The projection could not be completed for this scenario. Check its withdrawal and income settings in Retivo.');
  }
  return slice;
}

export function methodSlice(
  pageResult: RunBalanceProjectionPageResult | null,
  method: ProjectionMethod,
): PageDrawdownMethodResult | null {
  if (pageResult === null) return null;
  return method === 'planned' ? pageResult.planned : pageResult.twr;
}

export interface Headline {
  horizonYear: number | null;
  retirementYear: number | null;
  /** The last year's balance in today's dollars; `null` when the method has no rows (see `deriveScenarioDeterministicMetrics`). */
  endingBalanceTodayDollars: number | null;
  /** The year withdrawals first fall short; `null` when the money lasts the horizon. */
  runOutYear: number | null;
  /** Nominal, at the retirement boundary. */
  portfolioAtRetirementNominal: number | null;
  portfolioAtRetirementTodayDollars: number | null;
}

/**
 * The headline numbers for one method. The ending balance is `null` when the slice is
 * missing or has no rows: a non-null slice with `years: []` (reachable when the horizon is
 * not after retirement) still carries a synthetic `atHorizonTodayDollars`, which the page and
 * the Scenarios cards suppress, so this does too.
 */
export function headlineOf(pageResult: RunBalanceProjectionPageResult | null, method: ProjectionMethod): Headline {
  const slice = methodSlice(pageResult, method);
  const hasRows = slice !== null && slice.years.length > 0;
  const ctx = pageResult?.sharedCtx;
  const atRetirement = slice === null ? null : slice.netPortfolioAtRetirement;
  return {
    horizonYear: ctx?.horizonYear ?? null,
    retirementYear: ctx?.retirementYear ?? null,
    endingBalanceTodayDollars: hasRows ? slice.atHorizonTodayDollars : null,
    runOutYear: slice === null ? null : slice.depletionYear,
    portfolioAtRetirementNominal: atRetirement,
    portfolioAtRetirementTodayDollars:
      atRetirement === null || ctx === undefined ? null : atRetirement * realDeflatorAt(ctx.ctx, ctx.retirementYear, 11),
  };
}
