/** Pure display-data derivation for the Balance Projection page (no React hooks), reusable off the render path by the PDF export; each function reproduces the matching hook memo. Deflation rules: docs/math-projections.md ("Today's dollars and Future dollars"). */
import {
  buildViewDeflator,
  type DisplayMode,
} from '../lib/view-deflator';
import {
  buildAccountBalanceStackHistory,
  latestActualBalanceYear,
} from '../lib/account-balance-stack-history';
import {
  assembleAccountBalanceStackTimeline,
  type AccumulationYearRow,
} from '../lib/account-balance-stack-timeline';
import { DEFAULT_INFLATION_PCT, type Aggregate, type AccountBalancePayload } from '../db/types';
import type {
  ProjectionMethod,
  ProjectionChartRow,
} from '../components/ProjectionChart';
import { deflateChartRows } from './balance-projection-page-pipeline';
import type {
  PipelineData,
  DrawdownByMethodResult,
  McBasis,
  RepresentativeRun,
} from './balance-projection-page-pipeline';
import type { StackBandYear } from './balance-projection-page-account-balance-stack';

/** The flat view deflator: identity in Future dollars or at zero inflation, else the month-precise 1 / (1+i)^t reciprocal. */
export function buildViewDeflatorForExport(
  displayMode: DisplayMode,
  inflationPct: number | null | undefined,
  nowYear: number,
  nowMonthIndex: number,
): (year: number, monthIndex?: number) => number {
  const pct = inflationPct ?? DEFAULT_INFLATION_PCT;
  return buildViewDeflator(displayMode, { nowYear, nowMonthIndex, inflationPct: pct });
}

/** Basis-aware deflator for MC-sourced display dollars: the path's own realFactorByYear under MC + Today's dollars, else viewDeflator(year, 11), never NaN. */
export function buildBasisDeflator(params: {
  readonly isMcBasisActive: boolean;
  readonly displayMode: DisplayMode;
  readonly activeRepresentativeRun: RepresentativeRun | null;
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
}): (year: number) => number {
  const { isMcBasisActive, displayMode, activeRepresentativeRun, viewDeflator } = params;
  const run = activeRepresentativeRun;
  const factors = run?.realFactorByYear;
  const useMcFactor =
    isMcBasisActive && displayMode === 'today' && run != null && factors != null;
  return (year: number): number => {
    if (useMcFactor) {
      const idx = year - run.firstYear;
      if (idx >= 0 && idx < factors.length) {
        const factor = factors[idx];
        if (Number.isFinite(factor) && factor > 0) return factor;
      }
    }
    return viewDeflator(year, 11);
  };
}

export function buildDisplayRows(params: {
  readonly chartRows: ReadonlyArray<ProjectionChartRow>;
  readonly drawdownByMethod:
    | Record<ProjectionMethod, DrawdownByMethodResult | null>
    | null;
  readonly lastDeathYear: number | null;
  readonly retirementYear: number | null;
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  readonly activeRepresentativeRun: RepresentativeRun | null;
  readonly displayMode: DisplayMode;
}): ProjectionChartRow[] {
  return deflateChartRows({
    chartRows: params.chartRows,
    drawdownByMethod: params.drawdownByMethod,
    lastDeathYear: params.lastDeathYear,
    retirementYear: params.retirementYear,
    viewDeflator: params.viewDeflator,
    representativeRun: params.activeRepresentativeRun,
    displayMode: params.displayMode,
  });
}

export function buildAccountStackTimeline(params: {
  readonly data: PipelineData | null;
  readonly canonicalBalances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly isMcBasisActive: boolean;
  readonly activeRepresentativeRun: RepresentativeRun | null;
  readonly activeMethod: ProjectionMethod;
  readonly resolvedDrawdown: DrawdownByMethodResult | null;
  readonly basisDeflator: (year: number) => number;
}): ReadonlyArray<StackBandYear> {
  const {
    data,
    canonicalBalances,
    isMcBasisActive,
    activeRepresentativeRun,
    activeMethod,
    resolvedDrawdown,
    basisDeflator,
  } = params;
  if (!data) return [];
  const historical = buildAccountBalanceStackHistory(
    data.accounts,
    [...canonicalBalances],
  );
  const lastActualYear = latestActualBalanceYear(
    [...canonicalBalances],
    data.accounts,
  );

  let accumulation: AccumulationYearRow[] = [];
  if (isMcBasisActive) {
    accumulation =
      activeRepresentativeRun?.accumulationAccountBalances?.map((a) => ({
        year: a.year,
        accountBalances: a.accountBalances,
      })) ?? [];
  } else {
    const projections = data.pageResult?.sharedCtx.accountProjections ?? [];
    const byYear = new Map<
      number,
      Map<string, { balance: number; preEnd: number; postEnd: number }>
    >();
    for (const proj of projections) {
      const out = proj.outputs[activeMethod];
      if (!out) continue;
      for (const yt of out.yearlyTotals) {
        let m = byYear.get(yt.year);
        if (!m) {
          m = new Map();
          byYear.set(yt.year, m);
        }
        m.set(proj.account.id, {
          balance: yt.preTax + yt.postTax,
          preEnd: yt.preTax,
          postEnd: yt.postTax,
        });
      }
    }
    accumulation = [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, accountBalances]) => ({ year, accountBalances }));
  }

  return assembleAccountBalanceStackTimeline({
    historical,
    accumulation,
    drawdown: resolvedDrawdown?.years ?? [],
    lastActualYear,
    basisDeflator,
  }).rows;
}

/** For an MC basis the representative run adapted so years[0] aligns with fromYear, else drawdownByMethod[activeMethod]. */
export function buildResolvedDrawdown(params: {
  readonly activeMcBasis: McBasis | null;
  readonly activeRepresentativeRun: RepresentativeRun | null;
  readonly drawdownByMethod:
    | Record<ProjectionMethod, DrawdownByMethodResult | null>
    | null;
  readonly activeMethod: ProjectionMethod;
  readonly cashflowFromYear: number | null;
}): DrawdownByMethodResult | null {
  const {
    activeMcBasis,
    activeRepresentativeRun,
    drawdownByMethod,
    activeMethod,
    cashflowFromYear,
  } = params;
  if (!activeMcBasis) return drawdownByMethod?.[activeMethod] ?? null;
  if (!activeRepresentativeRun) return null;
  const run = activeRepresentativeRun;
  const fromYear = cashflowFromYear;
  if (fromYear == null || fromYear <= run.firstYear) return run;
  return {
    years: run.years.slice(fromYear - run.firstYear),
    depletionYear: run.depletionYear,
    perMonthWithdrawal: run.perMonthWithdrawal,
  };
}
