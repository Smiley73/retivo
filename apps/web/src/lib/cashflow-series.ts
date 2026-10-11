/**
 * Pure builder for the Balance Projection page's cashflow +
 * income-breakdown chart bands, in both Monthly and Yearly
 * granularity. Extracted from the page's `incomeView` memo so the
 * 3300-line page does not grow another inline series loop and so the
 * (non-trivial) series math is unit-testable in isolation.
 *
 * No React, no IndexedDB — every input is passed explicitly. The
 * caller (`incomeView`) is the only seam that has the cashflow-series
 * maps, the active-method drawdown, and the view-deflator all in
 * scope, so it threads them in.
 *
 *   - **Monthly** — true monthly dollars: recurring streams (SS,
 *     pension, part-time) ÷ 12; one-off / windfall / lump-sum events
 *     stay at literal magnitude in their month; withdrawal is the
 *     engine's own `perMonthWithdrawal[idx]` ($/month, no ×12). Every
 *     month deflates at the **December anchor** `viewDeflator(year,
 *     11)` (NOT the per-month factor) so a flat nominal stream reads
 *     constant across all 12 months of a year. Opt-in. Σ of the 12
 *     months reconciles with the Yearly point only in steady-state
 *     (no SS-claim/death, no pension/part-time start/end, no one-off,
 *     full retirement year); transition/event years intentionally
 *     diverge — the year-by-year table is the authoritative annual
 *     source.
 *   - **Yearly** (page default) — one Dec-anchored point per year:
 *     nominal annual rollup × `viewDeflator(year, 11)`, numerically
 *     identical to the year-by-year table, so a flat stream reads
 *     constant across the year.
 *
 * Taxes band: a third expense bucket stacked atop essential +
 * discretionary — the per-year portfolio tax cash
 * (`federalTax + irmaaSurcharge − acaPtcSubsidy`, dollars, nominal, ≥ 0).
 * The funded reconcile grosses
 * the displayed withdrawal up by this amount so the income line covers
 * expenses + taxes and reproduces the engine's grossed-up `withdrawn`;
 * the shortfall ribbon compares income against expenses + taxes. The
 * depleted branch keeps the engine-actual `withdrawn` verbatim (already
 * grossed up — no double-count).
 *
 * Display basis: in **`'today'`** mode the expense band is the
 * engine's entered real amount (`extendedExpenseRows[].*Base` /
 * `expenseMonths[].*Base`) — no deflator, so a non-glided constant
 * expense is flat and a glided one follows its real glide curve — while
 * income / SS / part-time / withdrawal / portfolioAdd / taxes stay
 * Dec-anchored flat-nominal (`× viewDeflator(year, 11)`). This module
 * **owns the displayed funded reconcile** (single source for band +
 * table):
 * the unchanged `reconcileYearlyCashflow` runs here on display-resolved
 * inputs, and the Monthly today-mode withdrawal is year-gated on the
 * per-year `!depleted` signal (funded ⇒ per-month plug nets the
 * shortfall to 0; depleted ⇒ engine `perMonthWithdrawal[idx]` and the
 * genuine per-month gap surfaces). In **`'future'`** mode the
 * prior nominal code path runs verbatim (byte-identical).
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

/** Per-year SS / pension / part-time / one-off split — the shape the
 *  page's `cashflowSeries.sourceSplitByYear` map carries. */
export interface SourceSplit {
  ss: number;
  pensionAnnuity: number;
  partTime: number;
  oneOff: number;
}

