/**
 * Balance Projection page — basis-aware safe-withdrawal-rate (SWR) data
 * layer.
 *
 * Pure builder (plain params in, plain data out, no hooks, no React) beside
 * `balance-projection-view-derivation.ts` and following its shape, so tests
 * and any later export path can reuse it. The page-local hook
 * `use-balance-projection-swr-data.ts` adapts the view model onto this.
 *
 * Resolves, for the page's ACTIVE basis + dollar mode:
 *  1. portfolio at retirement — the net figure (annuity-elected and
 *     pre-retirement-lump-sum-elected Cash Balance Pension accounts excluded),
 *     not the plain summed total;
 *  2. a per-year four-layer spending series over the page's
 *     drawdown/cash-flow window;
 *  3. the 4% / 4.5% rule figures (`lib/safe-withdrawal-rate.ts`, unchanged)
 *     against the after-tax draw layer at the first FULL retirement year;
 *  4. the degenerate states below, each distinct.
 *
 * ## The pre-drawdown instant, and the valuation offset
 *
 * Under an MC tier the portfolio figure is the active representative run's
 * OWN balance, read at the run's LAST ACCUMULATION-PHASE year-end —
 * index `retirementYear - run.firstYear - 1` — not at the retirement year
 * itself: a captured run's retirement-year row is a year-END balance struck
 * AFTER that year's withdrawals, which would value the portfolio a full
 * drawdown year later than Planned/Historical do. Today's-dollars reads
 * `run.realBalanceByYear[idx]` (deflated by the path's own CPI);
 * future-dollars reads `run.years[idx].balance` (nominal). The exclusion is
 * NOT re-applied here — the run's own ledger IS the portfolio, and
 * subtracting again would double-count. (Verification that the ledger
 * already excludes those accounts lives in this module's test suite, not
 * as a runtime adjustment.)
 *
 * The deterministic figure is struck at the retirement MONTH and displayed
 * at December of the retirement year; the MC figure is December of the
 * year BEFORE. They coincide for a January retirement and otherwise differ
 * by the accumulation months of the retirement year — `valuationOffsetYears`
 * on the bundle surfaces that gap so the SWR tab can word its valuation-date disclosure.
 *
 * ## The four-layer split
 *
 * Every figure comes from rows the page already carries; this module
 * computes no tax of its own. Gross withdrawal + the tax layer are read off
 * `IncomeView.yearlyCashflowByYear` — the SAME `CashflowMonthlyPoint` the
 * Cash flow band renders (`withdrawal` via `reconcileDisplayedWithdrawal`,
 * `taxes` via the same `taxCashByYear` formula `buildTaxBurdenRows` sums) —
 * so this module never recomputes either and cannot disagree with the Cash
 * flow / Taxes tabs for the same year. Guaranteed + other income come off
 * `sourceSplitByYear` (SS + pension vs. part-time + one-off), deflated by
 * `viewDeflator(year, 11)` — the same factor the displayed earned stripes
 * use — and capped so the four layers never exceed planned spend + tax
 * (`CashflowMonthlyPoint.total`).
 *
 * ## Rule lines across both dollar modes
 *
 * The rule constant is real by construction: it is always seeded from
 * a genuinely REAL (today's-dollars) portfolio and planned-spend figure,
 * via `realDeflator` — a Today's-dollars deflator built independently of
 * the page's ACTIVE display mode (`viewDeflator` collapses to the identity
 * under Future-dollars, which would otherwise make the rule line silently
 * flat NOMINAL — the error this seeding exists to avoid). Under
 * Today's-dollars the real value IS the displayed value. Under
 * Future-dollars each row re-expresses the flat real figure into that
 * year's nominal terms, using the SAME real/nominal relationship the
 * after-tax draw layer carries that year (the run's own path CPI under an
 * MC tier, the scenario's flat inflation otherwise) — never a second
 * multiplication site; `lib/safe-withdrawal-rate.ts` still owns the one
 * rate × portfolio multiplication. The bundle's own `fourPercentRule` /
 * `fourPointFivePercentRule` scalars are re-expressed the SAME way at the
 * anchor year before they're exposed (`ruleFiguresForDisplay`) — they must
 * agree with `rows[].fourPercentRuleValue` at that year and with
 * `anchorAfterTaxDraw`, both already in the active display mode; only the
 * `rules` local (seeded into the per-row conversion) stays real.
 */
