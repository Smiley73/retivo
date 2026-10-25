/** Pure builders for the year-by-year table, the income/cashflow view and the annual portfolio-flow rows. */
import { buildCashflowSeries } from '../lib/cashflow-series';
import type {
  CashflowMonthlyPoint,
} from '../components/CashflowProjectionChart';
import type { IncomeBreakdownPoint } from '../components/IncomeBreakdownChart';
import type {
  ProjectionChartRow,
  ProjectionMethod,
} from '../components/ProjectionChart';
import type { DisplayMode, CashflowGranularity } from '../lib/view-deflator';
import type { McBasis } from '../lib/monte-carlo';
import type { PipelineData, DrawdownByMethodResult } from './balance-projection-page-data';
import type { CashflowSeriesPipelineResult } from './balance-projection-page-cashflow';
import type { YearlyTableRow } from './balance-projection-page-yearly';

export interface IncomeView {
  readonly method: ProjectionMethod;
  readonly fromYear: number;
  readonly chartEndYear: number;
  readonly drawdownEndYear: number;
  readonly yearlyCashflowByYear: Map<number, CashflowMonthlyPoint>;
  readonly growthByYear: Map<number, number>;
  readonly bucketGainByYear: Map<number, { growth: number; income: number }>;
  readonly cashflowChartRows: ReadonlyArray<CashflowMonthlyPoint>;
  readonly breakdownChartRows: ReadonlyArray<IncomeBreakdownPoint>;
  readonly depletionYear: number | null;
}

type DrawdownByMethod = Record<ProjectionMethod, DrawdownByMethodResult | null>;

/** Income/cashflow view for the cashflow and income-breakdown bands and the year table. */
export function buildIncomeView(opts: {
  readonly cashflowSeries: CashflowSeriesPipelineResult | null;
  readonly drawdownByMethod: DrawdownByMethod | null;
  readonly activeMethod: ProjectionMethod;
  /** The representative MC run when a Monte Carlo basis is active, else `drawdownByMethod[activeMethod]`. */
  readonly resolvedDrawdown: DrawdownByMethodResult | null;
  readonly displayMode: DisplayMode;
  readonly cashflowGranularity: CashflowGranularity;
  readonly incomeBreakdownGranularity: CashflowGranularity;
  readonly lastDeathFractional: number | null;
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  /** Path CPI under MC + Today's, `viewDeflator` otherwise. */
  readonly basisDeflator: (year: number) => number;
  /** Empty means no `categoryBand`, so the chart renders the essential/discretionary stack. */
  readonly categoryMeta: ReadonlyArray<{ id: string; name: string; color: string }>;
}): IncomeView | null {
  const {
    cashflowSeries,
    drawdownByMethod,
    activeMethod,
    resolvedDrawdown,
    displayMode,
    cashflowGranularity,
    incomeBreakdownGranularity,
    lastDeathFractional,
    viewDeflator,
    basisDeflator,
    categoryMeta,
  } = opts;
  if (!cashflowSeries || !drawdownByMethod) return null;
  const drawdown = resolvedDrawdown;
  const {
    fromYear,
    chartEndYear,
    drawdownEndYear,
    sourceSplitByYear,
    depositsByYear,
    extendedExpenseRows,
    monthlySeries,
    categoryMonthlyNominal,
    categoryYearlyNominal,
    categoryMonthlyBase,
    categoryYearlyBase,
  } = cashflowSeries;

  // Today's dollars use the 0%-pinned *Base maps and Future dollars the *Nominal maps, mirroring the essential/discretionary band; only share ratios matter.
  const categoryBand =
    categoryMeta.length > 0
      ? {
          monthly:
            displayMode === 'today'
              ? categoryMonthlyBase
              : categoryMonthlyNominal,
          yearly:
            displayMode === 'today' ? categoryYearlyBase : categoryYearlyNominal,
          categoryOrder: categoryMeta.map((c) => c.id),
        }
      : undefined;

  const growthByYear = new Map<number, number>();
  const bucketGainByYear = new Map<number, { growth: number; income: number }>();
  const engineWithdrawnByYear = new Map<number, number>();
  const fundedByYear = new Map<number, boolean>();
  const taxCashByYear = new Map<number, number>();
  for (let y = fromYear; y <= drawdownEndYear; y += 1) {
    const idx = drawdown ? y - fromYear : -1;
    const yearRow = drawdown?.years[idx];
    growthByYear.set(y, yearRow?.growth ?? 0);
    engineWithdrawnByYear.set(y, yearRow?.withdrawn ?? 0);
    fundedByYear.set(y, drawdown != null && yearRow != null && !yearRow.depleted);
    // Net of the credit applied to premiums (it lowered the draw); same fields as the Tax & Health-Cost Burden chart so the band ties out.
    taxCashByYear.set(
      y,
      (Math.max(
        0,
        (yearRow?.federalTaxCents ?? 0) +
          (yearRow?.irmaaSurchargeCents ?? 0) -
          (yearRow?.acaPtcSubsidyCents ?? 0),
      ) -
        (yearRow?.acaCreditAppliedToPremiumsCents ?? 0)) /
        100,
    );
    if (yearRow?.growthBucket && yearRow.incomeBucket) {
      bucketGainByYear.set(y, {
        growth: yearRow.growthBucket.gain,
        income: yearRow.incomeBucket.gain,
      });
    }
  }

  const cashflowChartSeries = buildCashflowSeries({
    fromYear,
    drawdownEndYear,
    sourceSplitByYear,
    depositsByYear,
    extendedExpenseRows,
    displayMode,
    engineWithdrawnByYear,
    fundedByYear,
    taxCashByYear,
    perMonthWithdrawal: drawdown?.perMonthWithdrawal,
    monthlySeries,
    categoryBand,
    viewDeflator,
    basisDeflator,
    lastDeathFractional,
  });
  const cashflowChartRows =
    cashflowGranularity === 'monthly'
      ? cashflowChartSeries.cashflowMonthly
      : cashflowChartSeries.cashflowYearly;
  const breakdownChartRows =
    incomeBreakdownGranularity === 'monthly'
      ? cashflowChartSeries.breakdownMonthly
      : cashflowChartSeries.breakdownYearly;

  const yearlyCashflowByYear = new Map<number, CashflowMonthlyPoint>();
  for (const row of cashflowChartSeries.cashflowYearly) {
    yearlyCashflowByYear.set(row.year, row);
  }

  return {
    method: activeMethod,
    fromYear,
    chartEndYear,
    drawdownEndYear,
    yearlyCashflowByYear,
    growthByYear,
    bucketGainByYear,
    cashflowChartRows,
    breakdownChartRows,
    depletionYear: drawdown?.depletionYear ?? null,
  };
}