export interface CashflowSeriesInput {
  /** First retirement year — the start of both the yearly loop and the
   *  per-month-withdrawal index base. */
  fromYear: number;
  /** Last year the drawdown engine ran (lastDeathYear + tail). */
  drawdownEndYear: number;
  /** SS / pension / part-time / one-off per year (nominal). */
  sourceSplitByYear: Map<number, SourceSplit>;
  /** Lump-sum portfolio-addition deposits per year (nominal). */
  depositsByYear: Map<number, number>;
  /** Per-year essential/discretionary expense split (nominal) + the
   *  additive real `*Base` fields — the `projectExpensesByYear` rows.
   *  Distinct from `monthlySeries`' per-month expense array; never
   *  re-roll one from the other. In `'today'` mode the band reads the
   *  `*Base` fields (entered real amount, no deflator); in `'future'`
   *  mode the nominal fields × `viewDeflator` (= 1). */
  extendedExpenseRows: ExpenseProjectionPoint[];
  /** Display mode. `'today'` → expenses read the real `*Base` fields
   *  and the funded reconcile + Monthly year-gate run on displayed
   *  values; `'future'` → the prior nominal code path runs
   *  verbatim (byte-identical by construction). */
  displayMode: DisplayMode;
  /** Active-method per-year drawdown-engine `withdrawn` (nominal).
   *  Built in the page's `incomeView` from the selected drawdown — NOT
   *  from cashflowSeries (which cannot return it without a circular
   *  dependency). The displayed reconcile lives here, so the
   *  pre-reconciled `withdrawalByYear` map is gone. */
  engineWithdrawnByYear: Map<number, number>;
  /** Per-year funded signal = `drawdown != null && yearRow != null &&
   *  !yearRow.depleted`. Drives the funded-year reconcile (Yearly +
   *  today-mode Monthly per-year gate). */
  fundedByYear: Map<number, boolean>;
  /** Per-year portfolio tax cash = `(federalTax + irmaaSurcharge −
   *  acaPtcSubsidy)`, dollars, nominal, clamped ≥ 0. Stacked as the
   *  Taxes band atop
   *  essential/discretionary AND added to the funded reconcile's expense
   *  so the displayed withdrawal grosses up to cover expenses + taxes
   *  (reproducing the engine `withdrawn`). Mirrors the
   *  `engineWithdrawnByYear` basis — built in the page's `incomeView`
   *  from the resolved drawdown rows. */
  taxCashByYear: Map<number, number>;
  /** Active-method per-month withdrawal ($/month). `undefined` when no
   *  drawdown ran for the active method. */
  perMonthWithdrawal: Float64Array | undefined;
  /** Per-month SS / income / expense engine output. `null` collapses
   *  the Monthly series to empty (matches the prior guard). */
  monthlySeries: {
    ssMonths: SsMonthOutput[];
    incomeMonths: IncomeMonthOutput[];
    expenseMonths: ExpenseProjectionMonthlyPoint[];
  } | null;
  /** Band-basis per-category expense maps. Present iff the page is
   *  in "by category" expense mode; absent ⇒ each point's `byCategory` is
   *  left undefined (the chart renders the essential/discretionary stack).
   *  Both arrays are projected at the ACTIVE display mode's inflation (0%
   *  in `'today'`, scenario rate in `'future'`), so the per-category share
   *  ratios match the displayed band; the residual allocation in
   *  `pushPoint` rescales them to exactly `essential + discretionary`
   *  (`total`/`shortfall` are NEVER re-summed from these — they stay on
   *  the untouched essential+discretionary+taxes). `categoryOrder` is the
   *  stable alphabetical id order the residual's last-category absorption
   *  follows (must match the chart's `categoryMeta` order). */
  categoryBand?: {
    /** Per-month per-category recurring/one-off split (the cashflow
     *  Monthly path runs the same `monthlyBucket` math the band uses). */
    monthly: ExpenseCategoryMonthlyPoint[];
    /** Cadence-correct per-year per-category rollup (Yearly path). */
    yearly: ExpenseCategoryYearPoint[];
    /** Stable id order; the LAST category absorbs the residual so
     *  `Σ byCategory === essential + discretionary` exactly. */
    categoryOrder: ReadonlyArray<string>;
  };
  /** Nominal → display deflator. Pure `(year, monthIndex?) => number`
   *  so the helper stays React-free. Drives the DETERMINISTIC income
   *  stripes (SS / pension / part-time / one-off) + the portfolio-add
   *  deposits. */
  viewDeflator: (year: number, monthIndex?: number) => number;
  /** Basis-aware deflator for the MC-SOURCED fields — the yearly + monthly
   *  taxes and the withdrawal reconciliation (`engineWithdrawnByYear` /
   *  `perMonthWithdrawal` originate from `resolvedDrawdown`). Path CPI under
   *  MC + Today's, `viewDeflator` otherwise; so the withdrawal + taxes
   *  bands tie to the MC balance line. Pure `(year) => number`. */
  basisDeflator: (year: number) => number;
  /** Rightmost death marker's X — now the **integer death year**
   *  (`birthYear + lifeExpectancyAge`; the field name is kept despite
   *  the integer value to limit churn), or `null` when no death marker
   *  resolves. Death is modelled on Dec 31 of `deathYear`, the terminal
   *  year, so the death-year row carries FULL annual values — there is no
   *  longer any partial-year proration. Retained only as a potential
   *  domain hint for consumers; the series itself is no longer modified
   *  by it. */
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

/** Recurring streams are stored as annual run-rates; Monthly mode
 *  shows true monthly dollars, so a recurring stream ÷ this. */
const MONTHS_PER_YEAR = 12;

/** Sub-$1-of-the-displayed-point noise floor (mode-agnostic by
 *  design). A shortfall under $1 of the displayed point is a rounding
 *  artifact between the per-period slicing and the annual drawdown
 *  engine, not real unfunded need — the tooltip + year-by-year table
 *  apply the same $1 threshold so all three surfaces agree. Evaluated
 *  post-deflation on the displayed $, so the floor is $1/displayed
 *  point in BOTH modes — $1/mo in Monthly (true monthly dollars),
 *  $1/yr in Yearly. Deliberate: a sub-$1/mo gap is display noise;
 *  genuine post-depletion shortfalls are orders of magnitude larger,
 *  so the absolute $1 floor stays correct at 1/12 monthly magnitude
 *  rather than scaling per mode. */
const suppressSubDollar = (raw: number): number => (raw < 1 ? 0 : raw);

/** Trim trailing rows where the row is fully zero (no income AND no
 *  expenses). After the last surviving member dies and lifetime
 *  expenses end, every following point is zero — drawing them would
 *  collapse the chart to the x-axis past the death marker. Applied to
 *  both Monthly and Yearly arrays. */
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

/** Cashflow rows are "zero" iff expense AND income are both 0, so the
 *  trim test runs against a synthetic `{ total, expenses }` view; the
 *  surviving indices map back to the untouched original rows. */
function trimCashflow(rows: CashflowMonthlyPoint[]): CashflowMonthlyPoint[] {
  return trimTrailingZero(
    rows.map((r) => ({
      ...r,
      total: r.total + r.totalIncome,
      expenses: r.total,
    })),
  ).map((_v, i) => rows[i]);
}

/** Already-deflated per-point values, identical between Monthly and
 *  Yearly — only the `fractionalYear` / `month0` anchor differs. The
 *  shared builder turns one of these into the matching cashflow +
 *  income-breakdown pair so the field-mapping lives in one place. */
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
  /** Per-category share source for this point — band-basis per-category
   *  magnitudes (id → number) at the active display mode. `undefined`
   *  in Total mode (no category breakdown). Only the RATIOS are used; the
   *  residual allocation in `pushPoint` rescales them to exactly
   *  `essential + discretionary`. */
  categoryShareSource?: Record<string, number>;
  /** Stable id order the residual's last-category absorption follows.
   *  Present iff `categoryShareSource` is. */
  categoryOrder?: ReadonlyArray<string>;
}

