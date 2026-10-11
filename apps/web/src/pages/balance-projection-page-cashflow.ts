/**
 * Balance Projection page — per-scenario cashflow series assembly.
 * Builds the income / expense / deposit monthly + yearly series the
 * drawdown engine + the income / expense / portfolio-flow charts
 * consume. Extracted from `balance-projection-page-pipeline.ts`
 * to keep individual pipeline files under the 400-ln file shape cap.
 *
 * `buildPageCashflowSeries` itself remains > 40 ln: splitting it further risks
 * behavior changes that the parity gate can't regression-test today.
 */
import {
  DEFAULT_INFLATION_PCT,
  DEFAULT_LIFE_EXPECTANCY_AGE,
  type Aggregate,
  type ExpensePayload,
  type IncomeStreamPayload,
  type SocialSecurityBenefitPayload,
} from '../db/types';
import {
  resolveExpensesForScenario,
} from '../lib/expense-resolution';
import {
  projectExpensesByCategoryMonth,
  projectExpensesByCategoryYear,
  projectExpensesByMonth,
  projectExpensesByYear,
} from '../lib/expense-projection';
import { buildBalanceExpenseContext } from '../lib/balance-projection-context';
import { resolveInflationForScenario } from '../lib/scenario-resolution';
import { medicalCategoryIdSet } from '../lib/expense-category-resolvers';
import { resolveIncomeForScenario } from '../lib/income-resolution';
import {
  buildIncomeContext,
  projectIncomeByMonth,
  projectIncomeByYear,
} from '../lib/income-projection';
import {
  buildSsContext,
  projectSsByMonth,
  projectSsByYear,
  resolveSsColaPct,
} from '../lib/ss-projection';
import {
  buildEarnedIncomeSeries,
  earliestSsEntitlementYear,
} from '../lib/earned-income-series';
import {
  addOneOff,
  emptyMonthlySeries,
  type MonthlyCashflowSeries,
} from '../lib/monthly-cashflow';
import {
  buildMonthlyExpenseSeries,
  buildMonthlyIncomeSeries,
} from '../lib/balance-projection-bundle';
import type { PipelineData } from './balance-projection-page-data';

const PROJECTION_CHART_TAIL_YEARS = 0;

/** 0-indexed month from an ISO `YYYY-MM-DD` (Jan = 0). */
function parseIsoMonth0(iso: string): number | null {
  const match = /^\d{4}-(\d{2})/.exec(iso);
  if (!match) return null;
  const m = Number(match[1]);
  if (m < 1 || m > 12) return null;
  return m - 1;
}

export interface CashflowSeriesPipelineResult {
  readonly fromYear: number;
  readonly chartEndYear: number;
  readonly drawdownEndYear: number;
  readonly incomeByYear: Map<number, number>;
  readonly expensesByYear: Map<number, number>;
  readonly depositsByYear: Map<number, number>;
  readonly expensesByMonth: MonthlyCashflowSeries;
  readonly incomeByMonth: MonthlyCashflowSeries;
  readonly depositsByMonth: MonthlyCashflowSeries;
  readonly sourceSplitByYear: Map<
    number,
    { ss: number; pensionAnnuity: number; partTime: number; oneOff: number }
  >;
  readonly extendedExpenseRows: ReturnType<typeof projectExpensesByYear>;
  readonly monthlySeries: {
    readonly ssMonths: ReturnType<typeof projectSsByMonth>;
    readonly incomeMonths: ReturnType<typeof projectIncomeByMonth>;
    readonly expenseMonths: ReturnType<typeof projectExpensesByMonth>;
  };
  /**
   * Band-basis per-category expense projections for the cashflow "by
   * category" mode. Id-keyed + name-agnostic (the builder never
   * sees category names). Two inflation bases:
   *   - `*Nominal` — scenario-rate inflation (per-category, incl. Medical
   *     +2pp). Drives Future-dollars shares AND the display-basis-
   *     independent **active-set** signal (a category is active iff
   *     it has any non-zero nominal contribution in range).
   *   - `*Base` — inflation pinned to 0% (real/today's dollars), the
   *     Expenses-page mechanism. Drives Today's-dollars shares.
   * Only the share RATIOS are consumed downstream (the residual allocation
   * rescales to the displayed essential+discretionary), so neither set is
   * deflated here.
   */
  readonly categoryMonthlyNominal: ReturnType<typeof projectExpensesByCategoryMonth>;
  readonly categoryYearlyNominal: ReturnType<typeof projectExpensesByCategoryYear>;
  readonly categoryMonthlyBase: ReturnType<typeof projectExpensesByCategoryMonth>;
  readonly categoryYearlyBase: ReturnType<typeof projectExpensesByCategoryYear>;
  readonly primaryAbsMonth: number;
  readonly targetedOneOffEvents: ReadonlyArray<{
    readonly month: number;
    readonly amount: number;
  }>;
  readonly postPrimaryContributionEvents: ReadonlyArray<{
    readonly month: number;
    readonly amount: number;
  }>;
}

