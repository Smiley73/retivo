/**
 * Pure builder for the Balance Projection cashflow and income-breakdown chart bands, Monthly and Yearly; every input is passed explicitly (no React, no IndexedDB).
 * Monthly points are true monthly dollars (recurring streams ÷ 12, events at literal magnitude); Yearly is one point per year, identical to the year-by-year table.
 */
import type { CashflowMonthlyPoint } from './cashflow-chart-types';
import type { IncomeBreakdownPoint } from '../components/IncomeBreakdownChart';
import type {
  ExpenseCategoryMonthlyPoint,
  ExpenseCategoryYearPoint,
  ExpenseProjectionMonthlyPoint,
  ExpenseProjectionPoint,
} from './expense-projection';
import type { IncomeMonthOutput } from './income-projection';
import type { SsMonthOutput } from './ss-projection';
import type { DisplayMode } from './view-deflator';
import { reconcileYearlyCashflow } from './yearly-cashflow-reconcile';

/** Per-year SS / pension / part-time / one-off split (nominal). */
export interface SourceSplit {
  ss: number;
  pensionAnnuity: number;
  partTime: number;
  oneOff: number;
}

export interface CashflowSeriesInput {
  /**
   * First retirement year: the start of the yearly loop and the per-month-withdrawal index base.
   */
  fromYear: number;
  /** Last year the drawdown engine ran (lastDeathYear + tail). */
  drawdownEndYear: number;
  /** SS / pension / part-time / one-off per year (nominal). */
  sourceSplitByYear: Map<number, SourceSplit>;
  /** Lump-sum portfolio-addition deposits per year (nominal). */
  depositsByYear: Map<number, number>;
  /**
   * Per-year essential/discretionary split (nominal) plus the real `*Base` fields
   * (`projectExpensesByYear` rows), distinct from `monthlySeries`' per-month array. `'today'` reads
   * `*Base` with no deflator; `'future'` reads nominal × `viewDeflator`.
   */
  extendedExpenseRows: ExpenseProjectionPoint[];
  /**
   * `'today'` reads the real `*Base` expense fields and runs the funded reconcile and Monthly
   * year-gate on displayed values; `'future'` runs the nominal path.
   */
  displayMode: DisplayMode;
  /**
   * Active-method per-year drawdown `withdrawn` (nominal), built from the selected drawdown in the
   * page's `incomeView`.
   */
  engineWithdrawnByYear: Map<number, number>;
  /**
   * Per-year funded signal: a drawdown and a year row exist and the row is not `depleted`; drives
   * the funded reconcile.
   */
  fundedByYear: Map<number, boolean>;
  /**
   * Per-year portfolio tax cash (nominal): `max(0, federalTax + irmaaSurcharge − acaPtcSubsidy)`
   * less the credit applied to premiums, negative only in a year the credit lowered the draw.
   * Stacked as the Taxes band atop essential/discretionary and added to the funded reconcile's
   * expense, so the displayed withdrawal grosses up to cover expenses + taxes and reproduces the
   * engine `withdrawn`.
   */
  taxCashByYear: Map<number, number>;
  /** Active-method per-month withdrawal ($/month). `undefined` when no
   *  drawdown ran for the active method. */
  perMonthWithdrawal: Float64Array | undefined;
  /** Per-month engine output; `null` collapses the Monthly series to empty. */
  monthlySeries: {
    ssMonths: SsMonthOutput[];
    incomeMonths: IncomeMonthOutput[];
    expenseMonths: ExpenseProjectionMonthlyPoint[];
  } | null;
  /**
   * Per-category expense maps for "by category" mode; absent leaves each point's `byCategory`
   * undefined. Projected at the active display mode's inflation so share ratios match the band;
   * `pushPoint` rescales them to exactly `essential + discretionary`, and `total`/`shortfall` are
   * never re-summed from them. `categoryOrder` must match the chart's `categoryMeta` order.
   */
  categoryBand?: {
    /** Per-month recurring/one-off split, run through the same `monthlyBucket` math as the band. */
    monthly: ExpenseCategoryMonthlyPoint[];
    /** Cadence-correct per-year per-category rollup (Yearly path). */
    yearly: ExpenseCategoryYearPoint[];
    /**
     * Stable id order; the last category absorbs the residual so
     * `Σ byCategory === essential + discretionary`.
     */
    categoryOrder: ReadonlyArray<string>;
  };
  /** Nominal → display deflator for the deterministic income stripes and portfolio-add deposits. */
  viewDeflator: (year: number, monthIndex?: number) => number;
  /**
   * Basis-aware deflator for the MC-sourced taxes and withdrawal (path CPI under MC + Today's, else
   * `viewDeflator`), so those bands tie to the MC balance line.
   */
  basisDeflator: (year: number) => number;
  /**
   * Rightmost death marker's X: the integer death year (`birthYear + lifeExpectancyAge`). Death is
   * modelled on Dec 31, so the death-year row carries full annual values; a domain hint only, the
   * series is not modified by it.
   */
  lastDeathFractional?: number | null;
}

