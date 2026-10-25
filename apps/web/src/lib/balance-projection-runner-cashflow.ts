/**
 * Cashflow-series builder: per-month expense, income and deposit series for the drawdown engine, plus the
 * one-off and post-primary-contribution events the MC bundle re-anchors.
 */
import {
  DEFAULT_INFLATION_PCT,
  DEFAULT_LIFE_EXPECTANCY_AGE,
} from '../db/types';
import { resolveExpensesForScenario } from './expense-resolution';
import { resolveIncomeForScenario } from './income-resolution';
import { resolveInflationForScenario } from './scenario-resolution';
import {
  isHsaQualifiedMedical,
  isMedicalExpense,
  medicalCategoryIdSet,
} from './expense-category-resolvers';
import {
  buildExpenseProjectionContext,
  projectExpensesByCategoryMonth,
  projectExpensesByMonth,
  type ProjectionContext,
} from './expense-projection';
import type { ResolvedExpense } from './expense-resolution';
import {
  buildIncomeContext,
  collectPostRetirementPlainPensionPlacements,
  projectIncomeByMonth,
} from './income-projection';
import { buildSsContext, projectSsByMonth, resolveSsColaPct } from './ss-projection';
import {
  buildEarnedIncomeSeries,
  earliestSsEntitlementYear,
  type EarnedIncomeSeries,
} from './earned-income-series';
import {
  buildMonthlyExpenseSeries,
  buildMonthlyIncomeSeries,
  buildMonthlyDepositSeries,
  type ClassifiedDepositEvent,
  type MonthlyExpenseRow,
  type MonthlyIncomeRow,
} from './balance-projection-bundle';
import type {
  CashflowSeries,
  PipelineContext,
  RunBalanceProjectionArgs,
  SsRunRateRow,
} from './balance-projection-runner-types';
import {
  buildMemberRetirementMap,
  makeCbpBalanceLookup,
} from './balance-projection-runner-context';

export function buildCashflowSeries(
  args: RunBalanceProjectionArgs,
  ctx: PipelineContext,
): CashflowSeries {
  // One expense projection feeds both the aggregate series and the medical-demand sub-slice, so the latter is
  // a subset of the former.
  const { resolved: resolvedExpenses, ctx: expenseCtx } = buildExpenseProjection(args, ctx);
  const expenseRows = buildExpenseRowsFrom(resolvedExpenses, expenseCtx, ctx);
  const expensesByMonth = buildMonthlyExpenseSeries({
    rows: expenseRows,
    retirementYear: ctx.primaryRetirementYear,
    horizonYear: ctx.horizonYear,
  });
  const medicalDemandByMonth = buildMedicalDemandByMonth(
    args,
    ctx,
    resolvedExpenses,
    expenseCtx,
    expensesByMonth.values.length,
    isHsaQualifiedMedical,
  );
  const medicalExpenseByMonth = buildMedicalDemandByMonth(
    args,
    ctx,
    resolvedExpenses,
    expenseCtx,
    expensesByMonth.values.length,
    isMedicalExpense,
  );
  const allMedicalIds = medicalCategoryIdSet(args.medicalCategoryIds);
  const anyMedicalSpendingModeled = resolvedExpenses.some((e) =>
    allMedicalIds.has(e.payload.categoryId),
  );
  const ssRows = buildSsRows(args, ctx);
  const nonSsIncomeRows = buildNonSsIncomeRows(args, ctx);
  const incomeByMonth = buildMonthlyIncomeSeries({
    ssRows,
    incomeRows: nonSsIncomeRows,
    retirementYear: ctx.primaryRetirementYear,
    horizonYear: ctx.horizonYear,
  });
  const postPrimaryContributionEvents = buildPostPrimaryContributionEvents(ctx);
  const plainPensionPlacementEvents = buildPlainPensionPlacementEvents(args, ctx);
  // Post-primary spouse contributions route per-account through the ledger, not through the household-pool
  // deposit series.
  const depositsByMonth = buildMonthlyDepositSeries({
    incomeRows: nonSsIncomeRows,
    retirementYear: ctx.primaryRetirementYear,
    horizonYear: ctx.horizonYear,
    primaryRetirementAbsMonth: ctx.primaryRetirementAbsMonth,
  });
  const targetedOneOffEvents: ClassifiedDepositEvent[] = nonSsIncomeRows
    .filter(
      (r) =>
        r.depositInflow !== 0 &&
        r.year * 12 + r.month0 >= ctx.primaryRetirementAbsMonth,
    )
    .map((r) => ({
      month: r.year * 12 + r.month0,
      amount: r.depositInflow,
    }));
  return {
    expensesByMonth,
    incomeByMonth,
    depositsByMonth,
    expenseRows,
    nonSsIncomeRows,
    postPrimaryContributionEvents,
    targetedOneOffEvents,
    plainPensionPlacementEvents,
    ssRows,
    medicalDemandByMonth,
    medicalExpenseByMonth,
    anyMedicalSpendingModeled,
  };
}

