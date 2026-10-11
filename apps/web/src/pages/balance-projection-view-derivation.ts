/**
 * Balance Projection — PURE display-data derivation (no React hooks).
 *
 * Extracted from `use-balance-projection-view-model.ts` so the same display-
 * ready transforms the page renders from can be reused off the render path
 * (the unified PDF export). Every function here is a pure transform over
 * its explicit inputs — no `useState` / `useEffect` / `useCallback` / React
 * hook of any kind. The hook keeps its stateful machinery (reroll state, the
 * MC-basis reset effect, method fallback, the stress VM, chart-color markers)
 * and calls these pure functions for the memoized derivations.
 *
 * The extraction is BEHAVIOR-NEUTRAL: each function reproduces the exact body
 * the hook's matching `useMemo` ran, so the hook's return value is bit-
 * identical before and after the refactor.
 *
 * The deflation and display-mode rules it implements are described in
 * docs/math-projections.md ("Today's dollars and Future dollars").
 */
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
import type { CashflowSeriesPipelineResult } from './balance-projection-page-cashflow';
import {
  buildIncomeView,
  buildUnifiedYearTableRows,
  buildPortfolioFlowsByYear,
  type IncomeView,
  type PortfolioFlowYear,
} from './balance-projection-page-yearly-builders';
import type { CashflowGranularity } from '../lib/view-deflator';
import type { YearlyTableRow } from './balance-projection-page-yearly';
import type { StackBandYear } from './balance-projection-page-account-balance-stack';

/**
 * Build the page's flat view deflator (mirrors the hook's `viewDeflator`
 * memo). Identity in Future-dollars / zero-inflation; the month-precise
 * `1 / (1+i)^t` reciprocal otherwise.
 */
export function buildViewDeflatorForExport(
  displayMode: DisplayMode,
  inflationPct: number | null | undefined,
  nowYear: number,
  nowMonthIndex: number,
): (year: number, monthIndex?: number) => number {
  const pct = inflationPct ?? DEFAULT_INFLATION_PCT;
  return buildViewDeflator(displayMode, { nowYear, nowMonthIndex, inflationPct: pct });
}

/**
 * Build the basis-aware deflator for MC-sourced display dollars (mirrors the
 * hook's `basisDeflator` memo). Under an MC basis + Today's-dollars, a year in
 * the run's horizon resolves to the path's own `realFactorByYear`; otherwise
 * it falls back to the flat `viewDeflator(year, 11)`, never NaN.
 */
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

/**
 * Deflate the chart rows into the active display basis (mirrors the hook's
 * `displayRows` memo).
 */
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

/**
 * Assemble the unified, display-deflated "Account balances over time"
 * timeline (mirrors the hook's `accountStackTimeline` memo). Accumulation
 * source: the MC representative run's `accumulationAccountBalances` under an MC
 * basis, else the deterministic per-account projection.
 */
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

/**
 * Resolve the per-year drawdown (mirrors the hook's `resolvedDrawdown` memo):
 * for an MC basis the representative run ADAPTED so `years[0]` aligns with
 * `fromYear`, else the deterministic `drawdownByMethod[activeMethod]`.
 */
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

/** Everything the page (and the PDF export) needs in display-ready form. */
export interface BalanceProjectionDisplayData {
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  readonly basisDeflator: (year: number) => number;
  readonly isMcBasisActive: boolean;
  readonly displayRows: ReadonlyArray<ProjectionChartRow>;
  readonly resolvedDrawdown: DrawdownByMethodResult | null;
  readonly incomeView: IncomeView | null;
  readonly unifiedYearTableRows: ReadonlyArray<YearlyTableRow>;
  readonly portfolioFlowsByYear: ReadonlyArray<PortfolioFlowYear> | null;
  readonly accountStackTimeline: ReadonlyArray<StackBandYear>;
}

/**
 * One-call PURE derivation of the page's display-ready bundle. Takes the
 * resolved inputs the hook already holds (no React hooks) and runs the same
 * sequence of pure builders the hook's memos run, in the same order, so the
 * returned values are identical to the hook's. Off-render consumers (the PDF
 * export) call this directly.
 *
 * Note the data-flow ordering matches the hook: `viewDeflator` →
 * `basisDeflator` → `resolvedDrawdown` → `incomeView` → `displayRows` →
 * `unifiedYearTableRows` → `portfolioFlowsByYear` → `accountStackTimeline`.
 */
