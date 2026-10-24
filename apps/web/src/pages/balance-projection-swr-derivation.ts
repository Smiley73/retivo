/** Basis-aware safe-withdrawal-rate data layer: portfolio at retirement, four-layer spending series and 4%/4.5% rule figures. */
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
  readonly cashflowFromYear: number | null;
  readonly drawdownByMethod:
    | Record<ProjectionMethod, DrawdownByMethodResult | null>
    | null;
  readonly activeRepresentativeRun: RepresentativeRun | null;
  readonly isMcBasisActive: boolean;
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  /** Always Today's dollars, independent of the display toggle: seeds the real rule figures and re-inflates them per row in Future dollars. */
  readonly realDeflator: (year: number, monthIndex?: number) => number;
  readonly yearlyCashflowByYear: ReadonlyMap<number, CashflowMonthlyPoint> | null;
  readonly drawdownEndYear: number | null;
  readonly depletionYear: number | null;
  /** Used only to detect state (5): every row's tax cents undefined. */
  readonly resolvedDrawdownYears: ReadonlyArray<DrawdownYear> | null;
  readonly sourceSplitByYear: ReadonlyMap<number, SourceSplit> | null;
  readonly primaryRetirementIso: string | null;
}

function noResult(state: Exclude<SwrComparisonState, 'ok'>): SwrComparisonResult {
  return { state, bundle: null };
}

// Multiplier turning a nominal amount for `year` into today's dollars: the MC run's own path CPI, else the scenario's flat inflation. Mode-independent.
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

// Re-express the real rule figures in the active display mode so the bundle scalars agree with the rows and anchorAfterTaxDraw under Future dollars.
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

  // State 2 gates every basis: without a retirement year the deflators collapse to the identity.
  if (primaryRetirementYear === null) return noResult('no-retirement-year');

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
    if (!activeRepresentativeRun) return noResult('mc-run-unavailable');
    // Read the run's last accumulation-phase year-end: its retirement-year row is struck after that year's withdrawals.
    // The CBP exclusion is not re-applied; the run's own ledger already is the portfolio and subtracting again would double-count.
    const idx = primaryRetirementYear - activeRepresentativeRun.firstYear - 1;
    if (idx < 0) return noResult('mc-index-out-of-range');
    const real = activeRepresentativeRun.realBalanceByYear[idx];
    const nominal = activeRepresentativeRun.years[idx]?.balance;
    if (!Number.isFinite(real) || nominal === undefined || !Number.isFinite(nominal)) {
      return noResult('mc-index-out-of-range');
    }
    realPortfolio = real;
    displayedPortfolio = displayMode === 'today' ? real : nominal;
  } else {
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

  // First full retirement year: a transition-year total is partial unless retirement is January 1.
  const isJanFirst =
    primaryRetirementIso !== null && primaryRetirementIso.slice(5, 10) === '01-01';
  const anchorYear = isJanFirst ? cashflowFromYear : cashflowFromYear + 1;
  // No full retirement year in the window (a mid-year retirement ending in its own transition year): emit a distinct marker, not an `ok` bundle with a fabricated anchor of 0.
  if (anchorYear > drawdownEndYear) return noResult('no-full-retirement-year');
  const valuationYear = isMcBasisActive
    ? primaryRetirementYear - 1
    : cashflowFromYear;
  const valuationOffsetYears = anchorYear - valuationYear;

  // State 5 checks the raw engine rows (undefined for an MC successOnly capture), since the clamped-to-0 taxes cannot tell "no data" from zero tax.
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
    // The band goes negative in a year the ACA credit lowered the draw; only the reported tax layer is floored at 0.
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

    // Coverage cap: guaranteed income never exceeds planned spend, so guaranteed + other + draw equals plannedSpendOnly in any funded year.
    const guaranteedIncome = Math.min(Math.max(0, guaranteedRaw), plannedSpendOnly);
    // The need is planned spend plus the tax the draw funds, or a funded SS/pension year with tax would report surplus the draw actually needed.
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

  // Seed the rules with the anchor year's real after-tax draw; they are compared against it alone, not the stack total or gross withdrawal.
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