// Sourced from the identity-preserving income producer; `depositInflow` has already summed away target and
// owner.
function buildPlainPensionPlacementEvents(
  args: RunBalanceProjectionArgs,
  ctx: PipelineContext,
): ClassifiedDepositEvent[] {
  if (args.incomeStreams.length === 0) return [];
  const resolvedIncome = resolveIncomeForScenario(
    args.scenarioId,
    [...ctx.effectiveScenarios],
    [...args.incomeStreams],
  );
  if (resolvedIncome.length === 0) return [];
  const retirementDateByMember = buildMemberRetirementMap(ctx.retirementByMember);
  const lifePrimary =
    ctx.resolvedScenario.lifeExpectancy?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE;
  const lifeSecondary = ctx.resolvedScenario.lifeExpectancy?.secondary;
  const cbpBalanceLookup = makeCbpBalanceLookup(
    ctx.cbpProjectionByAccount,
    ctx.primaryRetirementAbsMonth,
  );
  const incomeCtx = buildIncomeContext([...args.members], {
    retirementStartYear: ctx.primaryRetirementYear,
    lifeExpectancyPrimary: lifePrimary,
    lifeExpectancySecondary: lifeSecondary,
    retirementDateByMember,
    todayYear: args.todayYear,
    todayMonthIndex: args.todayMonthIndex,
    inflationPct: ctx.resolvedScenario.inflation?.ratePct ?? DEFAULT_INFLATION_PCT,
    linkedCbpBalanceLookup: cbpBalanceLookup,
  });
  return collectPostRetirementPlainPensionPlacements(
    resolvedIncome,
    { ...incomeCtx, retirementMonth0: ctx.primaryRetirementMonth0 },
    ctx.primaryRetirementAbsMonth,
  ).map((ev) => ({
    // Absolute step month (`year*12 + month0`); `reanchorEvents` rebases it for the MC bundle.
    month: ev.month0,
    amount: ev.amount,
    accountId: ev.accountId,
  }));
}

function buildExpenseProjection(
  args: RunBalanceProjectionArgs,
  ctx: PipelineContext,
): { resolved: ResolvedExpense[]; ctx: ProjectionContext } {
  const resolvedExpenses = resolveExpensesForScenario(
    args.scenarioId,
    [...ctx.effectiveScenarios],
    [...args.expenses],
  );
  const baseCtx = buildExpenseProjectionContext({
    resolved: {
      discretionarySpending: ctx.resolvedScenario.discretionarySpending,
      lifeExpectancy: ctx.resolvedScenario.lifeExpectancy,
    },
    primary: { birthdate: ctx.primary.payload.birthdate },
    secondary: ctx.secondary
      ? { birthdate: ctx.secondary.payload.birthdate }
      : null,
    primaryRetirementIso: ctx.primaryRetIso,
  });
  // Per-key resolver so per-category rates (e.g. Medical = general + 2pp) reach the expense series.
  const resolvedInflation = resolveInflationForScenario(
    args.scenarioId,
    [...ctx.effectiveScenarios],
    medicalCategoryIdSet(args.medicalCategoryIds),
  );
  const expenseCtx: ProjectionContext = {
    ...baseCtx,
    inflation: {
      ratePct: resolvedInflation.ratePct,
      categoryRates: resolvedInflation.categoryRates,
    },
    retirementMonth0: ctx.primaryRetirementMonth0,
  };
  return { resolved: resolvedExpenses, ctx: expenseCtx };
}

function buildExpenseRowsFrom(
  resolvedExpenses: ResolvedExpense[],
  expenseCtx: ProjectionContext,
  ctx: PipelineContext,
): MonthlyExpenseRow[] {
  const rows = projectExpensesByMonth(
    resolvedExpenses,
    expenseCtx,
    { from: ctx.primaryRetirementYear, to: ctx.horizonYear },
  );
  return rows.map((r) => ({
    year: r.year,
    month0: r.month0,
    total: r.total,
    oneOffEssential: r.oneOffEssential,
    oneOffDiscretionary: r.oneOffDiscretionary,
  }));
}

