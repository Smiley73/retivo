/**
 * Balance Projection page — pure builders for the year-by-year table,
 * the income/cashflow view, and the annual portfolio-flow rows.
 *
 * Extracted from `BalanceProjectionPage.tsx` so the page stays a thin
 * presentation + orchestration layer under the file shape cap.
 * Each builder is a pure transform over the runner's per-method drawdown
 * slices (`drawdownByMethod`, sourced from `runBalanceProjectionForPage`)
 * plus the page-side income/expense cashflow series — no React, no DOM.
 */
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
import type {
  PipelineData,
  DrawdownByMethodResult,
  McBasis,
} from './balance-projection-page-data';
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

/**
 * Build the income / cashflow view consumed by the cashflow + income-
 * breakdown bands and the year-by-year table. Combines the page-side
 * cashflow series with the active method's runner drawdown years.
 */
export function buildIncomeView(opts: {
  readonly cashflowSeries: CashflowSeriesPipelineResult | null;
  readonly drawdownByMethod: DrawdownByMethod | null;
  readonly activeMethod: ProjectionMethod;
  /** Resolved per-year drawdown: the representative MC run when a Monte Carlo
   *  basis is active, else `drawdownByMethod[activeMethod]`. The cashflow band
   *  (Withdrawal / Shortfall) + `perMonthWithdrawal` read THIS record. */
  readonly resolvedDrawdown: DrawdownByMethodResult | null;
  readonly displayMode: DisplayMode;
  /** Granularity owned by the cashflow card's toggle — drives
   *  `cashflowChartRows`. */
  readonly cashflowGranularity: CashflowGranularity;
  /** Granularity owned by the income-breakdown card's own toggle —
   *  drives `breakdownChartRows`, independent of `cashflowGranularity`
   *  (the two cards may drift out of sync). */
  readonly incomeBreakdownGranularity: CashflowGranularity;
  /** Rightmost death marker's fractional X. Threaded into the Yearly
   *  cashflow series so its death-year row is prorated to the partial
   *  year lived and repositioned onto the death marker (no gap). */
  readonly lastDeathFractional: number | null;
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  /** Basis-aware deflator for the MC-sourced cashflow fields (withdrawal +
   *  taxes) — path CPI under MC + Today's, `viewDeflator` otherwise.
   *  Threaded through to `cashflow-series.ts`. */
  readonly basisDeflator: (year: number) => number;
  /** Active expense categories (id / name / colour) for the cashflow "by
   *  category" mode. Empty ⇒ no `categoryBand` is threaded into
   *  `buildCashflowSeries` (the chart renders the essential/discretionary
   *  stack). Only the ids + their order drive the per-category band-basis
   *  allocation here; names/colours are the chart's concern. */
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

  // When "by category" mode is active (categoryMeta non-empty),
  // thread the band-basis per-category maps into the series builder. Pick
  // the inflation basis by display mode — Today's-dollars uses the 0%-
  // pinned `*Base` maps, Future-dollars the scenario-rate `*Nominal` maps
  // — mirroring how the displayed essential/discretionary band resolves.
  // Only the share ratios matter; the residual allocation rescales to the
  // displayed essential+discretionary. `categoryOrder` = the stable
  // alphabetical id order the residual's last-category absorption follows.
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
    // Portfolio tax cash = (federalTax + irmaaSurcharge − acaPtcSubsidy)
    // from the resolved row, cents→dollars, nominal, clamped ≥ 0, MINUS the
    // credit the engine applied to premiums (it lowered that year's draw, so
    // the funded reconcile must not add it back). The two never overlap — the
    // credit is applied only past the tax it first offsets — so the band is
    // either the tax cash or minus the credit applied. Same fields the Tax &
    // Health-Cost Burden chart sums, so the band ties out with it. Funded for
    // every basis — named-strategy MC now funds tax per path (the suppression
    // guard is gone).
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

/**
 * Build the unified year-by-year table rows by stitching the deflated
 * balance chart rows with the active method's cashflow figures + MAGI-cap
 * diagnostics.
 */
export function buildUnifiedYearTableRows(opts: {
  readonly displayRows: ReadonlyArray<ProjectionChartRow>;
  readonly cashflowSeries: CashflowSeriesPipelineResult | null;
  readonly incomeView: IncomeView | null;
  readonly drawdownByMethod: DrawdownByMethod | null;
  readonly activeMethod: ProjectionMethod;
  /** Active Monte Carlo basis, or `null` for a deterministic basis. When set,
   *  the Balance column + pre-retirement Gains read the `mc` chart-row channel
   *  (so the table reconciles with the representative balance line), and the
   *  MAGI-cap diagnostics route through `resolvedDrawdown`. */
  readonly activeMcBasis: McBasis | null;
  /** Resolved per-year drawdown — the representative MC run when active, else
   *  `drawdownByMethod[activeMethod]`. Drives the MAGI-cap diagnostics. */
  readonly resolvedDrawdown: DrawdownByMethodResult | null;
  readonly lastDeathFractional: number | null;
  /** Basis-aware deflator for the MC-sourced columns (Gains + Roth-converted) —
   *  path CPI under MC + Today's, `viewDeflator` otherwise. The
   *  cashflow-year Gains column is MC-sourced, so it shares this factor with the
   *  Portfolio Flow chart's drawdown gains + the MC balance line. */
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
  // `lastDeathFractional` is now the integer death year (death = Dec 31
  // of `deathYear`), so `Math.floor` is the identity — the series clips
  // at `deathYear`, the terminal full-value year (same value as before).
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

  // Year-keyed MAGI cap diagnostics from the RESOLVED drawdown (the
  // representative MC run when a Monte Carlo basis is active, else the active
  // deterministic method). Per-year Roth converted (cents → dollars).
  // The converted cents are MC-sourced under an MC basis, so they deflate by
  // the path's OWN CPI via `basisDeflator` (Today's-dollars), tying to the MC
  // balance line; a deterministic basis / Future-dollars falls back to the flat
  // `viewDeflator` inside `basisDeflator`.
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
        // The Balance column reads the `mc` chart-row channel (built from the
        // representative run) so the table reconciles with the MC balance line.
        // The table component reads `balanceByMethod[activeMethod]`, so route
        // the MC balance into BOTH deterministic slots — `activeMethod` still
        // points at the last deterministic method while a basis is active.
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
    // The cashflow-year Gains column is MC-sourced (`growthByYear` comes
    // from the representative drawdown run), so it deflates by `basisDeflator`
    // — the same factor the Portfolio Flow chart's drawdown gains and the MC
    // balance line use — instead of the flat `viewDeflator`. Under MC +
    // Today's (path CPI ≠ flat rate) the two would otherwise diverge.
    // `basisDeflator` falls back to `viewDeflator` under a deterministic basis
    // / Future-dollars.
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
  /** Portfolio withdrawal that funds the retirement spend = the drawdown's
   *  gross `withdrawn` net of any reinvested/held RMD surplus (an internal
   *  transfer that nets to zero in the portfolio and does not fund spending).
   *  Stored negative (below the zero line). Same units / deflator as the
   *  income-breakdown + year-by-year table `Withdrawal` for the year, but a
   *  **different quantity**: this is the engine's actual annual draw (summed
   *  month by month) net of the round-tripping RMD surplus, so it ties to the
   *  portfolio net change — not to the table/income-breakdown budget
   *  `Withdrawal` plug. The two can differ by the documented within-year
   *  proration / timing residual. In the display basis (deflated in 'today'
   *  mode, nominal in 'future'). */
  readonly withdrawals: number;
  /** Qualified Charitable Distribution directed from a traditional IRA to a
   *  charity for the year (the drawdown row's `qcdCents`). Today's-dollars
   *  deflation is QCD-SPECIFIC: the gift divides out the engine's EXACT
   *  stamped inflation factor (`DrawdownYear.qcdInflationFactor`, year-end
   *  anchor in both engines) so a configured REAL gift round-trips to its
   *  configured amount — under MC the stamped factor is the path's OWN CPI,
   *  not the display `basisDeflator` (QCD.md). Nominal in 'future' mode. A real outflow that leaves the
   *  portfolio for the gift — distinct from the spending `withdrawals` (it does
   *  not fund the household budget) and from the round-tripping RMD surplus
   *  (which STAYS in the portfolio). Stored negative (below the zero line),
   *  mirroring the `withdrawals` sign convention; 0 in non-QCD years. The SAME
   *  deflated value is subtracted into `netChange` so every segment still sums to
   *  it. */
  readonly qcd: number;
  readonly netChange: number;
  /** Fractional X position. Always omitted now (death = Dec 31 of
   *  `deathYear`, so every bar — including the death-year terminal bar —
   *  is a full year at its integer `year`); the chart falls back to
   *  `year`. Retained as optional so the chart's `?? year` contract is
   *  unaffected. */
  readonly fractionalYear?: number;
}

/**
 * Build the Annual Portfolio Flow rows: pre-retirement contributions +
 * growth from the per-account accumulation, then the runner drawdown
 * years' gains + withdrawals + page-side deposits post-retirement. Every
 * series is deflated to the display basis (`viewDeflator(y, 11)`, the
 * December anchor) so the chart shares the page's Today's-/Future-dollars
 * basis with the balance line, the cashflow + income-breakdown bands, and
 * the year-by-year table (whose `Withdrawal` column shares the same
 * display basis / deflator but is a **different quantity** — the year's
 * budgeted need, not the engine's actual monthly-summed draw; see the
 * `PortfolioFlowYear.withdrawals` TSDoc).
 */
export function buildPortfolioFlowsByYear(opts: {
  readonly data: PipelineData | null;
  readonly cashflowSeries: CashflowSeriesPipelineResult | null;
  readonly drawdownByMethod: DrawdownByMethod | null;
  readonly activeMethod: ProjectionMethod;
  /** Resolved drawdown — the representative MC run when active, else the
   *  deterministic method (Annual Portfolio Flow is MC-driven). */
  readonly resolvedDrawdown: DrawdownByMethodResult | null;
  readonly displayRows: ReadonlyArray<ProjectionChartRow>;
  readonly lastDeathFractional: number | null;
  /** Nominal → display deflator (Dec-31 anchor per year). Identity in
   *  'future' mode; deflates to today's dollars in 'today' mode, matching
   *  the year-by-year table's `viewDeflator(y, 11)` factor so every
   *  Balance-Projection surface shares one display basis. Used for the
   *  DETERMINISTIC flows (pre-retirement contributions/gains, page-side
   *  deposits). */
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  /** Basis-aware deflator for the MC-SOURCED drawdown-phase flows (the
   *  drawdown growth + the net spending draw). Path CPI under MC + Today's,
   *  `viewDeflator` otherwise — so the drawdown bars tie to the
   *  MC balance line. */
  readonly basisDeflator: (year: number) => number;
  /** Display mode — drives the QCD stripe's today's-dollars reversal (the gift
   *  divides out the engine's EXACT stamped inflation factor, so a REAL QCD
   *  round-trips to its configured amount; QCD.md). Identity (nominal) in
   *  'future' mode. */
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
  // `lastDeathFractional` is now the integer death year (death = Dec 31
  // of `deathYear`), so `Math.floor` is the identity — the series clips
  // at `deathYear`, the terminal full-value year (same value as before).
  const toYear =
    lastDeathFractional !== null
      ? Math.min(tailLastYear, Math.floor(lastDeathFractional))
      : tailLastYear;
  const retirementYear = cashflowSeries.fromYear;
  const cashflowEndYear = cashflowSeries.chartEndYear;
  const drawdown = resolvedDrawdown;

  // Death = Dec 31 of `deathYear`, the terminal year: the loop ends at
  // the integer death year (`toYear = floor(lastDeathFractional) =
  // deathYear`) and that final bar carries FULL annual flows — no
  // partial-year proration. The marker lands on the last bar
  // (`deathYear`) via the bar chart's own x-convention.
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
    // True when this year's `gains` + spending come from the MC-sourced
    // drawdown row (so they deflate by the path's own CPI via `basisDeflator`).
    // Pre-retirement contributions/gains stay deterministic (`viewDeflator`).
    let isDrawdownPhase = false;
    // Total retained RMD surplus (reinvested + held-as-cash). Both
    // dispositions stay in the portfolio, so both must appear on the
    // inflow side for `netChange` to reconcile in the surplus year. CAUTION: do
    // NOT source from `dy.deposit` (it already double-counts the page-side
    // depositInflow + secondary contributions) — read the dedicated fields only.
    let rmdSurplus = 0;
    // Qualified Charitable Distribution (QCD) gift directed from a traditional
    // IRA for the year. The QCD pre-pass debits the source IRA balance directly
    // and is NOT folded into the drawdown's `withdrawn`, so it is absent from
    // `withdrawalsAbs` above — a real outflow that must be charted + booked into
    // netChange separately (else netChange over-states the balance change in QCD
    // years). 0 / undefined in non-QCD years.
    let qcdOutflow = 0;
    // The EXACT inflation factor the engine used to inflate the REAL gift to
    // the nominal `qcdCents` (year-end anchor: December factor deterministic /
    // path year-end cumCpi MC). 1 in a non-QCD year — the QCD stripe is 0
    // either way.
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
    // The drawdown's gross `withdrawn` includes any forced-RMD surplus that is
    // reinvested into a taxable account / held as cash — an internal transfer
    // that nets to zero in the portfolio total, so it does NOT fund spending.
    // Net it out so the bar is the ACTUAL spending draw that left the invested
    // accounts; the forced RMD itself is surfaced on the dedicated RMD chart +
    // surplus tile, not re-litigated as a round trip here. NOTE: this is the
    // engine's actual annual draw (summed month by month) — a DIFFERENT quantity
    // from the year-by-year table / income-breakdown Withdrawal, which is the
    // year's budgeted need (`reconcileYearlyCashflow`'s `max(0, expense + taxes
    // − earned)` plug). The two use the same units / deflator and can differ by
    // a small within-year proration / timing residual (the engine draws monthly,
    // so its annual `withdrawn` need not equal the per-year budget net-need —
    // the documented funded-reconcile residual). That residual is already inside
    // this `withdrawn − rmdSurplus` figure, so it stays in the net-change line
    // and is counted once (not a tax seam, not an un-booked draw). See
    // balance-projection-page-yearly-flow-budget-decomposition.test.
    // Deflate at the December anchor. Deterministic flows (pre-ret
    // contributions/gains, page-side deposits) use the flat `viewDeflator(y, 11)`
    // factor the year-by-year table + cashflow / income-breakdown bands use
    // (identity in 'future' mode). The MC-sourced drawdown-phase gains + net
    // spending draw deflate by the path's OWN CPI (`basisDeflator(y)`), so the
    // drawdown bars tie to the MC balance line; `basisDeflator` falls back
    // to `viewDeflator` under a deterministic basis / Future-dollars.
    const f = viewDeflator(y, 11);
    const fMc = basisDeflator(y);
    const contributionsDisp = contributions * f;
    const gainsDisp = gains * (isDrawdownPhase ? fMc : f);
    const depositsDisp = deposits * f;
    const spendingAbsDisp = Math.max(0, withdrawalsAbs - rmdSurplus) * fMc;
    // The QCD is a drawdown-phase outflow that already left the source IRA
    // balance. Unlike the spending draw (deflated by the year-END `fMc` so it
    // ties to the balance line), the QCD stripe reverses the engine's EXACT
    // stamped inflation factor in Today's-dollars mode so the REAL gift
    // round-trips to its configured amount (a $10k REAL QCD shows $10,000 —
    // QCD.md); under MC the stamped factor is the path's OWN CPI, not the
    // display basis. Future-dollars (or a missing/zero factor): the nominal
    // gift. The SAME `qcdOutflowDisp` feeds both the `qcd` stripe and the
    // netChange subtraction, so every charted segment still sums to netChange
    // (the gift is counted exactly once). Non-QCD years: `qcdOutflowDisp` is 0 →
    // netChange unchanged (byte-identical).
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
      // `|| 0` normalizes the −0 that negating a zero-magnitude draw produces
      // (Object.is(−0, 0) is false, which trips strict equality downstream).
      withdrawals: -spendingAbsDisp || 0,
      // Same negative (below-zero) sign convention as `withdrawals`; 0 in
      // non-QCD years (the `|| 0` normalizes the −0 of negating a zero gift).
      qcd: -qcdOutflowDisp || 0,
      netChange,
    });
  }
  return rows;
}