export interface CashflowSeriesOutput {
  /** Trimmed per-month cashflow rows (Monthly mode). */
  cashflowMonthly: CashflowMonthlyPoint[];
  /** Trimmed one-point-per-year cashflow rows (Yearly mode). */
  cashflowYearly: CashflowMonthlyPoint[];
  /** Trimmed per-month income-breakdown rows (Monthly mode). */
  breakdownMonthly: IncomeBreakdownPoint[];
  /** Trimmed one-point-per-year income-breakdown rows (Yearly mode). */
  breakdownYearly: IncomeBreakdownPoint[];
}

const MONTHS_PER_YEAR = 12;

// Under $1 of the displayed point is rounding noise between per-period slicing and the annual
// drawdown engine, not real unfunded need; the tooltip and year-by-year table use the same
// threshold. It applies post-deflation in both modes, so it is $1/mo Monthly and $1/yr Yearly.
const suppressSubDollar = (raw: number): number => (raw < 1 ? 0 : raw);

function trimTrailingZero<T extends { total: number; expenses?: number }>(
  arr: T[],
): T[] {
  let last = arr.length - 1;
  while (
    last >= 0 &&
    arr[last].total === 0 &&
    (arr[last].expenses ?? 0) === 0
  ) {
    last -= 1;
  }
  return last >= 0 ? arr.slice(0, last + 1) : [];
}

function trimCashflow(rows: CashflowMonthlyPoint[]): CashflowMonthlyPoint[] {
  return trimTrailingZero(
    rows.map((r) => ({
      ...r,
      total: r.total + r.totalIncome,
      expenses: r.total,
    })),
  ).map((_v, i) => rows[i]);
}

interface PointInputs {
  fractionalYear: number;
  year: number;
  month0: number;
  ss: number;
  pensionAnnuity: number;
  partTime: number;
  oneOff: number;
  portfolioAdd: number;
  earned: number;
  essential: number;
  discretionary: number;
  taxes: number;
  withdrawal: number;
  // Band-basis per-category magnitudes (only the ratios are used); undefined in Total mode.
  categoryShareSource?: Record<string, number>;
  categoryOrder?: ReadonlyArray<string>;
}

// Exact residual allocation of the displayed essential + discretionary band across `order`: each
// category but the last gets `share/Σ × band`, and the last non-zero one absorbs the residual so
// `Σ === band` with no FP drift (-0 normalised; an empty map when the share denominator is 0).
// `band` can include spend from category ids absent from `order` (e.g. a deleted category); that is
// redistributed proportionally across the present ones, an edge-case fallback since the UI blocks
// deleting a referenced category.
function allocateByCategory(
  shareSource: Record<string, number>,
  order: ReadonlyArray<string>,
  band: number,
): Record<string, number> {
  const present = order.filter((id) => (shareSource[id] ?? 0) !== 0);
  let denom = 0;
  for (const id of present) denom += shareSource[id];
  if (denom === 0) return {};
  const out: Record<string, number> = {};
  let running = 0;
  for (let i = 0; i < present.length; i += 1) {
    const id = present[i];
    if (i === present.length - 1) {
      const residual = band - running;
      out[id] = residual <= 0 ? 0 : residual + 0; // `+0` normalises -0
    } else {
      const v = (shareSource[id] / denom) * band;
      out[id] = v + 0;
      running += v;
    }
  }
  return out;
}