import type { ProjectionMethod } from '../components/ProjectionChart';
import type { DisplayMode } from '../lib/view-deflator';
import type { CashflowMonthlyPoint } from '../components/CashflowProjectionChart';
import type { SourceSplit } from '../lib/cashflow-series';
import type { DrawdownYear } from '../lib/drawdown-engine';
import {
  computeSafeWithdrawalRuleComparison,
  type SafeWithdrawalRuleComparison,
  type SafeWithdrawalRuleFigures,
} from '../lib/safe-withdrawal-rate';
import type {
  SwrComparisonBundle,
  SwrComparisonResult,
  SwrComparisonState,
  SwrComparisonYearRow,
} from '../lib/safe-withdrawal-rate-chart-types';
import type {
  DrawdownByMethodResult,
  McBasis,
  RepresentativeRun,
} from './balance-projection-page-data';

export interface BuildSwrComparisonDataParams {
  readonly displayMode: DisplayMode;
  readonly activeMethod: ProjectionMethod;
  readonly activeMcBasis: McBasis | null;
  readonly enabledCalculatedMethods: ReadonlySet<Exclude<ProjectionMethod, 'planned'>>;
  readonly primaryRetirementYear: number | null;
  /** The retirement TRANSITION year — the window's first year. */
  readonly cashflowFromYear: number | null;
  readonly drawdownByMethod:
    | Record<ProjectionMethod, DrawdownByMethodResult | null>
    | null;
  readonly activeRepresentativeRun: RepresentativeRun | null;
  readonly isMcBasisActive: boolean;
  /** Mode-aware (page-ACTIVE) deflator — guaranteed/other income layers, and
   *  the deterministic-basis portfolio's DISPLAYED (card) figure. */
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  /** ALWAYS Today's-dollars, independent of the page's active toggle — seeds
   *  the rule figures with a genuinely real portfolio + planned spend, and
   *  re-inflates the flat real rule value into each row's Future-dollars
   *  terms (see module docblock). */
  readonly realDeflator: (year: number, monthIndex?: number) => number;
  /** The page's already-resolved per-year cashflow rows (`vm.incomeView.
   *  yearlyCashflowByYear`) — `withdrawal` / `taxes` / `total` per year,
   *  basis-and-mode-aware, the SAME object the Cash flow band renders. */
  readonly yearlyCashflowByYear: ReadonlyMap<number, CashflowMonthlyPoint> | null;
  /** The window's last year (`vm.incomeView.drawdownEndYear`) — already
   *  death-year-clipped with the MC drawdown-phase filter applied. */
  readonly drawdownEndYear: number | null;
  /** `vm.incomeView.depletionYear` — carried through, not re-derived. */
  readonly depletionYear: number | null;
  /** The resolved drawdown's RAW rows (`vm.resolvedDrawdown.years`) — used
   *  only to detect state (5): every row's tax cents fields `undefined`. */
  readonly resolvedDrawdownYears: ReadonlyArray<DrawdownYear> | null;
  /** SS / pension / part-time / one-off per year, NOMINAL — the single
   *  source `viewDeflator(year, 11)` deflates into the guaranteed/other
   *  layers. */
  readonly sourceSplitByYear: ReadonlyMap<number, SourceSplit> | null;
  /** The primary's retirement ISO date (`YYYY-MM-DD`) — resolves the anchor
   *  year (the transition year itself iff January 1). */
  readonly primaryRetirementIso: string | null;
}

function noResult(state: Exclude<SwrComparisonState, 'ok'>): SwrComparisonResult {
  return { state, bundle: null };
}

/** The multiplier that turns a NOMINAL dollar amount for `year` into its
 *  REAL (today's-dollars) equivalent — the active representative run's own
 *  path CPI under an MC tier, the scenario's flat inflation otherwise.
 *  Mode-independent (unlike `viewDeflator`/`basisDeflator`, which collapse
 *  to the identity under Future-dollars). */
function realConversionFactor(
  year: number,
  isMcBasisActive: boolean,
  activeRepresentativeRun: RepresentativeRun | null,
  realDeflator: (year: number, monthIndex?: number) => number,
): number {
  if (isMcBasisActive && activeRepresentativeRun) {
    const idx = year - activeRepresentativeRun.firstYear;
    const factor = activeRepresentativeRun.realFactorByYear[idx];
    if (idx >= 0 && Number.isFinite(factor) && factor > 0) return factor;
  }
  return realDeflator(year, 11);
}

/** Re-express a flat REAL rule value into `year`'s DISPLAYED (active-mode)
 *  terms: unchanged under Today's-dollars; inflated forward under
 *  Future-dollars by the reciprocal of `realConversionFactor`. */
