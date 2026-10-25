/** Per-scenario data load adapter: runs the shared projection runner once and maps its account projections and per-method drawdown slices into the page's rows. */
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
  /** True when ≥1 active account has a non-zero balance row; the empty-state gate, since auto-$0 seed accounts still project and make rows.length > 0. */
  readonly hasAnyRealBalance: boolean;
  readonly primaryRetirementAbsMonth: number | null;
  /** Null when the runner could not build a primary-retirement context. */
  readonly pageResult: RunBalanceProjectionPageResult | null;
  /** Medical category ids from the isMedical flag; absent falls back to [cat-medical]. */
  readonly medicalCategoryIds?: ReadonlyArray<string>;
}

function memberDisplay(m: HouseholdMemberPayload): string {
  return m.firstName?.trim() || 'Member';
}

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
  // Keep the planned-rate fallback for an account without empirical TWR history so it is included across all Historical surfaces; hasInsufficientHistory drives the disclosure, not exclusion.
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

/** Per-method drawdown slice; `years` carries the raw DrawdownYear rows. */
export interface DrawdownByMethodResult {
  readonly years: ReadonlyArray<DrawdownYear>;
  readonly depletionYear: number | null;
  readonly perMonthWithdrawal: Float64Array;
  /** Integer cents; absent on MC representative runs (their opening Roth balance already includes pre-retirement amounts). */
  readonly preRetirementConversionCentsByYear?: ReadonlyMap<number, number>;
  /** Nominal; absent on the MC-adapted slice, which reads the run's own balance instead. */
  readonly netPortfolioAtRetirement?: number;
}

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

/** Surfaces the MC summary's representative runs per basis; null when there is no result or the engine ran in successOnly mode. The view model adapts the active run so years align from fromYear. */
export function representativeByBasisFromSummary(
  summary: MonteCarloSummary | null,
): Record<McBasis, RepresentativeRun | null> | null {
  return summary?.representativeByBasis ?? null;
}