function pushPoint(
  p: PointInputs,
  cashflow: CashflowMonthlyPoint[],
  breakdown: IncomeBreakdownPoint[],
): void {
  // The Taxes band sits atop essential/discretionary; the shortfall ribbon and breakdown `expenses`
  // both compare against this taxes-inclusive total, which the grossed-up funded `p.withdrawal`
  // covers.
  const expenseTotal = p.essential + p.discretionary + p.taxes;
  const totalIncome = p.earned + p.withdrawal;
  // Category bands re-segment only essential+discretionary; `total`/`shortfallHeight` keep the
  // untouched expenseTotal so the stack top matches Total mode.
  const byCategory =
    p.categoryShareSource && p.categoryOrder
      ? allocateByCategory(
          p.categoryShareSource,
          p.categoryOrder,
          p.essential + p.discretionary,
        )
      : undefined;
  cashflow.push({
    fractionalYear: p.fractionalYear,
    year: p.year,
    month0: p.month0,
    essential: p.essential,
    discretionary: p.discretionary,
    taxes: p.taxes,
    total: expenseTotal,
    earned: p.earned,
    withdrawal: p.withdrawal,
    totalIncome,
    shortfallBase: totalIncome,
    shortfallHeight: suppressSubDollar(Math.max(0, expenseTotal - totalIncome)),
    ...(byCategory ? { byCategory } : {}),
  });
  breakdown.push({
    fractionalYear: p.fractionalYear,
    year: p.year,
    month0: p.month0,
    ss: p.ss,
    pensionAnnuity: p.pensionAnnuity,
    partTime: p.partTime,
    oneOff: p.oneOff,
    portfolioAdd: p.portfolioAdd,
    withdrawal: p.withdrawal,
    total: totalIncome + p.portfolioAdd,
    expenses: expenseTotal,
  });
}

function monthlyBucket(recurring: number, spike: number, f: number): number {
  return ((recurring - spike) / MONTHS_PER_YEAR + spike) * f;
}

function perMonthWithdrawalAt(
  perMonthWithdrawal: Float64Array | undefined,
  monthIdx: number,
): number {
  return perMonthWithdrawal &&
    monthIdx >= 0 &&
    monthIdx < perMonthWithdrawal.length
    ? perMonthWithdrawal[monthIdx]
    : 0;
}

// Yearly expense pair for the band, and the amount the reconcile compares against (in the
// reconcile's own scale, before `× f`). `'today'` reads the real `*Base` fields; `'future'` the
// nominal split × `f`, reconciling against the pure nominal `total` so the single `× f` on the
// reconciled withdrawal is exact.
function resolveYearlyExpense(
  expRow: ExpenseProjectionPoint | undefined,
  displayMode: DisplayMode,
  f: number,
): { essential: number; discretionary: number; reconcileExpense: number } {
  if (displayMode === 'today') {
    const essential = expRow?.essentialBase ?? 0;
    const discretionary = expRow?.discretionaryBase ?? 0;
    return {
      essential,
      discretionary,
      reconcileExpense: essential + discretionary,
    };
  }
  return {
    essential: (expRow?.essential ?? 0) * f,
    discretionary: (expRow?.discretionary ?? 0) * f,
    reconcileExpense: expRow?.total ?? 0,
  };
}