export function buildPageCashflowSeries(opts: {
  readonly data: PipelineData;
  readonly selectedScenarioId: string;
  readonly canonicalIncome: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  readonly canonicalExpenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  readonly cashflowChartEndYear: number;
  readonly lastDeathYear: number | null;
  readonly primaryRetirementYear: number | null;
  readonly primaryRetirementFractional: number | null;
  readonly nowYear: number;
  readonly nowMonthIndex: number;
}): CashflowSeriesPipelineResult | null {
  const {
    data,
    selectedScenarioId,
    canonicalIncome,
    canonicalExpenses,
    ssBenefits,
    cashflowChartEndYear,
    lastDeathYear,
    primaryRetirementYear,
    nowYear,
    nowMonthIndex,
  } = opts;
  const retirementYear =
    primaryRetirementYear ??
    (data.primaryMember
      ? new Date(
          data.memberRetirementById.get(data.primaryMember.id) ?? '',
        ).getUTCFullYear()
      : NaN);
  if (!Number.isFinite(retirementYear)) return null;
  const fromYear = retirementYear;
  const chartEndYear = cashflowChartEndYear;
  // `lastDeathYear` is now the integer death year (death = Dec 31 of
  // `deathYear`, the terminal year), so the cashflow projection ends
  // at `deathYear` (tail = 0).
  const drawdownEndYear =
    lastDeathYear !== null
      ? lastDeathYear + PROJECTION_CHART_TAIL_YEARS
      : chartEndYear;

  const claimAgePrimary =
    data.resolved.socialSecurity?.primary ?? { ageYears: 67, ageMonths: 0 };
  const claimAgeSecondary = data.resolved.socialSecurity?.secondary;
  const lifePrimary =
    data.resolved.lifeExpectancy?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE;
  const lifeSecondary = data.resolved.lifeExpectancy?.secondary;
  const colaPct = resolveSsColaPct(
    data.resolved.socialSecurity,
    data.resolved.inflation?.ratePct ?? DEFAULT_INFLATION_PCT,
  );
  const benefitReductionPct =
    data.resolved.socialSecurity?.benefitReductionPct ?? 0;

  const resolvedIncome = resolveIncomeForScenario(
    selectedScenarioId,
    data.scenarios,
    [...canonicalIncome],
  );
  const retirementDateByMember = new Map<
    string,
    { year: number; month0?: number }
  >();
  data.memberRetirementById.forEach((iso, memberId) => {
    if (!iso) return;
    const y = Number(iso.slice(0, 4));
    const m = Number(iso.slice(5, 7));
    if (!Number.isFinite(y)) return;
    retirementDateByMember.set(memberId, {
      year: y,
      month0: Number.isFinite(m) && m >= 1 && m <= 12 ? m - 1 : undefined,
    });
  });
  const cbpBalanceAt = (
    cbpAccountId: string,
    year: number,
    month0: number,
  ): number | null => {
    const row = data.rows.find((r) => r.account.id === cbpAccountId);
    const perStep = row?.outputs.planned?.perStep;
    if (!perStep) return null;
    const primaryAbs = data.primaryRetirementAbsMonth;
    if (primaryAbs !== null && year * 12 + month0 >= primaryAbs) return null;
    const stepIdx = (year - perStep.firstYear) * 12 + month0;
    if (stepIdx < 0 || stepIdx >= perStep.preEnd.length) return null;
    const readIdx = stepIdx === 0 ? 0 : stepIdx - 1;
    return perStep.preEnd[readIdx] + perStep.postEnd[readIdx];
  };
  const incomeCtx = buildIncomeContext(data.members, {
    retirementStartYear: fromYear,
    lifeExpectancyPrimary: lifePrimary,
    lifeExpectancySecondary: lifeSecondary,
    retirementDateByMember,
    todayYear: nowYear,
    todayMonthIndex: nowMonthIndex,
    inflationPct: data.resolved.inflation?.ratePct ?? DEFAULT_INFLATION_PCT,
    linkedCbpBalanceLookup: cbpBalanceAt,
  });
  const incomeYears = projectIncomeByYear(resolvedIncome, incomeCtx, {
    from: fromYear,
    to: drawdownEndYear,
  });
  const primaryRetirementIsoForMonth = data.primaryMember
    ? data.memberRetirementById.get(data.primaryMember.id) ?? null
    : null;
  const retirementMonth0 = primaryRetirementIsoForMonth
    ? parseIsoMonth0(primaryRetirementIsoForMonth)
    : 0;
  const incomeMonths = projectIncomeByMonth(
    resolvedIncome,
    { ...incomeCtx, retirementMonth0: retirementMonth0 ?? 0 },
    { from: fromYear, to: drawdownEndYear },
  );

  // The SAME shared earned-income series the drawdown runner feeds
  // the earnings test — the page previously built its SS context without
  // earnings-test inputs, so its chart/table disagreed with the runner for
  // pre-FRA part-time-wage scenarios. It also starts at the EARLIEST SS
  // entitlement year (own or survivor claim) when it precedes retirement so
  // the engine's earnings-test/ARF warm-up sees those years — same widening
  // as the runner; the spendable-income series keeps its own range.
  const earliestEntitlement = earliestSsEntitlementYear(
    data.members,
    data.resolved.socialSecurity,
  );
  const earned = buildEarnedIncomeSeries(
    resolvedIncome,
    { ...incomeCtx, retirementMonth0: retirementMonth0 ?? 0 },
    {
      from: Math.min(fromYear, earliestEntitlement ?? fromYear),
      to: drawdownEndYear,
    },
  );
  const ssCtx = buildSsContext(data.members, [...ssBenefits], {
    claimAgePrimary,
    claimAgeSecondary,
    // SEPARATE survivor claim ages — absent → the engine withholds
    // survivor-dependent results, same as the drawdown runner.
    survivorClaimAgePrimary: data.resolved.socialSecurity?.survivor?.primary,
    survivorClaimAgeSecondary: data.resolved.socialSecurity?.survivor?.secondary,
    lifeExpectancyPrimary: lifePrimary,
    lifeExpectancySecondary: lifeSecondary,
    colaPct,
    benefitReductionPct,
    earnedIncomeByMemberYear: earned?.annualByMember,
    earnedIncomeMonthlyByMemberYear: earned?.monthlyByMember,
    earningsTestInflationRatePct:
      data.resolved.inflation?.ratePct ?? DEFAULT_INFLATION_PCT,
  });
  const ssYears = ssCtx
    ? projectSsByYear(ssCtx, { from: fromYear, to: drawdownEndYear })
    : [];
  const ssMonths = ssCtx
    ? projectSsByMonth(ssCtx, { from: fromYear, to: drawdownEndYear })
    : [];

  const secondary = data.members.find((m) => !m.payload.isPrimary);
  // Per-key resolver so the page's expense band reflects per-category
  // inflation (Medical = general + 2pp by default), matching the runner.
  const resolvedInflation = resolveInflationForScenario(
    selectedScenarioId,
    data.scenarios,
    medicalCategoryIdSet(data.medicalCategoryIds),
  );
  const expenseCtx = buildBalanceExpenseContext({
    nowYear,
    nowMonthIndex,
    retirementYear: fromYear,
    primary: data.primaryMember?.payload,
    secondary: secondary?.payload,
    inflation: {
      ratePct: resolvedInflation.ratePct,
      categoryRates: resolvedInflation.categoryRates,
    },
    discretionarySpending: data.resolved.discretionarySpending,
    lifeExpectancy: data.resolved.lifeExpectancy,
  });
  const resolvedExpenses = resolveExpensesForScenario(
    selectedScenarioId,
    data.scenarios,
    [...canonicalExpenses],
  );
  const extendedExpenseRows = projectExpensesByYear(
    resolvedExpenses,
    expenseCtx,
    { from: fromYear, to: drawdownEndYear },
  );
  const expensesByYear = new Map<number, number>();
  for (const r of extendedExpenseRows) expensesByYear.set(r.year, r.total);
  const expenseMonths = projectExpensesByMonth(
    resolvedExpenses,
    { ...expenseCtx, retirementMonth0: retirementMonth0 ?? 0 },
    { from: fromYear, to: drawdownEndYear },
  );

  // Band-basis per-category projections for the cashflow "by category"
  // mode. Id-keyed; the builder is name-agnostic. The `Nominal`
  // pair uses the scenario per-category inflation (Future shares + the
  // active-set signal); the `Base` pair pins inflation to 0% (Today's
  // shares), the Expenses-page mechanism. Only ratios are consumed
  // downstream, so no deflator is applied here.
  const categoryRange = { from: fromYear, to: drawdownEndYear };
  const expenseCtxMonth = { ...expenseCtx, retirementMonth0: retirementMonth0 ?? 0 };
  const expenseCtxBase = { ...expenseCtx, inflation: { ratePct: 0 } };
  const expenseCtxBaseMonth = {
    ...expenseCtxMonth,
    inflation: { ratePct: 0 },
  };
  const categoryMonthlyNominal = projectExpensesByCategoryMonth(
    resolvedExpenses,
    expenseCtxMonth,
    categoryRange,
  );
  const categoryYearlyNominal = projectExpensesByCategoryYear(
    resolvedExpenses,
    expenseCtx,
    categoryRange,
  );
  const categoryMonthlyBase = projectExpensesByCategoryMonth(
    resolvedExpenses,
    expenseCtxBaseMonth,
    categoryRange,
  );
  const categoryYearlyBase = projectExpensesByCategoryYear(
    resolvedExpenses,
    expenseCtxBase,
    categoryRange,
  );

  const incomeByYear = new Map<number, number>();
  const sourceSplitByYear = new Map<
    number,
    { ss: number; pensionAnnuity: number; partTime: number; oneOff: number }
  >();
  for (let y = fromYear; y <= drawdownEndYear; y += 1) {
    const ssRow = ssYears.find((r) => r.year === y);
    const incRow = incomeYears.find((r) => r.year === y);
    const ss = ssRow?.total ?? 0;
    const pensionAnnuity = incRow?.spendable.pension ?? 0;
    const partTime = incRow?.spendable.partTime ?? 0;
    const oneOff = incRow?.spendable.oneOff ?? 0;
    incomeByYear.set(y, ss + pensionAnnuity + partTime + oneOff);
    sourceSplitByYear.set(y, { ss, pensionAnnuity, partTime, oneOff });
  }
  // DISPLAY-ONLY + intentionally household-summed: this builder synthesizes its
  // OWN household-summed post-primary `depositsByMonth` for the yearly /
  // Annual-Portfolio-Flow CHARTS. It does NOT feed the deterministic drawdown
  // engine — the engine consumes the RUNNER's `series.depositsByMonth` (built in
  // balance-projection-runner-cashflow.ts), where post-primary
  // contributions are routed per-account with their pre/post split. The charted figure here
  // is the household deposit TOTAL, invariant to per-account placement (the sum
  // is preserved), so per-account/split routing introduces no engine-vs-chart
  // mismatch and no double-count. The pre/post bucket split is an engine-internal
  // concern this aggregate flow chart does not surface, so this stays summed.
  const depositsByMonth: MonthlyCashflowSeries = emptyMonthlySeries(
    fromYear,
    drawdownEndYear,
  );
  const depositsByYear = new Map<number, number>();
  const primaryAbsMonth = fromYear * 12 + (retirementMonth0 ?? 0);
  const targetedOneOffEvents: Array<{ month: number; amount: number }> = [];
  const postPrimaryContributionEvents: Array<{
    month: number;
    amount: number;
  }> = [];
  const addDepositAt = (
    year: number,
    month0: number,
    amount: number,
  ): void => {
    addOneOff(depositsByMonth, year, month0, amount);
    depositsByYear.set(year, (depositsByYear.get(year) ?? 0) + amount);
  };
  for (const m of incomeMonths) {
    if (m.depositInflow === 0) continue;
    const absMonth = m.year * 12 + m.month0;
    if (absMonth < primaryAbsMonth) continue;
    addDepositAt(m.year, m.month0, m.depositInflow);
    targetedOneOffEvents.push({
      month: m.year * 12 + m.month0,
      amount: m.depositInflow,
    });
  }
  for (const row of data.rows) {
    if (row.account.payload.ownershipType === 'JOINT') continue;
    const ownerIso = row.ownerRetirementDate;
    if (!ownerIso) continue;
    const ownerY = Number(ownerIso.slice(0, 4));
    const ownerM = Number(ownerIso.slice(5, 7)) - 1;
    if (!Number.isFinite(ownerY) || !Number.isFinite(ownerM)) continue;
    const ownerAbs = ownerY * 12 + ownerM;
    if (ownerAbs <= primaryAbsMonth) continue;
    const perMonth =
      row.perMonthContribution.preTax + row.perMonthContribution.postTax;
    if (perMonth === 0) continue;
    for (let abs = primaryAbsMonth; abs < ownerAbs; abs += 1) {
      const y = Math.floor(abs / 12);
      const m0 = abs - y * 12;
      addDepositAt(y, m0, perMonth);
      postPrimaryContributionEvents.push({
        month: y * 12 + m0,
        amount: perMonth,
      });
    }
  }

  const expensesByMonth = buildMonthlyExpenseSeries({
    rows: expenseMonths,
    retirementYear: fromYear,
    horizonYear: drawdownEndYear,
  });
  const incomeByMonth = buildMonthlyIncomeSeries({
    ssRows: ssMonths,
    incomeRows: incomeMonths,
    retirementYear: fromYear,
    horizonYear: drawdownEndYear,
  });

  return {
    fromYear,
    chartEndYear,
    drawdownEndYear,
    incomeByYear,
    expensesByYear,
    depositsByYear,
    expensesByMonth,
    incomeByMonth,
    depositsByMonth,
    sourceSplitByYear,
    extendedExpenseRows,
    monthlySeries: { ssMonths, incomeMonths, expenseMonths },
    categoryMonthlyNominal,
    categoryYearlyNominal,
    categoryMonthlyBase,
    categoryYearlyBase,
    primaryAbsMonth,
    targetedOneOffEvents,
    postPrimaryContributionEvents,
  };
}
