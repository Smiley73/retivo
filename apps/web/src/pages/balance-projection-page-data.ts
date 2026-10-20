/**
 * Balance Projection page — per-scenario data load adapter over the
 * shared projection runner. `loadPageData` calls
 * `runBalanceProjectionForPage` once and maps the runner's method-agnostic
 * `sharedCtx.accountProjections` into the page's `BreakdownAccountRow` set
 * (chart + breakdown table) plus the per-method drawdown slices the page
 * renders. The old page-local re-projection pipeline (its own per-account
 * `project()` loop + CBP lump-sum routing) is gone — the runner owns the
 * deterministic drawdown so the page and the stress-test / optimizer can't
 * silently disagree. The income/expense cashflow series is still
 * assembled page-side (`balance-projection-page-cashflow.ts`) — a
 * non-drawdown surface out of the migration.
 */
import {
  type AccountPayload,
  type Aggregate,
  type HouseholdMemberPayload,
  type ScenarioOverrides,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import {
  assemblePageProjection,
  type PageProjectionInputs,
} from '../lib/page-projection-args';
import {
  runBalanceProjectionForPage,
  type PageDrawdownMethodResult,
  type RunBalanceProjectionArgs,
  type RunBalanceProjectionPageResult,
} from '../lib/balance-projection-runner';
import type { AccountProjection } from '../lib/balance-projection-runner-types';
import type { DrawdownYear } from '../lib/drawdown-engine';
import type {
  McBasis,
  MonteCarloSummary,
  RepresentativeRun,
} from '../lib/monte-carlo';
export type { McBasis, RepresentativeRun } from '../lib/monte-carlo';
import type { ProjectionMethod } from '../components/ProjectionChart';
import type { BreakdownAccountRow } from './balance-projection-page-yearly';

export interface PipelineData {
  readonly scenarios: ScenarioAggregate[];
  readonly selectedScenarioId: string;
  readonly resolved: ScenarioOverrides;
  readonly members: Aggregate<HouseholdMemberPayload>[];
  readonly primaryMember: Aggregate<HouseholdMemberPayload> | null;
  readonly memberRetirementById: Map<string, string | null>;
  readonly rows: BreakdownAccountRow[];
  readonly accounts: Aggregate<AccountPayload>[];
  readonly hiddenInactiveCount: number;
  readonly hiddenZeroHistoryCount: number;
  /** True when ≥1 active account has at least one balance row with a non-zero
   *  balance. Drives the onboarding empty-state gate: a portfolio of only
   *  auto-$0-seed accounts still has `rows.length > 0` (the seeds project),
   *  so `data.rows.length === 0` is NOT the empty-state signal — this predicate
   *  is. A MIXED-treatment account whose money lives only in the split fields is
   *  correctly counted as real. */
  readonly hasAnyRealBalance: boolean;
  readonly primaryRetirementAbsMonth: number | null;
  /** Both-methods drawdown result from the shared runner. `null`
   *  when the runner could not build a primary-retirement context
   *  (no primary / unresolved retirement date). The page derives its
   *  per-method drawdown surfaces (chart, year-by-year, portfolio-flow,
   *  account-balance-stack, depletion markers) from this. */
  readonly pageResult: RunBalanceProjectionPageResult | null;
  /** Flag-derived medical category ids, computed once from the
   *  household's categories. Threaded to every `.categoryRates` consumer off
   *  this page data via `medicalCategoryIdSet(...)` so the +2pp default
   *  follows the `isMedical` flag. Absent (no category source) ⇒ the adapter
   *  falls back to `[cat-medical]` (legacy default). */
  readonly medicalCategoryIds?: ReadonlyArray<string>;
}

function memberDisplay(m: HouseholdMemberPayload): string {
  return m.firstName?.trim() || 'Member';
}

/**
 * Map a runner `AccountProjection` to the page's `BreakdownAccountRow`,
 * computing the two page-only presentation fields the runner doesn't
 * carry: the owner display name and the insufficient-history warning flag
 * (an active non-CBP account whose empirical TWR rate is `null`). The
 * flagged account is INCLUDED at its planned rate under the Historical view
 * — the flag drives disclosure, not exclusion.
 */
function toBreakdownRow(
  proj: AccountProjection,
  memberById: ReadonlyMap<string, Aggregate<HouseholdMemberPayload>>,
): BreakdownAccountRow {
  const account = proj.account;
  const ownerMember = memberById.get(account.payload.ownerId);
  const ownerDisplay =
    account.payload.ownershipType === 'JOINT'
      ? 'Joint'
      : ownerMember
        ? memberDisplay(ownerMember.payload)
        : '—';
  const isCbp = account.payload.type === 'RETIREMENT_CASH_BALANCE';
  const hasInsufficientHistory = !isCbp && proj.ratePctByMethod.twr === null;
  // The runner fills `outputs.twr` with the PLANNED
  // projection for a non-CBP account that lacks empirical TWR history. We
  // KEEP that planned-rate fallback (no longer null it back out) so the
  // account is included at its planned rate across ALL Historical surfaces —
  // the per-account row, the totals card, and the chart — rather than being
  // excluded (which silently disabled the whole Historical view when even
  // one account was empty / new). `hasInsufficientHistory` still flags the
  // account, now driving the disclosure note + ⚠ marker, not exclusion.
  return {
    account,
    ownerDisplay,
    ownerRetirementDate: proj.ownerRetirementDate,
    latestBalance: proj.latestBalance,
    outputs: proj.outputs,
    hasInsufficientHistory,
    ratePctByMethod: proj.ratePctByMethod,
    perMonthContribution: proj.perMonthContribution,
  };
}

/**
 * Run the shared projection once and map its `accountProjections` into the
 * page's sorted `BreakdownAccountRow` set. The runner needs a resolvable
 * primary retirement to build its context; when it can't (no primary /
 * unresolved retirement date / no active accounts) the page renders its own
 * empty-state guards, so this returns `{ pageResult: null, rows: [] }`.
 */
function runProjectionRows(opts: {
  readonly canRun: boolean;
  readonly args: RunBalanceProjectionArgs;
  readonly memberById: ReadonlyMap<string, Aggregate<HouseholdMemberPayload>>;
}): {
  readonly pageResult: RunBalanceProjectionPageResult | null;
  readonly rows: BreakdownAccountRow[];
} {
  if (!opts.canRun) return { pageResult: null, rows: [] };
  const pageResult = runBalanceProjectionForPage(opts.args);
  const rows = pageResult.sharedCtx.accountProjections.map((p) =>
    toBreakdownRow(p, opts.memberById),
  );
  rows.sort((a, b) =>
    a.account.payload.name.localeCompare(b.account.payload.name),
  );
  return { pageResult, rows };
}

/**
 * Per-scenario page data. Thin adapter over `runBalanceProjectionForPage`:
 * runs the shared projection once, maps the runner's `accountProjections`
 * into `BreakdownAccountRow`s, and surfaces the per-method drawdown slices
 * via `pageResult`. The hidden-account footer counts are page-side (cheap,
 * presentation-only) since the runner drops zero-history accounts entirely.
 */
export function loadPageData(opts: PageProjectionInputs): PipelineData {
  const { scenarios, selectedScenarioId, members, accounts } = opts;
  const assembly = assemblePageProjection(opts);
  const memberById = new Map(members.map((m) => [m.id, m]));
  const { pageResult, rows } = runProjectionRows({
    canRun: assembly.canRun,
    args: assembly.args,
    memberById,
  });

  return {
    medicalCategoryIds: assembly.medicalCategoryIds,
    scenarios: [...scenarios],
    selectedScenarioId,
    resolved: assembly.resolved,
    members: [...members],
    primaryMember: assembly.primaryMember,
    memberRetirementById: assembly.memberRetirementById,
    rows,
    accounts: [...accounts],
    hiddenInactiveCount: assembly.hiddenInactiveCount,
    hiddenZeroHistoryCount: assembly.hiddenZeroHistoryCount,
    hasAnyRealBalance: assembly.hasAnyRealBalance,
    primaryRetirementAbsMonth: assembly.primaryRetirementAbsMonth,
    pageResult,
  };
}

/** Per-method drawdown slice the page renders (chart, year-by-year,
 *  portfolio-flow, account-balance-stack). Sourced from the shared
 *  runner's `pageResult` — the page no longer simulates drawdown
 *  locally. `years` carries the raw `DrawdownYear` rows so every
 *  surface reads `accountBalances` / `growth` / bucket detail / `depleted`
 *  directly. */
export interface DrawdownByMethodResult {
  readonly years: ReadonlyArray<DrawdownYear>;
  readonly depletionYear: number | null;
  readonly perMonthWithdrawal: Float64Array;
  /** Per-calendar-year total working-years Roth conversion amount in INTEGER
   *  CENTS. Present on deterministic-method slices; absent on MC representative
   *  runs (pre-retirement amounts are baked into the MC opening Roth balance). */
  readonly preRetirementConversionCentsByYear?: ReadonlyMap<number, number>;
  /** `PageDrawdownMethodResult.netPortfolioAtRetirement`, carried through
   *  NOMINAL. Present on deterministic-method
   *  slices; absent on the MC-adapted slice `buildResolvedDrawdown` builds —
   *  that path has no such figure of its own (it reads the representative
   *  run's own balance instead, not an adjusted total). */
  readonly netPortfolioAtRetirement?: number;
}

/**
 * Project the runner's both-methods `pageResult` into the page's
 * `Record<ProjectionMethod, DrawdownByMethodResult | null>` shape the
 * chart / stats / yearly surfaces consume. Returns `null` when there is
 * no runner result (no primary-retirement context) or the CBP elections
 * are unconfigured (both methods `null`).
 */
export function drawdownByMethodFromPageResult(
  pageResult: RunBalanceProjectionPageResult | null,
): Record<ProjectionMethod, DrawdownByMethodResult | null> | null {
  if (!pageResult) return null;
  const { planned, twr, sharedCtx } = pageResult;
  if (sharedCtx.cbpResolution && !sharedCtx.cbpResolution.ok) return null;
  const slice = (
    m: PageDrawdownMethodResult | null,
  ): DrawdownByMethodResult | null =>
    m
      ? {
          years: m.years,
          depletionYear: m.depletionYear,
          perMonthWithdrawal: m.perMonthWithdrawal,
          preRetirementConversionCentsByYear: sharedCtx.preRetirementConversionCentsByYear,
          netPortfolioAtRetirement: m.netPortfolioAtRetirement,
        }
      : null;
  return { planned: slice(planned), twr: slice(twr) };
}

/**
 * Surface the Monte Carlo summary's representative runs as a per-basis record.
 * Each `RepresentativeRun` carries `years` + `depletionYear` +
 * `perMonthWithdrawal` (full-horizon, indexed from the run's `firstYear`) PLUS
 * the path's own-CPI real per-year balance/growth. The view model
 * (`use-balance-projection-view-model.ts`) ADAPTS the active run before the
 * drawdown builders consume it: it slices `years` so the array is aligned from
 * `fromYear` (cashflow/retirement start), matching the `y - fromYear` indexing
 * the page's year-by-year / cashflow / portfolio-flow / tax-burden builders use
 * for the deterministic methods (this stays separate from the
 * `Record<ProjectionMethod, …>` drawdown map, which stays planned/twr only).
 *
 * The representative runs reach the page on `MonteCarloSummary` via the stress
 * VM's `result` — they are a Monte Carlo engine output, not a deterministic
 * runner output. Returns `null` when no result is present or the engine ran in
 * `successOnly` mode (the field is absent there).
 */
export function representativeByBasisFromSummary(
  summary: MonteCarloSummary | null,
): Record<McBasis, RepresentativeRun | null> | null {
  return summary?.representativeByBasis ?? null;
}
