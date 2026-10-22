/**
 * Balance Projection page — derived view-model hook. Owns every memoized
 * transform the page renders from (deflators, totals, markers, chart rows,
 * cashflow series, the runner-sourced per-method drawdown, the year-by-year
 * + portfolio-flow builders, MAGI-cap diagnostics, strategy resolution).
 *
 * Extracted from `BalanceProjectionPage.tsx` so the page stays a thin
 * state + guard + render shell under the file shape cap. The
 * page passes its UI state in and renders from the returned bundle; this
 * hook holds no UI state of its own except the method-fallback effect.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import {
  buildPageCashflowSeries,
  drawdownByMethodFromPageResult,
  representativeByBasisFromSummary,
  type PipelineData,
  type DrawdownByMethodResult,
  type McBasis,
  type RepresentativeRun,
} from './balance-projection-page-pipeline';
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
  /** Basis-aware, display-mode-aware deflator for MC-SOURCED display dollars.
   *  Under an MC basis + Today's-dollars it returns the active
   *  representative run's `realFactorByYear[year − run.firstYear]` (the exact
   *  `1 / cumCpi` reciprocal feeding the MC balance line), so every MC display
   *  surface (RMD / tax / Roth / surplus / account stack / portfolio flow /
   *  cashflow withdrawal) deflates by the PATH'S OWN CPI. Under Future-dollars
   *  OR a deterministic basis, or for an out-of-range / missing year, it falls
   *  back to the flat `viewDeflator(year, 11)` — never NaN. Keyed by calendar
   *  year (`yr.year`), never an array index. */
  readonly basisDeflator: (year: number) => number;
  /** `true` when an MC basis is selected (drives the MC-vs-deterministic
   *  surface branches that key off `basisDeflator`). */
  readonly isMcBasisActive: boolean;
  readonly displayedTotals: Record<ProjectionMethod, BalanceProjectionMethodTotal> | null;
  readonly enabledCalculatedMethods: ReadonlySet<Exclude<ProjectionMethod, 'planned'>>;
  /** Non-CBP accounts projecting on their planned rate
   *  under the Historical view. Drives the inline disclosure note (names
   *  only). `[]` when none fell back. */
  readonly fallbackAccounts: ReadonlyArray<{ id: string; name: string }>;
  readonly drawdownByMethod:
    | Record<ProjectionMethod, DrawdownByMethodResult | null>
    | null;
  /** Per-basis representative runs from the stress VM's summary, or `null`
   *  when no MC result is available. MC basis options are disabled when this
   *  is null/the active tier is null. */
  readonly representativeByBasis:
    | Record<McBasis, RepresentativeRun | null>
    | null;
  /** The active representative run when an MC basis is selected; `null` for a
   *  deterministic basis. Prefers a session-only reroll override
   *  (`showAnotherPath`) over the default element-0 pick. */
  readonly activeRepresentativeRun: RepresentativeRun | null;
  /** Reroll the basis line to a different card-consistent representative path
   *  from the CURRENT sample (same seed, same depletion cards/percentiles).
   *  Advances the active tier's nonce, picks an alternative band seed via
   *  `pickBandIndex`, replays it on the main thread, and stores the
   *  override. No-op when no MC basis is active or the active tier's band has
   *  <2 members. */
  readonly showAnotherPath: () => void;
  /** `true` when `showAnotherPath` has an alternative to show: an MC basis is
   *  active AND the active tier's card-consistent band has ≥2 members. Drives
   *  the control's `aria-disabled` state. */
  readonly canShowAnotherPath: boolean;
  /** Resolved per-year drawdown: the representative MC run when an MC basis is
   *  active, else `drawdownByMethod[activeMethod]`. Drives the MC-eligible
   *  surfaces (cashflow / year-by-year / Annual Portfolio Flow / tax burden). */
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
  /** Rightmost death marker's fractional X — the partial-year terminal
   *  point on the cashflow / portfolio-flow / tax charts lands here. */
  readonly lastDeathFractional: number | null;
  readonly displayRows: ReadonlyArray<ProjectionChartRow>;
  readonly incomeView: IncomeView | null;
  readonly unifiedYearTableRows: ReadonlyArray<YearlyTableRow>;
  readonly portfolioFlowsByYear: ReadonlyArray<PortfolioFlowYear> | null;
  readonly magiCapBreachYears: ReadonlyArray<number>;
  readonly isMagiCapActive: boolean;
  /** True when the active cap is in Fill mode — drives the
   *  "Fill on but nothing converted" notice on the projection charts. */
  readonly capFillActive: boolean;
  readonly customTiers: ReadonlyArray<ReadonlyArray<string>> | null;
  readonly excludedAccountIds: ReadonlyArray<string>;
  /** Unified continuous-timeline rows for the "Account balances over time"
   *  band: historical actuals (nominal) → accumulation → drawdown, the
   *  projected region deflated by `basisDeflator`. */
  readonly accountStackTimeline: ReadonlyArray<StackBandYear>;
  /** The dashed actual→projected boundary year (= the last recorded balance
   *  year), or null when there is no recorded history. */
  readonly accountStackBoundaryYear: number | null;
  readonly accountRows: ReadonlyArray<BreakdownAccountRow>;
  /** Active expense categories for the cashflow "by category" mode:
   *  id / name / palette colour, alphabetical-by-name, on the
   *  display-basis-independent nominal active-set signal. Empty ⇒ the
   *  expense-mode toggle is disabled (Total-only). */
  readonly categoryMeta: ReadonlyArray<CategoryMeta>;
}