// Displayed Yearly withdrawal via the unchanged `reconcileYearlyCashflow`, with taxes folded into
// `expense` so the funded plug grosses up to `max(0, expense + taxes − earned)` and reproduces the
// engine's grossed-up `withdrawn`; the not-funded branch keeps the engine-actual `withdrawn`
// (already grossed up).
// Two deflators: under MC + Today's the displayed `earned` stripes use
// `fEarned = viewDeflator(y, 11)` while the MC-sourced taxes and `engineWithdrawn` use
// `fMc = basisDeflator(y)`; reconciling `earned` at `fMc` would break the funded-year tie-out. In
// `'future'` the reconcile runs on nominal inputs then × `fMc` (== `fEarned`), exact by positive
// homogeneity.
function reconcileDisplayedWithdrawal(
  displayMode: DisplayMode,
  earnedNominal: number,
  reconcileExpense: number,
  taxNominal: number,
  engineWithdrawn: number,
  funded: boolean,
  fEarned: number,
  fMc: number,
): number {
  if (displayMode === 'today') {
    return reconcileYearlyCashflow({
      earned: earnedNominal * fEarned,
      expense: reconcileExpense + taxNominal * fMc,
      engineWithdrawn: engineWithdrawn * fMc,
      funded,
    }).withdrawal;
  }
  return (
    reconcileYearlyCashflow({
      earned: earnedNominal,
      expense: reconcileExpense + taxNominal,
      engineWithdrawn,
      funded,
    }).withdrawal * fMc
  );
}

function resolveMonthlyExpense(
  expRow: ExpenseProjectionMonthlyPoint,
  displayMode: DisplayMode,
  f: number,
): { essential: number; discretionary: number } {
  if (displayMode === 'today') {
    return {
      essential: monthlyBucket(
        expRow.essentialBase,
        expRow.oneOffEssentialBase,
        1,
      ),
      discretionary: monthlyBucket(
        expRow.discretionaryBase,
        expRow.oneOffDiscretionaryBase,
        1,
      ),
    };
  }
  return {
    essential: monthlyBucket(expRow.essential, expRow.oneOffEssential, f),
    discretionary: monthlyBucket(
      expRow.discretionary,
      expRow.oneOffDiscretionary,
      f,
    ),
  };
}

// `'future'` is the engine's `perMonthWithdrawal[idx] × f`, not year-gated (already grossed up).
// `'today'` is year-gated on `!depleted`: a funded year is the per-month budget plug
// `max(0, monthRealExpense + taxesMonth − dispEarnedMonth)` so `shortfallHeight` nets 0; a depleted
// year keeps the engine-actual draw so the genuine gap surfaces.
function monthlyDisplayedWithdrawal(
  displayMode: DisplayMode,
  funded: boolean,
  engineMonthWithdrawal: number,
  monthRealExpense: number,
  taxesMonth: number,
  dispEarnedMonth: number,
  f: number,
): number {
  if (displayMode === 'today' && funded) {
    return Math.max(0, monthRealExpense + taxesMonth - dispEarnedMonth);
  }
  return engineMonthWithdrawal * f;
}

function monthlyIncomeStripes(
  ssRow: SsMonthOutput,
  incRow: IncomeMonthOutput,
  f: number,
): {
  ss: number;
  pensionAnnuity: number;
  partTime: number;
  oneOff: number;
  portfolioAdd: number;
  earned: number;
} {
  const ss = (ssRow.total / MONTHS_PER_YEAR) * f;
  const pensionAnnuity = (incRow.pensionIncome / MONTHS_PER_YEAR) * f;
  const partTime = (incRow.partTimeIncome / MONTHS_PER_YEAR) * f;
  const oneOff = incRow.oneOffIncome * f;
  return {
    ss,
    pensionAnnuity,
    partTime,
    oneOff,
    portfolioAdd: incRow.depositInflow * f,
    earned: ss + pensionAnnuity + partTime + oneOff,
  };
}

