/**
 * Cashflow-series builder for the BPP-equivalent helper. Produces the
 * per-month expense + income + deposit triples the drawdown engine
 * consumes — plus the targeted-one-off + post-primary-contribution
 * event lists the MC bundle re-anchors. Split out of
 * `balance-projection-runner.ts` (file shape limit).
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
  // Single expense projection (resolved expenses + context) feeds BOTH the
  // aggregate expense series AND the medical-demand sub-slice so the
  // latter is a strict subset of the former.
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
  // Every `isMedical` row: the cap on the credit applied to premiums.
  const medicalExpenseByMonth = buildMedicalDemandByMonth(
    args,
    ctx,
    resolvedExpenses,
    expenseCtx,
    expensesByMonth.values.length,
    isMedicalExpense,
  );
  // Does the plan model ANY medical spending? Read off the same
  // resolved expense projection, but WITHOUT the HSA-qualified filter.
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
  // Post-primary spouse contributions are NOT folded into the
  // household-pool deposit series — they route per-account (carrying their
  // pre/post split) via the per-account ledger. The household pool carries
  // only the one-off / pension-lump-sum `depositInflow`.
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
    // The FULL `isMedical` inventory, not the HSA-qualified subset
    // `medicalDemandByMonth` is filtered to.
    anyMedicalSpendingModeled,
  };
}

/** Build the post-retirement **plain** (non-linked-CBP) pension lump-sum
 *  placement events. Re-sources from the identity-preserving income producer
 *  (`collectPostRetirementPlainPensionPlacements`), NOT the household-pool
 *  `depositInflow` (which has already summed away the target + owner).
 *  Each event carries its target `accountId` (absolute `month`) so the
 *  per-account ledger + MC `routeEventsToLedger` place the dollars in the
 *  target account. One-off windfalls keep flowing through `depositInflow`
 *  (still household-spread). */
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
    // Absolute step month (`year*12 + month0`) — matches the post-primary /
    // one-off event convention; `reanchorEvents` rebases it for the MC bundle.
    month: ev.month0,
    amount: ev.amount,
    accountId: ev.accountId,
  }));
}

/** Build the resolved expense list + the fully-populated projection context
 *  (inflation category rates included) ONCE so the aggregate expense series and
 *  the medical-demand sub-slice project against identical inputs — the
 *  latter is then a strict subset of the former. */
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
  // Per-key resolver (not the generic resolveScenario) so per-category
  // rates (e.g. Medical = general + 2pp) thread into the deterministic
  // expense series the drawdown engine reads (faster Medical growth
  // raises withdrawals → MAGI → IRMAA/ACA/federal-tax automatically).
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

/**
 * Per-month medical demand in INTEGER CENTS for the rows `qualifies` admits:
 * the HSA-qualified subset for the HSA pass, every `isMedical` row for the cap
 * on the credit applied to premiums. Sums the
 * categories flagged `isMedical` (resolved via `medicalCategoryIdSet`) from the
 * SAME category-month projection that underlies `expensesByMonth`, applying the
 * identical `(recurring − spike)/12 + spike` monthly bucketing
 * `buildMonthlyExpenseSeries` uses — so the series is a STRICT SUBSET of the
 * aggregate expense series, month for month. Anchored at (retirementYear, Jan);
 * `length` matches `expensesByMonth.values`. No `isMedical` category ⇒ the
 * resolver's seeded `cat-medical` fallback (absent array) or an empty set
 * (explicit empty array) — an empty set yields all-zero. Cents are
 * rounded per month so the medical/emergency HSA split reconciles to the cent.
 */
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
  // Pre-filter to the admitted medical rows. The HSA subset uses the
  // SINGLE-SOURCE predicate (isHsaQualifiedMedical). Filtering before
  // projectExpensesByCategoryMonth preserves per-category rounding and the
  // strict-subset invariant. Absent hsaQualified ⇒ not qualified.
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
    // Same monthly bucketing as buildMonthlyExpenseSeries: the run-rate share
    // is /12, the one-off spike lands at full amount in its event month.
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
    // SEPARATE survivor claim ages — absent member keys stay absent so
    // the projection withholds survivor-dependent results.
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
    // Per-member SS so the hybrid-IRMAA split withholds each Medicare
    // member's surcharge only from that member's own benefit.
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
  // Reuse the CBP projections already computed in
  // buildPipelineContext instead of re-projecting per call.
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

/**
 * Per-member earned income (part-time wages) for the SSA earnings test.
 * Delegates to the shared `buildEarnedIncomeSeries` helper so the
 * runner and the Balance Projection page assemble IDENTICAL earnings-test
 * inputs.
 */
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
  // Start the series at the EARLIEST SS entitlement year (own or
  // survivor claim) when it precedes the primary retirement year — the SS
  // engine's earnings-test/ARF warm-up reads those pre-retirement years.
  // The spendable-income series keeps its own retirement-based range.
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
        // Summed `amount` kept for the no-ledger kernel path (byte-identical);
        // the per-account split routes by `amountPre`/`amountPost`.
        amount: perMonth,
        amountPre: pre,
        amountPost: post,
        accountId: proj.account.id,
      });
    }
  }
  return out;
}
