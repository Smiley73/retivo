/** Derived view-model hook for the Balance Projection page: deflators, markers, chart rows, cashflow, drawdown and strategy resolution. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { McBasis, RepresentativeRun } from '../lib/monte-carlo';
import { pickBandIndex } from '../lib/monte-carlo-summary';
import {
  type CashflowGranularity,
  type DisplayMode,
} from '../lib/view-deflator';
import { validateCbpResolution } from '../lib/cbp-resolution';
import {
  usePlanStressTestVm,
  type PlanStressTestExtras,
  type PlanStressTestVm,
} from '../components/PlanStressTestSection';
import type { CashflowChartMarker } from '../components/CashflowProjectionChart';
import type {
  ProjectionMethod,
  ProjectionChartRow,
  RetirementMarker,
} from '../components/ProjectionChart';
import type { TooltipMember } from '../components/tooltip-member';
import {
  isMagiCapDisabled,
  type Aggregate,
  type HouseholdMemberPayload,
  type IncomeStreamPayload,
  type AccountBalancePayload,
  type ExpensePayload,
  type ExpenseCategoryPayload,
  type SocialSecurityBenefitPayload,
} from '../db/types';
import {
  assembleCategoryMeta,
  type CategoryMeta,
} from '../lib/category-palette';
import { useChartColors } from '../lib/use-chart-tokens';
import {
  buildExpenseDeathMarkers,
  resolveLastSurvivor,
  buildRetirementMarkers,
  primaryRetirementBoundary,
} from './balance-projection-page-markers';
import {
  buildYearlyChartRows,
  computeMethodTotal,
  type BalanceProjectionMethodTotal,
  type BreakdownAccountRow,
  type YearlyTableRow,
} from './balance-projection-page-yearly';
import { buildPageCashflowSeries } from './balance-projection-page-cashflow';
import {
  drawdownByMethodFromPageResult,
  representativeByBasisFromSummary,
  type PipelineData,
  type DrawdownByMethodResult,
} from './balance-projection-page-data';
import {
  buildIncomeView,
  buildUnifiedYearTableRows,
  buildPortfolioFlowsByYear,
  type IncomeView,
  type PortfolioFlowYear,
} from './balance-projection-page-yearly-builders';
import { resolveScenario } from '../lib/scenario-resolution';
import type { RunBalanceProjectionArgs } from '../lib/balance-projection-runner-types';
import { latestActualBalanceYear } from '../lib/account-balance-stack-history';
import type { StackBandYear } from './balance-projection-page-account-balance-stack';
import {
  buildViewDeflatorForExport,
  buildBasisDeflator,
  buildDisplayRows,
  buildAccountStackTimeline,
  buildResolvedDrawdown,
} from './balance-projection-view-derivation';

export interface BalanceProjectionViewModel {
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  /** Deflator for MC-sourced display dollars: the run's own path CPI under an MC basis + Today's dollars, else `viewDeflator(year, 11)`. Keyed by calendar year, never NaN. */
  readonly basisDeflator: (year: number) => number;
  readonly isMcBasisActive: boolean;
  readonly displayedTotals: Record<ProjectionMethod, BalanceProjectionMethodTotal> | null;
  readonly enabledCalculatedMethods: ReadonlySet<Exclude<ProjectionMethod, 'planned'>>;
  readonly fallbackAccounts: ReadonlyArray<{ id: string; name: string }>;
  readonly drawdownByMethod:
    | Record<ProjectionMethod, DrawdownByMethodResult | null>
    | null;
  readonly representativeByBasis:
    | Record<McBasis, RepresentativeRun | null>
    | null;
  /** The active representative run; prefers a session reroll override over the default element-0 pick. */
  readonly activeRepresentativeRun: RepresentativeRun | null;
  /** Rerolls to another card-consistent representative path from the current sample; no-op without an MC basis or with fewer than 2 band members. */
  readonly showAnotherPath: () => void;
  readonly canShowAnotherPath: boolean;
  /** The representative MC run when an MC basis is active, else `drawdownByMethod[activeMethod]`. */
  readonly resolvedDrawdown: DrawdownByMethodResult | null;
  readonly cbpValidation: ReturnType<typeof validateCbpResolution> | null;
  readonly stressVm: PlanStressTestVm;
  readonly retirementMarkers: ReadonlyArray<RetirementMarker>;
  readonly expenseChartMarkers: ReadonlyArray<CashflowChartMarker>;
  readonly balanceProjectionChartMarkers: ReadonlyArray<CashflowChartMarker>;
  readonly tooltipMembers: ReadonlyArray<TooltipMember>;
  readonly primaryRetirementYear: number | null;
  readonly cashflowFromYear: number | null;
  readonly lastDeathYear: number | null;
  readonly lastDeathFractional: number | null;
  readonly displayRows: ReadonlyArray<ProjectionChartRow>;
  readonly incomeView: IncomeView | null;
  readonly unifiedYearTableRows: ReadonlyArray<YearlyTableRow>;
  readonly portfolioFlowsByYear: ReadonlyArray<PortfolioFlowYear> | null;
  readonly magiCapBreachYears: ReadonlyArray<number>;
  readonly isMagiCapActive: boolean;
  readonly capFillActive: boolean;
  readonly customTiers: ReadonlyArray<ReadonlyArray<string>> | null;
  readonly excludedAccountIds: ReadonlyArray<string>;
  readonly accountStackTimeline: ReadonlyArray<StackBandYear>;
  readonly accountStackBoundaryYear: number | null;
  readonly accountRows: ReadonlyArray<BreakdownAccountRow>;
  readonly categoryMeta: ReadonlyArray<CategoryMeta>;
}