function ruleValueForYear(
  realValue: number,
  year: number,
  displayMode: DisplayMode,
  isMcBasisActive: boolean,
  activeRepresentativeRun: RepresentativeRun | null,
  realDeflator: (year: number, monthIndex?: number) => number,
): number {
  if (displayMode === 'today') return realValue;
  const factor = realConversionFactor(year, isMcBasisActive, activeRepresentativeRun, realDeflator);
  return factor > 0 ? realValue / factor : realValue;
}

/** Re-express one rule's REAL figures (from `lib/safe-withdrawal-rate.ts`,
 *  unchanged as the arithmetic source) into the bundle's ACTIVE display
 *  mode at the anchor year — otherwise the bundle scalar disagrees with the
 *  SAME rule's `rows[].fourPercentRuleValue` at the anchor year, and with
 *  `anchorAfterTaxDraw`, under Future-dollars. */
function ruleFiguresForDisplay(
  real: SafeWithdrawalRuleFigures,
  anchorYear: number,
  anchorAfterTaxDrawDisplayed: number,
  displayMode: DisplayMode,
  isMcBasisActive: boolean,
  activeRepresentativeRun: RepresentativeRun | null,
  realDeflator: (year: number, monthIndex?: number) => number,
): SafeWithdrawalRuleFigures {
  const impliedFirstYearAnnualSpend = ruleValueForYear(
    real.impliedFirstYearAnnualSpend,
    anchorYear,
    displayMode,
    isMcBasisActive,
    activeRepresentativeRun,
    realDeflator,
  );
  return {
    ratePct: real.ratePct,
    impliedFirstYearAnnualSpend,
    lineValuesByYear: real.lineValuesByYear.map((entry) => ({
      year: entry.year,
      value: ruleValueForYear(
        entry.value,
        entry.year,
        displayMode,
        isMcBasisActive,
        activeRepresentativeRun,
        realDeflator,
      ),
    })),
    // Re-derived against the DISPLAYED anchor draw and the now-displayed
    // implied spend, so the sign/magnitude agree with what the row/card
    // actually render (rather than carrying the real-dollar delta forward).
    plannedMinusRuleFirstYearDelta: anchorAfterTaxDrawDisplayed - impliedFirstYearAnnualSpend,
  };
}