export interface BalanceProjectionViewModelInput {
  readonly data: PipelineData | null;
  readonly selectedScenarioId: string | null;
  readonly canonicalBalances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly canonicalExpenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  /** Expense categories (id + name) for the cashflow "by category" toggle's
   *  `categoryMeta` assembly. Empty / unreadable ⇒ no category bands
   *  → toggle disabled (degrades to Total-only). */
  readonly expenseCategories: ReadonlyArray<Aggregate<ExpenseCategoryPayload>>;
  readonly canonicalIncome: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  readonly displayMode: DisplayMode;
  readonly cashflowGranularity: CashflowGranularity;
  readonly incomeBreakdownGranularity: CashflowGranularity;
  readonly activeMethod: ProjectionMethod;
  readonly setActiveMethod: (m: ProjectionMethod) => void;
  /** Active Monte Carlo basis (`null` for a deterministic basis). When set, it
   *  drives every per-year surface that varies with market/inflation luck. */
  readonly activeMcBasis: McBasis | null;
  readonly setActiveMcBasis: (b: McBasis | null) => void;
  /** Whether mounting this hook may run the Monte Carlo plan-stress
   *  simulation behind `stressVm`. Defaults to `true` — every surface that
   *  renders `stressVm` or can select an MC basis leaves it there. A consumer
   *  that reads only the deterministic figures (and always passes
   *  `activeMcBasis: null`) passes `false`: `usePlanStressTestVm` is then
   *  handed no run input, so nothing is kicked — no 10,000-path worker run,
   *  no guardrail sibling run, no write to the app-wide Monte Carlo provider
   *  — and `stressVm` holds the same inert no-input shape it has for a
   *  household with no accounts. */
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
    // Use the single render-clock anchor, not a fresh `new Date()`.
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

  // Whose life the plan's horizon belongs to — the same primary/secondary +
  // life-expectancy-override inputs the death markers are built from, so the
  // person named by the market-stress longevity row is always the person the
  // rightmost death marker on the charts belongs to.
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

  // `expenseChartMarkers` now carry the integer death year (death = Dec 31
  // of `deathYear`). So all three memos below equal the integer death
  // year: `Math.ceil` / `Math.max` / `Math.floor` are each the identity on
  // an integer marker. (For non-Jan-1 births this shifts the end: the
  // horizon/year-table/dashboard end at `deathYear`, not `deathYear + 1`.)
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

  // The Historical (TWR) toggle availability is driven by
  // the runner's `methodAvailable` (≥1 non-CBP account with empirical
  // history), NOT `outputs.twr !== null` — `outputs.twr` stays non-null
  // for every non-CBP account (planned-rate fallback), so that check is now
  // always true and can no longer detect the degenerate all-fallback
  // hide-case. The runner gates `pageResult.twr` to null in that case too.
  const enabledCalculatedMethods = useMemo(() => {
    const set = new Set<Exclude<ProjectionMethod, 'planned'>>();
    if (data?.pageResult?.sharedCtx.methodAvailable) set.add('twr');
    return set;
  }, [data?.pageResult?.sharedCtx.methodAvailable]);

  // The non-CBP accounts projecting on their planned rate under the
  // Historical view (the disclosure set for the inline note). `[]` when none.
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

  // Assemble `categoryMeta` at the view-model seam (never inline
  // in the page). The active set is fixed on the display-basis-INDEPENDENT
  // nominal signal — a category is active iff it has any non-zero
  // contribution in the nominal per-category projection over the range —
  // so legend membership is stable across the Today's/Future flip. Sorted
  // alphabetical-by-name; palette assigned in that stable order so a
  // category lands on the same hue as the Expenses page. The
  // pure cashflow-series split stays id-keyed + name-agnostic.
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
    // Gate to null when no primary retirement resolves so the MC
    // hook never reaches the runner's `NoPrimaryRetirementError` throw.
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
      // Without it the stress test falls back to the legacy `cat-medical` default.
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

  // Deterministic drawdown comes from the shared runner's both-methods
  // page result — the page no longer simulates drawdown locally.
  const drawdownByMethod = useMemo(
    () => drawdownByMethodFromPageResult(data?.pageResult ?? null),
    [data?.pageResult],
  );