// Integer cents per month, `(recurring - spike)/12 + spike` as in `buildMonthlyExpenseSeries`; rounded per
// month so the HSA/emergency split reconciles to the cent.
function buildMedicalDemandByMonth(
  args: RunBalanceProjectionArgs,
  ctx: PipelineContext,
  resolvedExpenses: ResolvedExpense[],
  expenseCtx: ProjectionContext,
  length: number,
  qualifies: (expense: ResolvedExpense, medicalIds: ReadonlySet<string>) => boolean,
): number[] {
  const out = new Array<number>(length).fill(0);
  const medicalIds = medicalCategoryIdSet(args.medicalCategoryIds);
  if (medicalIds.size === 0) return out;
  const qualifiedExpenses = resolvedExpenses.filter((e) => qualifies(e, medicalIds));
  if (qualifiedExpenses.length === 0) return out;
  const points = projectExpensesByCategoryMonth(
    qualifiedExpenses,
    expenseCtx,
    { from: ctx.primaryRetirementYear, to: ctx.horizonYear },
  );
  const baseYear = ctx.primaryRetirementYear;
  for (const p of points) {
    const slot = (p.year - baseYear) * 12 + p.month0;
    if (slot < 0 || slot >= length) continue;
    let recurring = 0;
    let oneOff = 0;
    for (const id of medicalIds) {
      recurring += p.recurringByCategoryId[id] ?? 0;
      oneOff += p.oneOffByCategoryId[id] ?? 0;
    }
    const monthly = (recurring - oneOff) / 12 + oneOff;
    out[slot] = Math.round(monthly * 100);
  }
  return out;
}

function buildSsRows(
  args: RunBalanceProjectionArgs,
  ctx: PipelineContext,
): SsRunRateRow[] {
  const ss = ctx.resolvedScenario.socialSecurity;
  if (!ss) return [];
  const lifePrimary =
    ctx.resolvedScenario.lifeExpectancy?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE;
  const lifeSecondary = ctx.resolvedScenario.lifeExpectancy?.secondary;
  const inflationPct =
    ctx.resolvedScenario.inflation?.ratePct ?? DEFAULT_INFLATION_PCT;
  const earned = buildEarnedIncomeByMemberYear(args, ctx);
  const ssCtx = buildSsContext([...args.members], [...args.ssBenefits], {
    claimAgePrimary: ss.primary,
    claimAgeSecondary: ss.secondary,
    survivorClaimAgePrimary: ss.survivor?.primary,
    survivorClaimAgeSecondary: ss.survivor?.secondary,
    lifeExpectancyPrimary: lifePrimary,
    lifeExpectancySecondary: lifeSecondary,
    colaPct: resolveSsColaPct(ss, inflationPct),
    benefitReductionPct: ss.benefitReductionPct ?? 0,
    earnedIncomeByMemberYear: earned?.annualByMember,
    earnedIncomeMonthlyByMemberYear: earned?.monthlyByMember,
    earningsTestInflationRatePct: inflationPct,
  });
  if (!ssCtx) return [];
  return projectSsByMonth(ssCtx, {
    from: ctx.primaryRetirementYear,
    to: ctx.horizonYear,
  }).map((m) => ({
    year: m.year,
    month0: m.month0,
    total: m.total,
    primary: m.byMember.primary,
    ...(m.byMember.secondary !== undefined ? { secondary: m.byMember.secondary } : {}),
  }));
}