function monthlyPointInputs(
  i: number,
  input: CashflowSeriesInput,
  series: NonNullable<CashflowSeriesInput['monthlySeries']>,
): PointInputs {
  const { perMonthWithdrawal, fromYear, viewDeflator, basisDeflator, displayMode } = input;
  const ssRow = series.ssMonths[i];
  const incRow = series.incomeMonths[i];
  // December anchor: keeps a flat nominal stream constant across all 12 months instead of drifting
  // down within the year.
  const f = viewDeflator(ssRow.year, 11);
  // MC-sourced fields (taxes, withdrawal) deflate by the path's own CPI under an MC basis;
  // `basisDeflator` is `viewDeflator` otherwise.
  const fMc = basisDeflator(ssRow.year);
  const stripes = monthlyIncomeStripes(ssRow, incRow, f);
  const monthIdx = (ssRow.year - fromYear) * 12 + ssRow.month0;
  const { essential, discretionary } = resolveMonthlyExpense(
    series.expenseMonths[i],
    displayMode,
    f,
  );
  // Annual tax spread flat across the 12 months (no one-off spike).
  const taxes = monthlyBucket(input.taxCashByYear.get(ssRow.year) ?? 0, 0, fMc);
  const withdrawal = monthlyDisplayedWithdrawal(
    displayMode,
    input.fundedByYear.get(ssRow.year) ?? false,
    perMonthWithdrawalAt(perMonthWithdrawal, monthIdx),
    essential + discretionary,
    taxes,
    stripes.earned,
    fMc,
  );
  // Per-category band magnitudes via the same `monthlyBucket` math; only ratios matter, so f = 1.
  // The arrays align with `expenseMonths` index-for-index.
  const catRow = input.categoryBand?.monthly[i];
  let categoryShareSource: Record<string, number> | undefined;
  if (input.categoryBand && catRow) {
    categoryShareSource = {};
    for (const id of input.categoryBand.categoryOrder) {
      categoryShareSource[id] = monthlyBucket(
        catRow.recurringByCategoryId[id] ?? 0,
        catRow.oneOffByCategoryId[id] ?? 0,
        1,
      );
    }
  }
  return {
    ...stripes,
    fractionalYear: ssRow.fractionalYear,
    year: ssRow.year,
    month0: ssRow.month0,
    essential,
    discretionary,
    taxes,
    withdrawal,
    categoryShareSource,
    categoryOrder: input.categoryBand?.categoryOrder,
  };
}

function buildMonthly(input: CashflowSeriesInput): {
  cashflow: CashflowMonthlyPoint[];
  breakdown: IncomeBreakdownPoint[];
} {
  const { monthlySeries } = input;
  const cashflow: CashflowMonthlyPoint[] = [];
  const breakdown: IncomeBreakdownPoint[] = [];
  if (monthlySeries) {
    const { ssMonths, incomeMonths, expenseMonths } = monthlySeries;
    const limit = Math.min(
      ssMonths.length,
      incomeMonths.length,
      expenseMonths.length,
    );
    for (let i = 0; i < limit; i += 1) {
      pushPoint(
        monthlyPointInputs(i, input, monthlySeries),
        cashflow,
        breakdown,
      );
    }
  }
  return { cashflow, breakdown };
}

function yearlyIncomeStripes(
  split: SourceSplit | undefined,
  f: number,
): {
  ss: number;
  pensionAnnuity: number;
  partTime: number;
  oneOff: number;
  earned: number;
  earnedNominal: number;
} {
  const ss = (split?.ss ?? 0) * f;
  const pensionAnnuity = (split?.pensionAnnuity ?? 0) * f;
  const partTime = (split?.partTime ?? 0) * f;
  const oneOff = (split?.oneOff ?? 0) * f;
  return {
    ss,
    pensionAnnuity,
    partTime,
    oneOff,
    earned: ss + pensionAnnuity + partTime + oneOff,
    earnedNominal:
      (split?.ss ?? 0) +
      (split?.pensionAnnuity ?? 0) +
      (split?.partTime ?? 0) +
      (split?.oneOff ?? 0),
  };
}