export interface BalanceProjectionViewModelInput {
  readonly data: PipelineData | null;
  readonly selectedScenarioId: string | null;
  readonly canonicalBalances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly canonicalExpenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly expenseCategories: ReadonlyArray<Aggregate<ExpenseCategoryPayload>>;
  readonly canonicalIncome: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  readonly displayMode: DisplayMode;
  readonly cashflowGranularity: CashflowGranularity;
  readonly incomeBreakdownGranularity: CashflowGranularity;
  readonly activeMethod: ProjectionMethod;
  readonly setActiveMethod: (m: ProjectionMethod) => void;
  readonly activeMcBasis: McBasis | null;
  readonly setActiveMcBasis: (b: McBasis | null) => void;
  /** When false, nothing kicks the Monte Carlo stress run and `stressVm` holds the inert no-input shape; for consumers that read only deterministic figures. */
  readonly runStressTest?: boolean;
  readonly nowYear: number;
  readonly nowMonthIndex: number;
  readonly nowDay: number;
  readonly resolvedTheme: 'light' | 'dark';
}

export function useBalanceProjectionViewModel(
  input: BalanceProjectionViewModelInput,
): BalanceProjectionViewModel {
  const {
    data,
    selectedScenarioId,
    canonicalBalances,
    canonicalExpenses,
    expenseCategories,
    canonicalIncome,
    ssBenefits,
    displayMode,
    cashflowGranularity,
    incomeBreakdownGranularity,
    activeMethod,
    setActiveMethod,
    activeMcBasis,
    setActiveMcBasis,
    runStressTest = true,
    nowYear,
    nowMonthIndex,
    nowDay,
    resolvedTheme,
  } = input;
  const chartColors = useChartColors();

  const viewDeflator = useMemo<(year: number, monthIndex?: number) => number>(
    () =>
      buildViewDeflatorForExport(
        displayMode,
        data?.resolved.inflation?.ratePct,
        nowYear,
        nowMonthIndex,
      ),
    [displayMode, data?.resolved.inflation?.ratePct, nowYear, nowMonthIndex],
  );

  const totals = useMemo(() => {
    if (!data) return null;
    return {
      planned: computeMethodTotal(data.rows, 'planned'),
      twr: computeMethodTotal(data.rows, 'twr'),
    };
  }, [data]);

  const cbpValidation = useMemo(() => {
    if (!data || !selectedScenarioId) return null;
    return validateCbpResolution({
      scenarioId: selectedScenarioId,
      scenarios: data.scenarios,
      accounts: data.accounts,
      incomeStreams: [...canonicalIncome],
    });
  }, [data, selectedScenarioId, canonicalIncome]);

  const primaryRetirementIso = useMemo(() => {
    if (!data?.primaryMember) return null;
    const iso = data.memberRetirementById.get(data.primaryMember.id) ?? null;
    if (!iso) return null;
    const pad2 = (n: number): string => String(n).padStart(2, '0');
    const todayIso = `${nowYear}-${pad2(nowMonthIndex + 1)}-${pad2(nowDay)}`;
    return iso < todayIso ? null : iso;
  }, [data, nowYear, nowMonthIndex, nowDay]);

  const primaryRetirementBoundaryValue = useMemo(
    () => primaryRetirementBoundary(primaryRetirementIso),
    [primaryRetirementIso],
  );

  const displayedTotals = useMemo(() => {
    if (!totals) return null;
    const retirementYear = primaryRetirementBoundaryValue?.retirementYear ?? null;
    const factor = retirementYear !== null ? viewDeflator(retirementYear, 11) : 1;
    return {
      planned: { ...totals.planned, total: totals.planned.total * factor },
      twr: { ...totals.twr, total: totals.twr.total * factor },
    };
  }, [totals, viewDeflator, primaryRetirementBoundaryValue]);

  const chartRows = useMemo(() => {
    if (!data) return [] as ProjectionChartRow[];
    return buildYearlyChartRows(
      data.rows,
      primaryRetirementBoundaryValue?.retirementYear ?? null,
      primaryRetirementBoundaryValue?.fractionalYear ?? null,
    );
  }, [data, primaryRetirementBoundaryValue]);

  const retirementMarkers = useMemo<RetirementMarker[]>(
    () => buildRetirementMarkers(primaryRetirementIso),
    [primaryRetirementIso],
  );

  const expenseChartMarkers = useMemo<CashflowChartMarker[]>(() => {
    if (!data) return [];
    const secondary = data.members.find((m) => !m.payload.isPrimary) ?? null;
    return buildExpenseDeathMarkers(
      data.primaryMember,
      secondary,
      data.resolved.lifeExpectancy,
      resolvedTheme,
    );
  }, [data, resolvedTheme]);

  const lastSurvivor = useMemo(
    () =>
      data
        ? resolveLastSurvivor(
            data.primaryMember,
            data.members.find((m) => !m.payload.isPrimary) ?? null,
            data.resolved.lifeExpectancy,
          )
        : null,
    [data],
  );

  const balanceProjectionChartMarkers = useMemo<CashflowChartMarker[]>(() => {
    return [
      ...retirementMarkers.map((m) => ({
        fractionalYear: m.fractionalYear,
        label: m.label,
        color: chartColors.retirementMarker,
      })),
      ...expenseChartMarkers,
    ];
  }, [retirementMarkers, expenseChartMarkers, chartColors.retirementMarker]);

  const tooltipMembers = useMemo<TooltipMember[]>(() => {
    if (!data) return [];
    const out: TooltipMember[] = [];
    const push = (
      member: Aggregate<HouseholdMemberPayload> | null,
      fallback: string,
    ): void => {
      if (!member?.payload.birthdate) return;
      const birthYear = Number(member.payload.birthdate.slice(0, 4));
      if (!Number.isFinite(birthYear)) return;
      const firstName = member.payload.firstName.trim() || fallback;
      out.push({ firstName, birthYear });
    };
    push(data.primaryMember, 'Primary');
    push(data.members.find((m) => !m.payload.isPrimary) ?? null, 'Secondary');
    return out;
  }, [data]);

  const lastDeathYear = useMemo<number | null>(() => {
    if (!expenseChartMarkers.length) return null;
    return Math.max(...expenseChartMarkers.map((m) => Math.ceil(m.fractionalYear)));
  }, [expenseChartMarkers]);

  const lastDeathFractional = useMemo<number | null>(() => {
    if (!expenseChartMarkers.length) return null;
    return Math.max(...expenseChartMarkers.map((m) => m.fractionalYear));
  }, [expenseChartMarkers]);

  const cashflowChartEndYear = useMemo<number | null>(() => {
    if (!data || !data.primaryMember) return null;
    const retirementYear =
      primaryRetirementBoundaryValue?.retirementYear ??
      new Date(
        data.memberRetirementById.get(data.primaryMember.id) ?? '',
      ).getUTCFullYear();
    if (!Number.isFinite(retirementYear)) return null;
    return lastDeathFractional !== null
      ? Math.floor(lastDeathFractional)
      : retirementYear;
  }, [data, primaryRetirementBoundaryValue, lastDeathFractional]);

  // Availability follows the runner's methodAvailable, not outputs.twr !== null, which is non-null for every non-CBP account (planned-rate fallback).
  const enabledCalculatedMethods = useMemo(() => {
    const set = new Set<Exclude<ProjectionMethod, 'planned'>>();
    if (data?.pageResult?.sharedCtx.methodAvailable) set.add('twr');
    return set;
  }, [data?.pageResult?.sharedCtx.methodAvailable]);

  const fallbackAccounts = useMemo(
    () => data?.pageResult?.sharedCtx.fallbackAccounts ?? [],
    [data?.pageResult?.sharedCtx.fallbackAccounts],
  );

  const cashflowSeries = useMemo(() => {
    if (!data || !selectedScenarioId) return null;
    if (cashflowChartEndYear === null) return null;
    return buildPageCashflowSeries({
      data,
      selectedScenarioId,
      canonicalIncome,
      canonicalExpenses,
      ssBenefits,
      cashflowChartEndYear,
      lastDeathYear,
      primaryRetirementYear: primaryRetirementBoundaryValue?.retirementYear ?? null,
      primaryRetirementFractional:
        primaryRetirementBoundaryValue?.fractionalYear ?? null,
      nowYear,
      nowMonthIndex,
    });
  }, [
    data,
    canonicalExpenses,
    canonicalIncome,
    ssBenefits,
    selectedScenarioId,
    cashflowChartEndYear,
    lastDeathYear,
    primaryRetirementBoundaryValue,
    nowYear,
    nowMonthIndex,
  ]);

  // The active set uses the display-basis-independent nominal signal so legend membership is stable across the Today's/Future flip; palette follows the Expenses page.
  const categoryMeta = useMemo<ReadonlyArray<CategoryMeta>>(() => {
    if (!cashflowSeries) return [];
    const activeIds = new Set<string>();
    for (const r of cashflowSeries.categoryMonthlyNominal) {
      for (const [cid, v] of Object.entries(r.byCategoryId)) {
        if (v !== 0) activeIds.add(cid);
      }
    }
    return assembleCategoryMeta(
      expenseCategories.map((c) => ({ id: c.id, name: c.payload.name })),
      activeIds,
      resolvedTheme,
    );
  }, [cashflowSeries, expenseCategories, resolvedTheme]);

  const runArgs = useMemo<RunBalanceProjectionArgs | null>(() => {
    if (!data || !selectedScenarioId) return null;
    // Gate to null so the MC hook never reaches the runner's NoPrimaryRetirementError throw.
    if (!data.resolved.retirementAge) return null;
    if (!data.primaryMember) return null;
    const primaryIso = data.memberRetirementById.get(data.primaryMember.id);
    if (!primaryIso) return null;
    return {
      scenarioId: selectedScenarioId,
      scenarios: data.scenarios,
      accounts: data.accounts,
      balances: [...canonicalBalances],
      members: data.members,
      ssBenefits: [...ssBenefits],
      expenses: [...canonicalExpenses],
      incomeStreams: [...canonicalIncome],
      todayYear: nowYear,
      todayMonthIndex: nowMonthIndex,
      method: 'planned',
      ...(data.medicalCategoryIds
        ? { medicalCategoryIds: data.medicalCategoryIds }
        : {}),
    };
  }, [
    data,
    selectedScenarioId,
    canonicalBalances,
    ssBenefits,
    canonicalExpenses,
    canonicalIncome,
    nowYear,
    nowMonthIndex,
  ]);

  const drawdownByMethod = useMemo(
    () => drawdownByMethodFromPageResult(data?.pageResult ?? null),
    [data?.pageResult],
  );

  const stressExtras = useMemo<PlanStressTestExtras>(
    () => ({
      lifeMarkers: expenseChartMarkers,
      retirementFractionalYear:
        primaryRetirementBoundaryValue?.fractionalYear ?? null,
      retirementLabel: retirementMarkers[0]?.label ?? null,
      accounts: data?.accounts ?? [],
      members: data?.members ?? [],
      lastSurvivor: lastSurvivor,
    }),
    [
      expenseChartMarkers,
      retirementMarkers,
      primaryRetirementBoundaryValue,
      data,
      lastSurvivor,
    ],
  );

  // A runStressTest: false consumer hands the hook no run input, so its auto-run and guardrail effects return before touching the provider.
  const stressVm = usePlanStressTestVm(
    runStressTest ? runArgs : null,
    cbpValidation,
    displayMode,
    stressExtras,
  );

  const representativeByBasis = useMemo(
    () => representativeByBasisFromSummary(stressVm.result),
    [stressVm.result],
  );

  // A new summary clears both the overrides and the nonces: the band seeds changed, so a stale override would draw a path from the prior sample.
  const summary = stressVm.result;
  const [rerolledRunByBasis, setRerolledRunByBasis] = useState<
    Partial<Record<McBasis, RepresentativeRun>>
  >({});
  const [rerollNonceByBasis, setRerollNonceByBasis] = useState<
    Partial<Record<McBasis, number>>
  >({});
  useEffect(() => {
    setRerolledRunByBasis({});
    setRerollNonceByBasis({});
  }, [summary]);

  const representativeBandsByBasis = summary?.representativeBandsByBasis ?? null;

  const activeRepresentativeRun = useMemo<RepresentativeRun | null>(
    () => {
      if (!activeMcBasis) return null;
      return (
        rerolledRunByBasis[activeMcBasis] ??
        representativeByBasis?.[activeMcBasis] ??
        null
      );
    },
    [activeMcBasis, representativeByBasis, rerolledRunByBasis],
  );

  const isMcBasisActive = activeMcBasis !== null;

  // Built once from the unsliced run, keyed by calendar year; any out-of-range or missing year falls back to viewDeflator so it never emits NaN.
  const basisDeflator = useMemo<(year: number) => number>(
    () =>
      buildBasisDeflator({
        isMcBasisActive,
        displayMode,
        activeRepresentativeRun,
        viewDeflator,
      }),
    [isMcBasisActive, displayMode, activeRepresentativeRun, viewDeflator],
  );

  const canShowAnotherPath =
    activeMcBasis !== null &&
    representativeByBasis?.[activeMcBasis] != null &&
    (representativeBandsByBasis?.[activeMcBasis]?.length ?? 0) >= 2;

  const showAnotherPath = useCallback(() => {
    if (!activeMcBasis) return;
    const band = representativeBandsByBasis?.[activeMcBasis];
    if (!band || band.length < 2) return; // nothing to reroll
    const nextNonce = (rerollNonceByBasis[activeMcBasis] ?? 0) + 1;
    const idx = pickBandIndex(band.length, summary?.seed ?? 0, activeMcBasis, nextNonce);
    const replayed = stressVm.replayPath(band[idx]);
    if (!replayed) return; // input went invalid between render and click
    setRerollNonceByBasis((prev) => ({ ...prev, [activeMcBasis]: nextNonce }));
    setRerolledRunByBasis((prev) => ({ ...prev, [activeMcBasis]: replayed }));
  }, [activeMcBasis, representativeBandsByBasis, rerollNonceByBasis, summary, stressVm]);

  // Reset activeMcBasis when its representative run disappears so a now-disabled option can't stay selected.
  useEffect(() => {
    if (activeMcBasis === null) return;
    if (representativeByBasis && representativeByBasis[activeMcBasis]) return;
    setActiveMcBasis(null);
  }, [activeMcBasis, representativeByBasis, setActiveMcBasis]);

  // The MC run is adapted so years[0] aligns with fromYear: builders index with y - fromYear. The balance-chart path uses activeRepresentativeRun directly, offset by run.firstYear.
  const resolvedDrawdown = useMemo<DrawdownByMethodResult | null>(
    () =>
      buildResolvedDrawdown({
        activeMcBasis,
        activeRepresentativeRun,
        drawdownByMethod,
        activeMethod,
        cashflowFromYear: cashflowSeries?.fromYear ?? null,
      }),
    [activeMcBasis, activeRepresentativeRun, drawdownByMethod, activeMethod, cashflowSeries],
  );

  const accountStackTimeline = useMemo<ReadonlyArray<StackBandYear>>(
    () =>
      buildAccountStackTimeline({
        data,
        canonicalBalances,
        isMcBasisActive,
        activeRepresentativeRun,
        activeMethod,
        resolvedDrawdown,
        basisDeflator,
      }),
    [
      data,
      canonicalBalances,
      isMcBasisActive,
      activeRepresentativeRun,
      activeMethod,
      resolvedDrawdown,
      basisDeflator,
    ],
  );

  const accountStackBoundaryYear = useMemo<number | null>(
    () => latestActualBalanceYear([...canonicalBalances], data?.accounts),
    [canonicalBalances, data],
  );

  const incomeMethodAvailability = useMemo<Record<ProjectionMethod, boolean>>(
    () => ({
      planned: drawdownByMethod?.planned !== null,
      twr: drawdownByMethod?.twr != null,
    }),
    [drawdownByMethod],
  );

  useEffect(() => {
    if (!drawdownByMethod) return;
    if (incomeMethodAvailability[activeMethod]) return;
    const fallbackOrder: ProjectionMethod[] = ['twr', 'planned'];
    const next = fallbackOrder.find((m) => incomeMethodAvailability[m]);
    if (next && next !== activeMethod) setActiveMethod(next);
  }, [drawdownByMethod, incomeMethodAvailability, activeMethod, setActiveMethod]);

  // Resolve the full scenario (walks the parent chain) so child scenarios inherit customDrawdownOrder and withdrawalStrategy.
  const resolvedScenario = useMemo(() => {
    if (!data || !data.selectedScenarioId) return null;
    try {
      return resolveScenario(data.selectedScenarioId, data.scenarios);
    } catch {
      return null;
    }
  }, [data]);

  const resolvedStrategyKind =
    resolvedScenario?.withdrawalStrategy?.kind ?? 'taxEfficient';

  const incomeView = useMemo(
    () =>
      buildIncomeView({
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
      }),
    [
      cashflowSeries,
      drawdownByMethod,
      activeMethod,
      resolvedDrawdown,
      viewDeflator,
      basisDeflator,
      displayMode,
      cashflowGranularity,
      incomeBreakdownGranularity,
      lastDeathFractional,
      categoryMeta,
    ],
  );

  const displayRows = useMemo<ProjectionChartRow[]>(
    () =>
      buildDisplayRows({
        chartRows,
        drawdownByMethod,
        lastDeathYear,
        retirementYear: primaryRetirementBoundaryValue?.retirementYear ?? null,
        viewDeflator,
        activeRepresentativeRun,
        displayMode,
      }),
    [
      chartRows,
      drawdownByMethod,
      lastDeathYear,
      primaryRetirementBoundaryValue,
      viewDeflator,
      activeRepresentativeRun,
      displayMode,
    ],
  );

  const unifiedYearTableRows = useMemo(
    () =>
      buildUnifiedYearTableRows({
        displayRows,
        cashflowSeries,
        incomeView,
        drawdownByMethod,
        activeMethod,
        activeMcBasis,
        resolvedDrawdown,
        lastDeathFractional,
        basisDeflator,
      }),
    [
      displayRows,
      cashflowSeries,
      incomeView,
      lastDeathFractional,
      activeMethod,
      activeMcBasis,
      resolvedDrawdown,
      basisDeflator,
      drawdownByMethod,
    ],
  );

  const portfolioFlowsByYear = useMemo(
    () =>
      buildPortfolioFlowsByYear({
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
      }),
    [
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
    ],
  );

  const magiCapBreachYears = useMemo(() => {
    const years = resolvedDrawdown?.years ?? [];
    return years
      .filter((dy) => (dy.magiCapBreachDollars ?? 0) > 0)
      .map((dy) => dy.year);
  }, [resolvedDrawdown]);

  const isMagiCapActive =
    resolvedScenario?.magiCap !== undefined &&
    !isMagiCapDisabled(resolvedScenario.magiCap) &&
    resolvedScenario.magiCap.windows.length > 0;
  const capFillActive =
    isMagiCapActive &&
    resolvedScenario?.magiCap !== undefined &&
    !isMagiCapDisabled(resolvedScenario.magiCap) &&
    resolvedScenario.magiCap.windows.some((w) => w.capMode === 'fill');
  const customTiers =
    resolvedStrategyKind === 'customOrder'
      ? (resolvedScenario?.customDrawdownOrder?.tiers ?? null)
      : null;
  const excludedAccountIds =
    resolvedStrategyKind === 'customOrder'
      ? (resolvedScenario?.customDrawdownOrder?.excludedAccountIds ?? [])
      : [];

  return {
    viewDeflator,
    basisDeflator,
    isMcBasisActive,
    displayedTotals,
    enabledCalculatedMethods,
    fallbackAccounts,
    drawdownByMethod,
    representativeByBasis,
    activeRepresentativeRun,
    showAnotherPath,
    canShowAnotherPath,
    resolvedDrawdown,
    cbpValidation,
    stressVm,
    retirementMarkers,
    expenseChartMarkers,
    balanceProjectionChartMarkers,
    tooltipMembers,
    primaryRetirementYear: primaryRetirementBoundaryValue?.retirementYear ?? null,
    cashflowFromYear: cashflowSeries?.fromYear ?? null,
    lastDeathYear,
    lastDeathFractional,
    displayRows,
    incomeView,
    unifiedYearTableRows,
    portfolioFlowsByYear,
    magiCapBreachYears,
    isMagiCapActive,
    capFillActive,
    customTiers,
    excludedAccountIds,
    accountStackTimeline,
    accountStackBoundaryYear,
    accountRows: data?.rows ?? [],
    categoryMeta,
  };
}