/** Unified year-by-year table rows: deflated balance chart rows plus the active method's cashflow and MAGI-cap diagnostics. */
export function buildUnifiedYearTableRows(opts: {
  readonly displayRows: ReadonlyArray<ProjectionChartRow>;
  readonly cashflowSeries: CashflowSeriesPipelineResult | null;
  readonly incomeView: IncomeView | null;
  readonly drawdownByMethod: DrawdownByMethod | null;
  readonly activeMethod: ProjectionMethod;
  /** Under an MC basis the Balance and pre-retirement Gains columns read the `mc` chart-row channel, so the table reconciles with the representative balance line. */
  readonly activeMcBasis: McBasis | null;
  readonly resolvedDrawdown: DrawdownByMethodResult | null;
  readonly lastDeathFractional: number | null;
  /** Path CPI under MC + Today's, `viewDeflator` otherwise; shared by the MC-sourced Gains and Roth-converted columns and the Portfolio Flow chart. */
  readonly basisDeflator: (year: number) => number;
}): YearlyTableRow[] {
  const {
    displayRows,
    cashflowSeries,
    incomeView,
    activeMethod,
    activeMcBasis,
    resolvedDrawdown,
    lastDeathFractional,
    basisDeflator,
  } = opts;
  if (!displayRows.length) return [];
  const fromYear = displayRows[0].year;
  const tailLastYear = displayRows[displayRows.length - 1].year;
  const toYear =
    lastDeathFractional !== null
      ? Math.min(tailLastYear, Math.floor(lastDeathFractional))
      : tailLastYear;
  const retirementYear = cashflowSeries?.fromYear ?? null;
  const cashflowEndYear = cashflowSeries?.chartEndYear ?? null;

  const chartByYear = new Map<number, ProjectionChartRow>();
  for (const r of displayRows) {
    if (Number.isInteger(r.x)) chartByYear.set(r.year, r);
  }

  // Roth converted deflates by basisDeflator (path CPI under MC + Today's) so it ties to the MC balance line.
  const capByYear = new Map<
    number,
    { breachDollars: number; tierOverrideDollars: number; rothConverted: number }
  >();
  const dd = resolvedDrawdown;
  if (dd) {
    for (const dy of dd.years) {
      const convertedCents = dy.rothConvertedCents ?? 0;
      capByYear.set(dy.year, {
        breachDollars: dy.magiCapBreachDollars ?? 0,
        tierOverrideDollars: dy.magiCapTierOverrideDollars ?? 0,
        rothConverted:
          convertedCents > 0 ? (convertedCents / 100) * basisDeflator(dy.year) : 0,
      });
    }
  }

  const rows: YearlyTableRow[] = [];
  for (let y = fromYear; y <= toYear; y += 1) {
    const isCashflowYear =
      retirementYear !== null &&
      cashflowEndYear !== null &&
      y >= retirementYear &&
      y <= cashflowEndYear;

    const balanceByMethod: Record<ProjectionMethod, number | null> = {
      planned: null,
      twr: null,
    };
    const r = chartByYear.get(y);
    if (r) {
      if (activeMcBasis !== null) {
        // Route the MC balance into both deterministic slots: the table reads balanceByMethod[activeMethod], which still points at the last deterministic method.
        const mcBalance = r.mcSolid ?? r.mcDashed ?? null;
        balanceByMethod.planned = mcBalance;
        balanceByMethod.twr = mcBalance;
      } else {
        balanceByMethod.planned = r.plannedSolid ?? r.plannedDashed ?? null;
        balanceByMethod.twr = r.twrSolid ?? r.twrDashed;
      }
    }

    const cf = incomeView?.yearlyCashflowByYear.get(y);
    const earned = isCashflowYear ? (cf?.earned ?? 0) : null;
    const withdrawal = isCashflowYear ? (cf?.withdrawal ?? 0) : null;
    const totalIncome = isCashflowYear ? (cf?.totalIncome ?? 0) : null;
    const expenses = isCashflowYear ? (cf?.total ?? 0) : null;
    const shortfall = isCashflowYear ? (cf?.shortfallHeight ?? 0) : null;
    const preRetGrowth = r
      ? activeMcBasis !== null
        ? (r.mcGrowth ?? null)
        : activeMethod === 'planned'
          ? r.plannedGrowth
          : r.twrGrowth
      : null;
    // Gains are MC-sourced, so deflate by basisDeflator like the Portfolio Flow chart; viewDeflator would diverge from the MC balance line under MC + Today's.
    const gains = isCashflowYear
      ? (incomeView?.growthByYear.get(y) ?? 0) * basisDeflator(y)
      : preRetGrowth;
    const gainsBreakdown = isCashflowYear
      ? incomeView?.bucketGainByYear.get(y) ?? null
      : null;

    const capDiag = capByYear.get(y);

    rows.push({
      year: y,
      isCashflowYear,
      balanceByMethod,
      earned,
      withdrawal,
      totalIncome,
      expenses,
      shortfall,
      gains,
      gainsBreakdown,
      magiCapBreachDollars: capDiag?.breachDollars,
      magiCapTierOverrideDollars: capDiag?.tierOverrideDollars,
      rothConverted: capDiag?.rothConverted,
    });
  }
  return rows;
}