export function buildSwrComparisonData(
  params: BuildSwrComparisonDataParams,
): SwrComparisonResult {
  const {
    displayMode,
    activeMethod,
    activeMcBasis,
    enabledCalculatedMethods,
    primaryRetirementYear,
    cashflowFromYear,
    drawdownByMethod,
    activeRepresentativeRun,
    isMcBasisActive,
    viewDeflator,
    realDeflator,
    yearlyCashflowByYear,
    drawdownEndYear,
    depletionYear,
    resolvedDrawdownYears,
    sourceSplitByYear,
    primaryRetirementIso,
  } = params;

  // State 2 — gates every basis: without a retirement year the deflators
  // collapse to the identity and no figure emitted here would be real.
  if (primaryRetirementYear === null) return noResult('no-retirement-year');

  // State 3 — Historical selected but the runner reports no usable history.
  if (
    activeMcBasis === null &&
    activeMethod === 'twr' &&
    !enabledCalculatedMethods.has('twr')
  ) {
    return noResult('historical-unavailable');
  }

  let realPortfolio: number;
  let displayedPortfolio: number;

  if (isMcBasisActive) {
    // State 4 — the tier's representative run hasn't arrived (not yet run,
    // running, stale, errored, or suppressed by a CBP config error).
    if (!activeRepresentativeRun) return noResult('mc-run-unavailable');
    // The run's LAST ACCUMULATION-PHASE year-end — a captured run's
    // retirement-year row is already a year-END balance struck AFTER that
    // year's withdrawals.
    const idx = primaryRetirementYear - activeRepresentativeRun.firstYear - 1;
    // State 6 — the run's first year IS the retirement year (a household
    // retiring now): no accumulation year-end exists to read.
    if (idx < 0) return noResult('mc-index-out-of-range');
    const real = activeRepresentativeRun.realBalanceByYear[idx];
    const nominal = activeRepresentativeRun.years[idx]?.balance;
    if (!Number.isFinite(real) || nominal === undefined || !Number.isFinite(nominal)) {
      return noResult('mc-index-out-of-range');
    }
    realPortfolio = real;
    displayedPortfolio = displayMode === 'today' ? real : nominal;
  } else {
    // State 1 — no runner result for this method (zero/negative net
    // portfolio, missing custom order, MAGI-cap calibration failure, or an
    // unconfigured CBP election).
    const methodResult = drawdownByMethod?.[activeMethod] ?? null;
    if (!methodResult || methodResult.netPortfolioAtRetirement === undefined) {
      return noResult('no-runner-result');
    }
    const netFigureNominal = methodResult.netPortfolioAtRetirement;
    realPortfolio = netFigureNominal * realDeflator(primaryRetirementYear, 11);
    displayedPortfolio = netFigureNominal * viewDeflator(primaryRetirementYear, 11);
  }

  if (!yearlyCashflowByYear || cashflowFromYear === null || drawdownEndYear === null) {
    return noResult('no-runner-result');
  }

  // The first FULL retirement year — the transition year itself iff
  // the retirement date is January 1, otherwise transition + 1 (a
  // calendar-year total for the transition year is a partial-year figure
  // whenever retirement starts after January 1).
  const isJanFirst =
    primaryRetirementIso !== null && primaryRetirementIso.slice(5, 10) === '01-01';
  const anchorYear = isJanFirst ? cashflowFromYear : cashflowFromYear + 1;
  // No FULL retirement year inside the window: a mid-year retirement whose
  // window ends in the transition year itself (the last death year IS the
  // retirement year — retirement age and life expectancy both 100 reaches
  // this from the UI), or a window that closes before it even starts. No row
  // could carry the anchor draw, so there is no first-year spend to compare
  // and nothing to measure a rule delta against — a distinct marker, never
  // an `ok` bundle whose anchor scalar is the loop initialiser's `0` and
  // whose rule deltas are struck against that fabricated figure.
  if (anchorYear > drawdownEndYear) return noResult('no-full-retirement-year');
  // Whole calendar years between the portfolio's valuation instant
  // (December of the retirement transition year, deterministic; December of
  // the year BEFORE, under MC — the same year `idx` reads above) and the
  // spend series' first (anchor) point.
  const valuationYear = isMcBasisActive
    ? primaryRetirementYear - 1
    : cashflowFromYear;
  const valuationOffsetYears = anchorYear - valuationYear;

  // State 5 — no row in the window carries a tax figure at all (optional on
  // `DrawdownYear`; an MC `successOnly` capture skips the replay that
  // populates them). Checked against the RAW engine rows, not the already-
  // clamped-to-0 `taxes` dollar figure, which cannot tell "no data" apart
  // from "genuinely zero tax".
  const noTaxFigures =
    !resolvedDrawdownYears ||
    !resolvedDrawdownYears.some(
      (y) =>
        y.year >= cashflowFromYear &&
        y.year <= drawdownEndYear &&
        (y.federalTaxCents !== undefined ||
          y.irmaaSurchargeCents !== undefined ||
          y.acaPtcSubsidyCents !== undefined),
    );

  interface RowBase {
    readonly year: number;
    readonly guaranteedIncome: number;
    readonly otherIncome: number;
    readonly afterTaxDraw: number;
    readonly tax: number;
    readonly guaranteedIncomeSplit: { readonly socialSecurity: number; readonly pension: number };
    readonly guaranteedIncomeSurplus: number;
    readonly isPartialYear: boolean;
  }
  const baseRows: RowBase[] = [];
  let anchorAfterTaxDrawDisplayed = 0;

  for (let year = cashflowFromYear; year <= drawdownEndYear; year += 1) {
    const cfRow = yearlyCashflowByYear.get(year);
    const grossWithdrawal = cfRow?.withdrawal ?? 0;
    // The band is negative in a year the ACA credit lowered the draw; the
    // arithmetic keeps that sign so the draw is still the spending it funds,
    // and only the reported tax layer is floored at 0.
    const netTax = noTaxFigures ? 0 : (cfRow?.taxes ?? 0);
    const tax = Math.max(0, netTax);
    const afterTaxDraw = Math.max(0, grossWithdrawal - netTax);
    const plannedSpendOnly = Math.max(0, (cfRow?.total ?? 0) - netTax);

    const split = sourceSplitByYear?.get(year);
    const f = viewDeflator(year, 11);
    const ssRaw = (split?.ss ?? 0) * f;
    const pensionRaw = (split?.pensionAnnuity ?? 0) * f;
    const guaranteedRaw = ssRaw + pensionRaw;
    const otherRaw = ((split?.partTime ?? 0) + (split?.oneOff ?? 0)) * f;

    // Coverage cap: guaranteed income never draws more than the year's
    // planned spend; other income fills only what guaranteed didn't cover;
    // both portfolio layers are floored at 0 by construction above. This
    // keeps `guaranteed + other + draw === plannedSpendOnly` exactly in any
    // funded year (the engine's own `reconcileDisplayedWithdrawal` already
    // guarantees `draw = plannedSpendOnly - guaranteedRaw - otherRaw` there).
    const guaranteedIncome = Math.min(Math.max(0, guaranteedRaw), plannedSpendOnly);
    // The year's genuine need is planned spend PLUS the tax the draw funds
    // (not plannedSpendOnly alone) — otherwise a funded SS/pension year with
    // non-zero federal tax/IRMAA reports guaranteed income as "surplus" that
    // the portfolio draw actually needed to cover that same year's tax.
    const guaranteedIncomeSurplus = Math.max(0, guaranteedRaw - (plannedSpendOnly + netTax));
    const guaranteedScale = guaranteedRaw > 0 ? guaranteedIncome / guaranteedRaw : 0;
    const remainingAfterGuaranteed = Math.max(0, plannedSpendOnly - guaranteedIncome);
    const otherIncome = Math.min(Math.max(0, otherRaw), remainingAfterGuaranteed);

    const isPartialYear = year === cashflowFromYear && year !== anchorYear;

    baseRows.push({
      year,
      guaranteedIncome,
      otherIncome,
      afterTaxDraw,
      tax,
      guaranteedIncomeSplit: {
        socialSecurity: ssRaw * guaranteedScale,
        pension: pensionRaw * guaranteedScale,
      },
      guaranteedIncomeSurplus,
      isPartialYear,
    });

    if (year === anchorYear) anchorAfterTaxDrawDisplayed = afterTaxDraw;
  }

  // Seed the rule arithmetic with the anchor year's REAL after-tax draw
  // (the rules are compared against the after-tax draw alone, never
  // the stack total or the gross withdrawal).
  const anchorAfterTaxDrawReal =
    displayMode === 'today'
      ? anchorAfterTaxDrawDisplayed
      : anchorAfterTaxDrawDisplayed *
        realConversionFactor(anchorYear, isMcBasisActive, activeRepresentativeRun, realDeflator);

  const rules: SafeWithdrawalRuleComparison = computeSafeWithdrawalRuleComparison({
    portfolioAtRetirement: realPortfolio,
    years: [anchorYear],
    plannedFirstYearAnnualSpend: anchorAfterTaxDrawReal,
  });

  const rows: SwrComparisonYearRow[] = baseRows.map((row) => {
    const compared = row.year >= anchorYear;
    return {
      ...row,
      fourPercentRuleValue: compared
        ? ruleValueForYear(
            rules.fourPercentRule.impliedFirstYearAnnualSpend,
            row.year,
            displayMode,
            isMcBasisActive,
            activeRepresentativeRun,
            realDeflator,
          )
        : null,
      fourPointFivePercentRuleValue: compared
        ? ruleValueForYear(
            rules.fourPointFivePercentRule.impliedFirstYearAnnualSpend,
            row.year,
            displayMode,
            isMcBasisActive,
            activeRepresentativeRun,
            realDeflator,
          )
        : null,
    };
  });

  // The bundle's rule scalars must agree with `rows[].fourPercentRuleValue`
  // at the anchor year and with `anchorAfterTaxDraw` — both already in the
  // ACTIVE display mode — so `rules.fourPercentRule`/`.fourPointFivePercentRule`
  // (real-dollar by construction) are re-expressed for display here, never
  // exposed verbatim.
  const fourPercentRuleDisplayed = ruleFiguresForDisplay(
    rules.fourPercentRule,
    anchorYear,
    anchorAfterTaxDrawDisplayed,
    displayMode,
    isMcBasisActive,
    activeRepresentativeRun,
    realDeflator,
  );
  const fourPointFivePercentRuleDisplayed = ruleFiguresForDisplay(
    rules.fourPointFivePercentRule,
    anchorYear,
    anchorAfterTaxDrawDisplayed,
    displayMode,
    isMcBasisActive,
    activeRepresentativeRun,
    realDeflator,
  );

  const bundle: SwrComparisonBundle = {
    rows,
    portfolioAtRetirement: displayedPortfolio,
    anchorYear,
    anchorAfterTaxDraw: anchorAfterTaxDrawDisplayed,
    fourPercentRule: fourPercentRuleDisplayed,
    fourPointFivePercentRule: fourPointFivePercentRuleDisplayed,
    depletionYear,
    noTaxFigures,
    valuationOffsetYears,
  };
  return { state: 'ok', bundle };
}