// Shape-limit waiver: this function is a flat sequential orchestration of 6 pure builder
// calls in hook-memo order — splitting would add indirection without reducing complexity.
export function deriveBalanceProjectionDisplayData(params: {
  readonly data: PipelineData | null;
  readonly canonicalBalances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly displayMode: DisplayMode;
  readonly cashflowGranularity: CashflowGranularity;
  readonly incomeBreakdownGranularity: CashflowGranularity;
  readonly activeMethod: ProjectionMethod;
  readonly activeMcBasis: McBasis | null;
  readonly nowYear: number;
  readonly nowMonthIndex: number;
  /** Pre-built chart rows (the hook's `chartRows` memo). */
  readonly chartRows: ReadonlyArray<ProjectionChartRow>;
  /** The hook's `cashflowSeries` memo result. */
  readonly cashflowSeries: CashflowSeriesPipelineResult | null;
  readonly drawdownByMethod:
    | Record<ProjectionMethod, DrawdownByMethodResult | null>
    | null;
  readonly activeRepresentativeRun: RepresentativeRun | null;
  readonly lastDeathYear: number | null;
  readonly lastDeathFractional: number | null;
  readonly retirementYear: number | null;
  /** Active expense categories (id / name / colour) for the cashflow "by
   *  category" mode, threaded into `buildIncomeView`. Optional;
   *  omitted / empty ⇒ no `categoryBand` (the essential/discretionary stack),
   *  matching the hook when "by category" mode is off. */
  readonly categoryMeta?: ReadonlyArray<{ id: string; name: string; color: string }>;
}): BalanceProjectionDisplayData {
  const {
    data,
    canonicalBalances,
    displayMode,
    cashflowGranularity,
    incomeBreakdownGranularity,
    activeMethod,
    activeMcBasis,
    nowYear,
    nowMonthIndex,
    chartRows,
    cashflowSeries,
    drawdownByMethod,
    activeRepresentativeRun,
    lastDeathYear,
    lastDeathFractional,
    retirementYear,
    categoryMeta = [],
  } = params;

  const isMcBasisActive = activeMcBasis !== null;

  const viewDeflator = buildViewDeflatorForExport(
    displayMode,
    data?.resolved.inflation?.ratePct,
    nowYear,
    nowMonthIndex,
  );

  const basisDeflator = buildBasisDeflator({
    isMcBasisActive,
    displayMode,
    activeRepresentativeRun,
    viewDeflator,
  });

  const resolvedDrawdown = buildResolvedDrawdown({
    activeMcBasis,
    activeRepresentativeRun,
    drawdownByMethod,
    activeMethod,
    cashflowFromYear: cashflowSeries?.fromYear ?? null,
  });

  const incomeView = buildIncomeView({
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
    // Threaded from the params (defaults to `[]` for the export path, which uses
    // yearly granularity with no per-category bands — cashflow stays Total-only).
    categoryMeta,
  });

  const displayRows = buildDisplayRows({
    chartRows,
    drawdownByMethod,
    lastDeathYear,
    retirementYear,
    viewDeflator,
    activeRepresentativeRun,
    displayMode,
  });

  const unifiedYearTableRows = buildUnifiedYearTableRows({
    displayRows,
    cashflowSeries,
    incomeView,
    drawdownByMethod,
    activeMethod,
    activeMcBasis,
    resolvedDrawdown,
    lastDeathFractional,
    basisDeflator,
  });

  const portfolioFlowsByYear = buildPortfolioFlowsByYear({
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
  });

  const accountStackTimeline = buildAccountStackTimeline({
    data,
    canonicalBalances,
    isMcBasisActive,
    activeRepresentativeRun,
    activeMethod,
    resolvedDrawdown,
    basisDeflator,
  });

  return {
    viewDeflator,
    basisDeflator,
    isMcBasisActive,
    displayRows,
    resolvedDrawdown,
    incomeView,
    unifiedYearTableRows,
    portfolioFlowsByYear,
    accountStackTimeline,
  };
}