export interface PortfolioFlowYear {
  readonly year: number;
  readonly contributions: number;
  readonly gains: number;
  readonly deposits: number;
  /** Actual annual draw (summed monthly) net of the round-tripping RMD surplus, stored negative; differs from the table's budget `Withdrawal` plug by the within-year timing residual. */
  readonly withdrawals: number;
  /** QCD gift, stored negative. In Today's dollars it divides out the engine's stamped inflation factor (the path's own CPI under MC) so a real gift round-trips to its configured amount. */
  readonly qcd: number;
  readonly netChange: number;
  readonly fractionalYear?: number;
}

/** Annual Portfolio Flow rows, deflated to the display basis (December anchor) like the other Balance Projection surfaces. */
export function buildPortfolioFlowsByYear(opts: {
  readonly data: PipelineData | null;
  readonly cashflowSeries: CashflowSeriesPipelineResult | null;
  readonly drawdownByMethod: DrawdownByMethod | null;
  readonly activeMethod: ProjectionMethod;
  readonly resolvedDrawdown: DrawdownByMethodResult | null;
  readonly displayRows: ReadonlyArray<ProjectionChartRow>;
  readonly lastDeathFractional: number | null;
  /** Deflator for the deterministic flows (pre-retirement contributions and gains, page-side deposits). */
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  /** Path CPI under MC + Today's for the MC-sourced drawdown flows, so the bars tie to the MC balance line. */
  readonly basisDeflator: (year: number) => number;
  /** Drives the QCD stripe's Today's-dollars reversal. */
  readonly displayMode: DisplayMode;
}): PortfolioFlowYear[] | null {
  const {
    data,
    cashflowSeries,
    drawdownByMethod,
    activeMethod,
    resolvedDrawdown,
    displayRows,
    lastDeathFractional,
    viewDeflator,
    basisDeflator,
    displayMode,
  } = opts;
  if (!data || !cashflowSeries || !drawdownByMethod) return null;
  if (!displayRows.length) return null;
  const fromYear = displayRows[0].year;
  const tailLastYear = displayRows[displayRows.length - 1].year;
  const toYear =
    lastDeathFractional !== null
      ? Math.min(tailLastYear, Math.floor(lastDeathFractional))
      : tailLastYear;
  const retirementYear = cashflowSeries.fromYear;
  const cashflowEndYear = cashflowSeries.chartEndYear;
  const drawdown = resolvedDrawdown;

  const rows: PortfolioFlowYear[] = [];
  for (let y = fromYear; y <= toYear; y += 1) {
    let contributions = 0;
    let preRetGains = 0;
    for (const r of data.rows) {
      const out = r.outputs[activeMethod];
      if (!out) continue;
      const yt = out.yearlyTotals.find((t) => t.year === y);
      if (!yt) continue;
      contributions += yt.contributions;
      preRetGains += yt.growth;
    }

    let gains = preRetGains;
    let withdrawalsAbs = 0;
    let isDrawdownPhase = false;
    // Both reinvested and held-as-cash RMD surplus stay in the portfolio, so both are inflows. Do not source from dy.deposit: it double-counts page-side depositInflow and secondary contributions.
    let rmdSurplus = 0;
    // The QCD pre-pass debits the source IRA directly and is not in the drawdown's withdrawn, so it is booked into netChange separately.
    let qcdOutflow = 0;
    let qcdInflationFactor = 1;
    if (y >= retirementYear && y <= cashflowEndYear && drawdown) {
      const idx = y - retirementYear;
      const dy = drawdown.years[idx];
      if (dy) {
        gains = dy.growth;
        withdrawalsAbs = dy.withdrawn;
        rmdSurplus =
          ((dy.rmdReinvestedCents ?? 0) + (dy.rmdOverflowToCashCents ?? 0)) / 100;
        qcdOutflow = (dy.qcdCents ?? 0) / 100;
        qcdInflationFactor = dy.qcdInflationFactor ?? 1;
        isDrawdownPhase = true;
      }
    } else if (y > cashflowEndYear) {
      gains = 0;
    }

    const deposits = cashflowSeries.depositsByYear.get(y) ?? 0;
    // Net the reinvested or held RMD surplus out of withdrawn (an internal transfer): the bar is the actual spending draw.
    // That draw is the engine's monthly-summed amount, not the table's budget plug; the funded-reconcile residual stays inside it and is counted once.
    // Deterministic flows deflate by viewDeflator(y, 11); MC-sourced gains and the spending draw deflate by basisDeflator, the path's own CPI.
    const f = viewDeflator(y, 11);
    const fMc = basisDeflator(y);
    const contributionsDisp = contributions * f;
    const gainsDisp = gains * (isDrawdownPhase ? fMc : f);
    const depositsDisp = deposits * f;
    const spendingAbsDisp = Math.max(0, withdrawalsAbs - rmdSurplus) * fMc;
    // Today's dollars divide out the engine's stamped inflation factor so a real QCD round-trips; the same qcdOutflowDisp feeds the stripe and netChange so segments still sum.
    const qcdOutflowDisp =
      displayMode === 'today' && qcdInflationFactor > 0
        ? qcdOutflow / qcdInflationFactor
        : qcdOutflow;
    const netChange =
      contributionsDisp +
      gainsDisp +
      depositsDisp -
      spendingAbsDisp -
      qcdOutflowDisp;
    rows.push({
      year: y,
      contributions: contributionsDisp,
      gains: gainsDisp,
      deposits: depositsDisp,
      // `|| 0` normalizes the −0 from negating zero (Object.is(−0, 0) is false).
      withdrawals: -spendingAbsDisp || 0,
      qcd: -qcdOutflowDisp || 0,
      netChange,
    });
  }
  return rows;
}