/**
 * Exact residual allocation of the displayed `essential +
 * discretionary` band across categories in the stable `order`. Every
 * category but the last gets its proportional share `share[c]/Σ × band`;
 * the LAST category in `order` with a non-zero share absorbs the residual
 * `band − Σ(previous)` so `Σ result === band` exactly (no FP drift,
 * matching the repo's RMD / drawdown residual precedent). `-0` is
 * normalised to `0`; a tiny-negative residual is clamped to 0. Returns an
 * EMPTY map when the aggregated share-source denominator is 0 (the band
 * is 0 in lockstep — the share source applies the same clamped
 * discretionary multiplier as the band).
 *
 * Parameters / contract:
 *   - `order` — the display-ordered category ids (== the chart's
 *     `categoryMeta` order). Only ids present in `order` ever appear in the
 *     result; the LAST present-with-non-zero-share id absorbs the residual.
 *   - `shareSource` — id → band-basis magnitude. ONLY the ratios of the ids
 *     in `order` are read (`shareSource[id]` for `id ∉ order` is ignored).
 *   - `band` — the TOTAL displayed `essential + discretionary` dollars to
 *     distribute. This is the untouched stack value; it can include spend
 *     attributable to category ids that are ABSENT from `order` (e.g. an
 *     expense whose category was deleted, so `assembleCategoryMeta` dropped
 *     its id from `categoryMeta` / `categoryOrder`).
 *
 * Orphan-category redistribution (deliberate): because `band` is the
 * full stack total but the proportional shares are taken only over the ids
 * present in `order`, any dollars attributable to ids NOT in `order` are
 * silently redistributed proportionally across the present categories — the
 * Σ === band tie-out is preserved, but the present categories are overstated
 * by the orphan dollars. The orphan id never appears as a result key. The
 * UI's deletion guard prevents the common case (a referenced category is
 * not deletable), so this is an edge-case fallback, not the normal path.
 */
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
      // Last category absorbs the residual so Σ === band exactly.
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