function yearlyPointInputs(
  y: number,
  input: CashflowSeriesInput,
  expenseByYear: Map<number, ExpenseProjectionPoint>,
  categoryByYear: Map<number, ExpenseCategoryYearPoint> | null,
): PointInputs {
  const f = input.viewDeflator(y, 11);
  const fMc = input.basisDeflator(y);
  const { ss, pensionAnnuity, partTime, oneOff, earned, earnedNominal } =
    yearlyIncomeStripes(input.sourceSplitByYear.get(y), f);
  const { essential, discretionary, reconcileExpense } = resolveYearlyExpense(
    expenseByYear.get(y),
    input.displayMode,
    f,
  );
  // The band shows nominal × `fMc`; the reconcile gets the nominal tax and applies `fMc` per mode.
  const taxNominal = input.taxCashByYear.get(y) ?? 0;
  const taxes = taxNominal * fMc;
  const withdrawal = reconcileDisplayedWithdrawal(
    input.displayMode,
    earnedNominal,
    reconcileExpense,
    taxNominal,
    input.engineWithdrawnByYear.get(y) ?? 0,
    input.fundedByYear.get(y) ?? false,
    f, // fEarned = viewDeflator — matches displayed earned stripes
    fMc, // fMc = basisDeflator — MC-sourced taxes + withdrawal
  );
  // Cadence-correct per-year per-category rollup; the yearly denominator is this map's aggregated
  // Σ, not a per-month Σ.
  const catRow = categoryByYear?.get(y);
  let categoryShareSource: Record<string, number> | undefined;
  if (categoryByYear && input.categoryBand) {
    categoryShareSource = {};
    for (const id of input.categoryBand.categoryOrder) {
      categoryShareSource[id] = catRow?.byCategoryId[id] ?? 0;
    }
  }
  return {
    fractionalYear: y,
    year: y,
    month0: 0,
    ss,
    pensionAnnuity,
    partTime,
    oneOff,
    portfolioAdd: (input.depositsByYear.get(y) ?? 0) * f,
    earned,
    essential,
    discretionary,
    taxes,
    withdrawal,
    categoryShareSource,
    categoryOrder: input.categoryBand?.categoryOrder,
  };
}

function buildYearly(input: CashflowSeriesInput): {
  cashflow: CashflowMonthlyPoint[];
  breakdown: IncomeBreakdownPoint[];
} {
  const expenseByYear = new Map<number, ExpenseProjectionPoint>();
  for (const r of input.extendedExpenseRows) expenseByYear.set(r.year, r);
  const categoryByYear = input.categoryBand
    ? new Map<number, ExpenseCategoryYearPoint>(
        input.categoryBand.yearly.map((r) => [r.year, r]),
      )
    : null;
  const cashflow: CashflowMonthlyPoint[] = [];
  const breakdown: IncomeBreakdownPoint[] = [];
  for (let y = input.fromYear; y <= input.drawdownEndYear; y += 1) {
    pushPoint(
      yearlyPointInputs(y, input, expenseByYear, categoryByYear),
      cashflow,
      breakdown,
    );
  }
  return { cashflow, breakdown };
}

/**
 * Build the trimmed Monthly and Yearly cashflow and income-breakdown series. The death-year row is
 * the terminal full-value row: death is modelled on Dec 31, with no partial-year proration.
 */
export function buildCashflowSeries(
  input: CashflowSeriesInput,
): CashflowSeriesOutput {
  const monthly = buildMonthly(input);
  const yearly = buildYearly(input);
  return {
    cashflowMonthly: trimCashflow(monthly.cashflow),
    cashflowYearly: trimCashflow(yearly.cashflow),
    breakdownMonthly: trimTrailingZero(monthly.breakdown),
    breakdownYearly: trimTrailingZero(yearly.breakdown),
  };
}