  const stressExtras = useMemo<PlanStressTestExtras>(
    () => ({
      lifeMarkers: expenseChartMarkers,
      retirementFractionalYear:
        primaryRetirementBoundaryValue?.fractionalYear ?? null,
      // Canonical `Retires <Mon YYYY>` label shared with the
      // deterministic + cashflow charts (built in `retirementMarkers`).
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

  // A `runStressTest: false` consumer hands the stress hook no run input:
  // `buildMcInputFromArgs(null)` is null, so its debounced auto-run and the
  // guardrail sibling effect both return before touching the provider.
  const stressVm = usePlanStressTestVm(
    runStressTest ? runArgs : null,
    cbpValidation,
    displayMode,
    stressExtras,
  );

  // The representative runs reach the page on the MC summary via the stress
  // VM's result (a Monte Carlo output, separate from the deterministic
  // `drawdownByMethod`). Null when no result / successOnly mode.
  const representativeByBasis = useMemo(
    () => representativeByBasisFromSummary(stressVm.result),
    [stressVm.result],
  );

  // Session-only reroll state. `rerolledRunByBasis` holds a per-tier
  // replayed override; `rerollNonceByBasis` advances each time the user rerolls
  // that tier so `pickBandIndex` walks the alternatives. A NEW summary
  // (Recalculate / input change) clears BOTH — the band seeds changed, so a
  // stale override would draw a path from the prior sample. Keyed on
  // `stressVm.result` identity (a fresh worker run is a new object).
  const summary = stressVm.result;
  const [rerolledRunByBasis, setRerolledRunByBasis] = useState<
    Partial<Record<McBasis, RepresentativeRun>>
  >({});
  const [rerollNonceByBasis, setRerollNonceByBasis] = useState<
    Partial<Record<McBasis, number>>
  >({});
  useEffect(() => {
    // New summary arrived → drop every override + nonce.
    setRerolledRunByBasis({});
    setRerollNonceByBasis({});
  }, [summary]);

  const representativeBandsByBasis = summary?.representativeBandsByBasis ?? null;

  // Prefer a session reroll override over the default element-0 pick.
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

  // The basis-aware deflator for MC-sourced display dollars. Built ONCE
  // from the UNSLICED `activeRepresentativeRun`, keyed by calendar year. Under
  // MC + Today's-dollars a year inside the run's horizon resolves to the path's
  // own `realFactorByYear` (the `1 / cumCpi` reciprocal that produced the MC
  // balance line); Future-dollars, a deterministic basis, or any
  // out-of-range / missing year falls back to the flat `viewDeflator(year, 11)`,
  // so the function never emits NaN.
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

  // The reroll control is enabled only when an MC basis is active AND the
  // active tier's card-consistent band has ≥2 members (element 0 = the default
  // pick, so ≥2 means there is at least one alternative to show).
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

  // When an MC basis is selected but its representative run disappears
  // (scenario switch, accounts removed → stress result becomes null), reset
  // `activeMcBasis` to null so a now-disabled option can't stay selected and
  // the driven surfaces fall back to the deterministic method.
  useEffect(() => {
    if (activeMcBasis === null) return;
    if (representativeByBasis && representativeByBasis[activeMcBasis]) return;
    setActiveMcBasis(null);
  }, [activeMcBasis, representativeByBasis, setActiveMcBasis]);

  // The RESOLVED per-year drawdown: for an MC basis, the representative run is
  // ADAPTED so years[0] aligns with fromYear (cashflow/retirement start) rather
  // than the run's firstYear (simulation start). All builders index with
  // `y - fromYear`; the un-adapted run would feed pre-retirement rows for the
  // first retirement-year lookups. The balance-chart path uses
  // `activeRepresentativeRun` directly via `deflateChartRows` + `mcValuesForYear`,
  // which correctly offsets by `run.firstYear`.
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

  // The unified "Account balances over time" timeline: recorded
  // historical actuals (nominal) → accumulation (saving years) → drawdown, the
  // projected region deflated by `basisDeflator`. Accumulation source: the MC
  // representative run's `accumulationAccountBalances` under an MC basis, else
  // the deterministic per-account projection (`accountProjections[i].outputs
  // [activeMethod].yearlyTotals`).
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

  // Resolve the full scenario (walks parent chain) so child scenarios
  // inherit customDrawdownOrder + withdrawalStrategy from their base scenario.
  // `resolvedStrategyKind` drives the customOrder gates below.
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

  // The cap is active when the ladder has ≥ 1 window (an
  // empty ladder ≡ no cap).
  const isMagiCapActive =
    resolvedScenario?.magiCap !== undefined &&
    !isMagiCapDisabled(resolvedScenario.magiCap) &&
    resolvedScenario.magiCap.windows.length > 0;
  // Fill mode is active when the cap is active AND ANY window is set to Fill —
  // drives the "Fill on but nothing converted" notice on the projection charts
  // so a silent zero-conversion run (no headroom / cap inactive over the horizon
  // / no pre-tax to convert / unresolved target) explains itself.
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