/** Push the cashflow + income-breakdown row pair for one point. The
 *  derived totals (`expenseRate`, `totalIncome`, `shortfallHeight`) are
 *  computed here so Monthly and Yearly cannot drift apart. */
function pushPoint(
  p: PointInputs,
  cashflow: CashflowMonthlyPoint[],
  breakdown: IncomeBreakdownPoint[],
): void {
  // Expense stack top = essential + discretionary + taxes. The Taxes
  // band sits atop the essential/discretionary stack; the shortfall
  // ribbon + breakdown `expenses` both compare against this taxes-
  // inclusive total. The grossed-up `p.withdrawal` (funded reconcile,
  // below) raises `totalIncome` to cover it.
  const expenseTotal = p.essential + p.discretionary + p.taxes;
  const totalIncome = p.earned + p.withdrawal;
  // Category bands re-segment ONLY the displayed essential+discretionary
  // (taxes stays its own band atop them). `total`/`shortfallHeight`
  // keep using the untouched expenseTotal — never re-summed from
  // `byCategory` — so the stack top stays byte-identical to Total mode.
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

/** One expense bucket in true monthly dollars: the recurring slice
 *  (`recurring − spike`) ÷ `MONTHS_PER_YEAR` plus the literal one-month
 *  `spike`, all deflated by `f`. Shared by `essential` +
 *  `discretionary` so the two buckets cannot drift apart. */
function monthlyBucket(recurring: number, spike: number, f: number): number {
  return ((recurring - spike) / MONTHS_PER_YEAR + spike) * f;
}

/** Engine `perMonthWithdrawal` is already $/month — read it verbatim
 *  (no ×12) at the bounds-checked global month index; 0 when the array
 *  is absent or the index is out of range. */
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

/** The Yearly expense pair the band displays + the expense the
 *  reconcile compares against (in the reconcile's own scale, NOT yet
 *  × `f`). In `'today'` the band reads the real `*Base` fields (no
 *  deflator) and the reconcile compares against the real
 *  `essentialBase + discretionaryBase`; in `'future'` the band is the
 *  nominal split × `f` and the reconcile compares against the **pure
 *  nominal** combined `total` (== the prior page `expensesByYear`
 *  basis; the `× f` is applied once to the reconciled withdrawal →
 *  byte-identical). */
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

/** Displayed Yearly withdrawal via the **unchanged**
 *  `reconcileYearlyCashflow`. Taxes are folded into the `expense`
 *  argument so the funded plug grosses up to `max(0, expense +
 *  taxes − earned)`, reproducing the engine's grossed-up `withdrawn`;
 *  the not-funded branch is unchanged → keeps the engine-actual
 *  `withdrawn` verbatim (already grossed up — no double-count).
 *
 *  Two deflators because the displayed `earned` band and the MC-sourced
 *  taxes/withdrawal use DIFFERENT factors under MC + Today's: the
 *  displayed `earned` stripes (`yearlyIncomeStripes`) deflate by
 *  `fEarned = viewDeflator(y, 11)`, while the taxes + `engineWithdrawn`
 *  originate from the representative MC run and deflate by
 *  `fMc = basisDeflator(y)` (path CPI). Reconciling `earned` at `fMc`
 *  while the band shows it at `fEarned` would break the funded-year
 *  tie-out (`totalIncome ≠ expenseTotal`); so `earned` uses `fEarned`
 *  and the MC fields use `fMc`. Under a deterministic basis / Future
 *  mode `fEarned === fMc`, so this collapses to the prior single factor.
 *
 *  `'today'` runs it on display-resolved inputs (earned Dec-anchored ×
 *  `fEarned`, the real expense basis + `taxNominal × fMc`,
 *  engineWithdrawn × `fMc`) and the result is consumed verbatim.
 *  `'future'` runs it on the pure-nominal inputs (expense + `taxNominal`)
 *  then × `fMc` (== `fEarned` in this mode) — by positive homogeneity
 *  (`reconcile(x·f) == reconcile(x)·f`) this is exactly the prior
 *  page-level `budgetWithdrawalByYear × f` when `taxNominal === 0`
 *  (byte-identical). */
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

/** The per-month expense pair the band displays. `'today'` reads the
 *  real `*Base` fields with deflator factor `1` (entered amount, flat
 *  for a non-glided expense, on the real glide curve for a glided one);
 *  `'future'` is the prior nominal split deflated at `f` (verbatim). */
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

/** Per-month displayed withdrawal. `'future'` is the engine's
 *  own `perMonthWithdrawal[idx] × f`, **not** year-gated (verbatim — the
 *  engine already grossed up the tax draw, so no double-count).
 *  `'today'` is year-gated on the per-year `!depleted` signal: a funded
 *  year is a per-month budget plug `max(0, monthRealExpense +
 *  taxesMonth − dispEarnedMonth)` so the income line covers expenses +
 *  taxes and `shortfallHeight` nets 0; a depleted year keeps the
 *  engine-actual `perMonthWithdrawal[idx] × f` so the genuine per-month
 *  gap surfaces on the real basis. */
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

/** The per-month Dec-anchored income stripes in true monthly dollars:
 *  recurring streams (SS, pension, part-time) ÷ `MONTHS_PER_YEAR`,
 *  one-off / windfall at literal magnitude, all × the December-anchor
 *  factor `f`. `earned` is their sum (excludes `portfolioAdd`,
 *  which is an income-breakdown stripe, not a budget inflow). */
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

/** Per-month `PointInputs` for index `i` — **true monthly dollars**.
 *  Recurring streams (SS, pension, part-time) and the recurring slice
 *  of each expense bucket are ÷ `MONTHS_PER_YEAR`; one-off / windfall
 *  / lump-sum events (spendable one-off, portfolio-add, the
 *  `oneOffEssential`/`oneOffDiscretionary` spike) stay at literal
 *  magnitude in their month. Every month deflates at the December
 *  anchor `viewDeflator(year, 11)` so a flat nominal stream is constant
 *  across all 12 months. In `'today'` the expense band is the real
 *  `*Base` value and the withdrawal is the per-year-gated displayed
 *  plug; in `'future'` it is the prior nominal path verbatim
 *  (engine `perMonthWithdrawal[idx]`, no ×12, not gated). */
function monthlyPointInputs(
  i: number,
  input: CashflowSeriesInput,
  series: NonNullable<CashflowSeriesInput['monthlySeries']>,
): PointInputs {
  const { perMonthWithdrawal, fromYear, viewDeflator, basisDeflator, displayMode } = input;
  const ssRow = series.ssMonths[i];
  const incRow = series.incomeMonths[i];
  // December anchor (RD2): keeps a flat nominal stream constant across
  // all 12 months instead of drifting down within the year.
  const f = viewDeflator(ssRow.year, 11);
  // MC-sourced fields (taxes + withdrawal) deflate by the path's own CPI
  // under an MC basis; `basisDeflator` falls back to `viewDeflator`
  // under a deterministic basis / Future-dollars.
  const fMc = basisDeflator(ssRow.year);
  const stripes = monthlyIncomeStripes(ssRow, incRow, f);
  const monthIdx = (ssRow.year - fromYear) * 12 + ssRow.month0;
  const { essential, discretionary } = resolveMonthlyExpense(
    series.expenseMonths[i],
    displayMode,
    f,
  );
  // Annual tax flat across the 12 months (annual ÷ 12 × fMc, no one-off
  // spike — taxes have no literal one-month magnitude). MC-sourced.
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
  // Per-category share source: the per-category band-basis magnitude
  // via the SAME `monthlyBucket` math the displayed band uses. Only the
  // ratios matter (the residual allocation rescales to the displayed
  // essential+discretionary), so f = 1. The category arrays are projected
  // at the active display mode's inflation by the caller and align with
  // `expenseMonths` index-for-index (same year range, same 12-month loop).
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

/** The per-year Dec-anchored income stripes: each `SourceSplit`
 *  stream × the December-anchor factor `f` for display, plus the
 *  pre-deflation `earnedNominal` sum the unchanged reconcile compares
 *  against. `earned` is the displayed sum (excludes `portfolioAdd`). */
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

/** Per-year `PointInputs` for year `y`. December-anchored
 *  `viewDeflator(y, 11)`. Income / withdrawal / portfolioAdd stay
 *  Dec-anchored flat-nominal in both modes; the expense band reads
 *  the real `*Base` fields in `'today'` and the nominal split × `f` in
 *  `'future'`. The displayed withdrawal/total/shortfall come from the
 *  unchanged `reconcileYearlyCashflow` run here — `pushPoint`
 *  re-derives `totalIncome`/`shortfallHeight` from the same `earned` +
 *  reconciled `withdrawal` so band == table == tooltip. */
function yearlyPointInputs(
  y: number,
  input: CashflowSeriesInput,
  expenseByYear: Map<number, ExpenseProjectionPoint>,
  categoryByYear: Map<number, ExpenseCategoryYearPoint> | null,
): PointInputs {
  const f = input.viewDeflator(y, 11);
  // MC-sourced fields (taxes + withdrawal) deflate by the path's own CPI
  // under an MC basis; `basisDeflator` falls back to `viewDeflator`
  // under a deterministic basis / Future-dollars.
  const fMc = input.basisDeflator(y);
  const { ss, pensionAnnuity, partTime, oneOff, earned, earnedNominal } =
    yearlyIncomeStripes(input.sourceSplitByYear.get(y), f);
  const { essential, discretionary, reconcileExpense } = resolveYearlyExpense(
    expenseByYear.get(y),
    input.displayMode,
    f,
  );
  // Band value: displayed dollars (nominal × `fMc`, mirrors the Tax-Burden
  // chart's MC-basis deflation). The reconcile gets the NOMINAL tax — it
  // applies `fMc` per mode internally.
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
  // Per-category share source: the cadence-correct per-year
  // per-category rollup. Only ratios matter (the residual allocation
  // rescales to the displayed essential+discretionary). The yearly
  // denominator is the aggregated yearly Σ (this map's values), NOT a
  // per-month Σ (math nit). Projected at the active display mode's
  // inflation by the caller.
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
 * Build the trimmed Monthly + Yearly cashflow / income-breakdown
 * series. The page selects one pair by the user's granularity toggle
 * and hands it to the chart components.
 *
 * Death is modelled on Dec 31 of `deathYear`, the terminal year, so the
 * death-year row carries FULL annual values — there is no partial-year
 * proration. The Yearly arrays return the trimmed rows directly (the
 * death-year row is the terminal full-value row); the marker hugs it via
 * each chart's own x-convention.
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