function buildNonSsIncomeRows(
  args: RunBalanceProjectionArgs,
  ctx: PipelineContext,
): MonthlyIncomeRow[] {
  if (args.incomeStreams.length === 0) return [];
  const resolvedIncome = resolveIncomeForScenario(
    args.scenarioId,
    [...ctx.effectiveScenarios],
    [...args.incomeStreams],
  );
  if (resolvedIncome.length === 0) return [];
  const retirementDateByMember = buildMemberRetirementMap(ctx.retirementByMember);
  const lifePrimary =
    ctx.resolvedScenario.lifeExpectancy?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE;
  const lifeSecondary = ctx.resolvedScenario.lifeExpectancy?.secondary;
  const todayYear = args.todayYear;
  const todayMonthIndex = args.todayMonthIndex;
  const cbpBalanceLookup = makeCbpBalanceLookup(
    ctx.cbpProjectionByAccount,
    ctx.primaryRetirementAbsMonth,
  );
  const incomeCtx = buildIncomeContext([...args.members], {
    retirementStartYear: ctx.primaryRetirementYear,
    lifeExpectancyPrimary: lifePrimary,
    lifeExpectancySecondary: lifeSecondary,
    retirementDateByMember,
    todayYear,
    todayMonthIndex,
    inflationPct:
      ctx.resolvedScenario.inflation?.ratePct ?? DEFAULT_INFLATION_PCT,
    linkedCbpBalanceLookup: cbpBalanceLookup,
  });
  return projectIncomeByMonth(
    resolvedIncome,
    { ...incomeCtx, retirementMonth0: ctx.primaryRetirementMonth0 },
    { from: ctx.primaryRetirementYear, to: ctx.horizonYear },
  ).map((r) => ({
    year: r.year,
    month0: r.month0,
    pensionIncome: r.pensionIncome,
    partTimeIncome: r.partTimeIncome,
    oneOffIncome: r.oneOffIncome,
    depositInflow: r.depositInflow,
  }));
}

function buildEarnedIncomeByMemberYear(
  args: RunBalanceProjectionArgs,
  ctx: PipelineContext,
): EarnedIncomeSeries | undefined {
  if (args.incomeStreams.length === 0) return undefined;
  const resolvedIncome = resolveIncomeForScenario(
    args.scenarioId,
    [...ctx.effectiveScenarios],
    [...args.incomeStreams],
  );
  const retirementDateByMember = buildMemberRetirementMap(ctx.retirementByMember);
  const lifePrimary =
    ctx.resolvedScenario.lifeExpectancy?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE;
  const lifeSecondary = ctx.resolvedScenario.lifeExpectancy?.secondary;
  const cbpBalanceLookup = makeCbpBalanceLookup(
    ctx.cbpProjectionByAccount,
    ctx.primaryRetirementAbsMonth,
  );
  const incomeCtx = buildIncomeContext([...args.members], {
    retirementStartYear: ctx.primaryRetirementYear,
    lifeExpectancyPrimary: lifePrimary,
    lifeExpectancySecondary: lifeSecondary,
    retirementDateByMember,
    todayYear: args.todayYear,
    todayMonthIndex: args.todayMonthIndex,
    inflationPct: ctx.resolvedScenario.inflation?.ratePct ?? DEFAULT_INFLATION_PCT,
    linkedCbpBalanceLookup: cbpBalanceLookup,
  });
  // Starts at the earliest SS entitlement year (own or survivor claim): the earnings-test warm-up reads
  // pre-retirement years.
  const earliestEntitlement = earliestSsEntitlementYear(
    [...args.members],
    ctx.resolvedScenario.socialSecurity,
  );
  return buildEarnedIncomeSeries(
    resolvedIncome,
    { ...incomeCtx, retirementMonth0: ctx.primaryRetirementMonth0 },
    {
      from: Math.min(
        ctx.primaryRetirementYear,
        earliestEntitlement ?? ctx.primaryRetirementYear,
      ),
      to: ctx.horizonYear,
    },
  );
}

function buildPostPrimaryContributionEvents(
  ctx: PipelineContext,
): ClassifiedDepositEvent[] {
  const out: ClassifiedDepositEvent[] = [];
  const primaryAbs = ctx.primaryRetirementAbsMonth;
  for (const proj of ctx.accountProjections) {
    if (proj.account.payload.ownershipType === 'JOINT') continue;
    const ownerIso = proj.ownerRetirementDate;
    if (!ownerIso) continue;
    const ownerY = Number(ownerIso.slice(0, 4));
    const ownerM = Number(ownerIso.slice(5, 7)) - 1;
    if (!Number.isFinite(ownerY) || !Number.isFinite(ownerM)) continue;
    const ownerAbs = ownerY * 12 + ownerM;
    if (ownerAbs <= primaryAbs) continue;
    const pre = proj.perMonthContribution.preTax;
    const post = proj.perMonthContribution.postTax;
    const perMonth = pre + post;
    if (perMonth === 0) continue;
    for (let abs = primaryAbs; abs < ownerAbs; abs += 1) {
      out.push({
        month: abs,
        amount: perMonth,
        amountPre: pre,
        amountPost: post,
        accountId: proj.account.id,
      });
    }
  }
  return out;
}
