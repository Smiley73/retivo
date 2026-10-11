/**
 * Dashboard landing-page view-model hook.
 *
 * The dashboard is the Balance Projection page's headline numbers in
 * miniature: it shows where the household stands today (net worth,
 * allocation, annual spending) and where the active-scenario plan is
 * heading (projected-at-retirement, plan success, retirement readiness).
 *
 * Rather than re-implement any of that math, this hook reuses the exact
 * same data-load + pipeline + view-model the Balance Projection page
 * runs:
 *
 *   - `useBalanceProjectionData()` — the shared IndexedDB read layer
 *     (scenarios, members, accounts, balances, expenses, income, SS),
 *     tracking the sidebar-selected active scenario and re-firing on the
 *     scenario-mutation event channels.
 *   - `loadPageData()` — the shared projection pipeline (same engine the
 *     BPP, stress test, and optimizer consume), wrapped in the same
 *     load-effect BPP uses.
 *   - `useBalanceProjectionViewModel()` — the derived bundle the BPP
 *     renders from; the dashboard reads `displayedTotals` (deterministic
 *     projected-at-retirement) and `stressVm` (the Monte-Carlo plan-
 *     success view-model, computed async by the MC worker with its own
 *     loading state) off it.
 *
 * The cheap aggregates (net worth, portfolio allocation, annual
 * spending) are computed directly from the loaded data so they paint
 * immediately and never block on the MC worker.
 *
 * The dashboard is read-only and fixes the display knobs BPP exposes as
 * UI controls: Today's-dollars display mode, yearly granularity, and the
 * TWR deterministic method (falling back to Planned when TWR has no
 * contributing account — the view-model owns that fallback).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import {
  computePortfolioSummary,
  deriveTaxTreatmentAllocation,
  type AccountWithCurrentBalance,
} from '../lib/balance-calc';
import { accountCategory, type AccountCategory } from '../lib/account-category';
import {
  buildExpenseProjectionContext,
  projectExpensesByYear,
} from '../lib/expense-projection';
import { resolveExpensesForScenario } from '../lib/expense-resolution';
import { TaxIntegrationInvalidInputError } from '../lib/balance-projection-runner-tax';
import { friendlyProjectionErrorMessage } from '../lib/tax-integration';
import { useBalanceProjectionData } from './use-balance-projection-data';
import {
  loadPageData,
  type PipelineData,
} from './balance-projection-page-pipeline';
import {
  useBalanceProjectionViewModel,
  type BalanceProjectionViewModel,
} from './use-balance-projection-view-model';
import type { ProjectionMethod } from '../components/ProjectionChart';

/** Stable no-op setter — the Dashboard never changes the Monte Carlo basis. */
const NOOP_SET_MC_BASIS = (): void => {};

/** The dashboard allocation card's four tax-treatment slice keys. */
export type TaxTreatmentSliceKey =
  | 'pretax'
  | 'taxable'
  | 'taxfree_roth'
  | 'taxfree_hsa';

/**
 * Per-bucket allocation slice — share is `dollars / total`, 0..1. The
 * allocation card buckets by tax treatment, ordered
 * pretax → taxable → taxfree_roth → taxfree_hsa.
 */
export interface DashboardAllocationSlice {
  readonly bucket: TaxTreatmentSliceKey;
  readonly dollars: number;
  readonly share: number;
}

/**
 * Per-category allocation slice for the "By account type" card — share is
 * `dollars / total`, 0..1. Buckets WHOLE accounts by `accountCategory`,
 * ordered retirement → roth → brokerage → hsa → cash → other.
 */
export interface DashboardByTypeSlice {
  readonly category: AccountCategory;
  readonly dollars: number;
  readonly share: number;
}

export interface DashboardProjection {
  /** True once the shared data hook settled its first read. */
  readonly ready: boolean;
  /** Non-null when the IDB read failed (matches BPP's surface). */
  readonly error: string | null;
  /** Non-null when the active scenario's settings are mutually
   *  incompatible (e.g. a per-account withdrawal strategy combined with a
   *  retirementAllocation override). Surfaced as an inline banner; the
   *  projection KPIs read "—" beneath it rather than the page crashing. */
  readonly configError: string | null;
  /** All-accounts count (incl. inactive) — drives the empty-state guard. */
  readonly accountCount: number;
  /** Current portfolio net worth (same authoritative calc as the Account
   *  Balances ledger; all accounts incl. inactive). */
  readonly netWorth: number;
  /** Active-scenario total annual spend at the current year, from the
   *  shared expense projection (today's dollars). `null` until the
   *  scenario pipeline resolves. */
  readonly annualSpend: number | null;
  /** Portfolio allocation by tax treatment (current balances). Empty until
   *  at least one account carries a balance. Ordered
   *  pretax → taxable → taxfree_roth → taxfree_hsa (tax-free splits into a
   *  Roth slice and an HSA slice). */
  readonly allocation: ReadonlyArray<DashboardAllocationSlice>;
  /** Portfolio allocation by whole-account category (current balances).
   *  Empty until at least one account carries a balance. Ordered
   *  retirement → roth → brokerage → hsa → cash → other; $0 categories
   *  dropped. Intentionally does NOT match `allocation` — a MIXED 401(k)
   *  shows in full under retirement here, split across pre-tax/taxable
   *  there. */
  readonly allocationByType: ReadonlyArray<DashboardByTypeSlice>;
  /** Projected-at-retirement deterministic total under the active
   *  method (TWR, falling back to Planned), today's dollars. `null`
   *  until the pipeline resolves. */
  readonly projectedAtRetirement: number | null;
  /** The active scenario's projection view-model bundle. `stressVm`
   *  carries the async Monte-Carlo plan-success state (loading flags +
   *  success %, ending balances). `null` until the pipeline resolves. */
  readonly vm: BalanceProjectionViewModel | null;
}

const BUCKET_ORDER: ReadonlyArray<TaxTreatmentSliceKey> = [
  'pretax',
  'taxable',
  'taxfree_roth',
  'taxfree_hsa',
];

/** Legend / segment order for the by-account-type card. */
const CATEGORY_ORDER: ReadonlyArray<AccountCategory> = [
  'retirement',
  'roth',
  'brokerage',
  'hsa',
  'cash',
  'other',
];

/**
 * Group whole accounts by `accountCategory` into the dashboard's
 * "By account type" slices. Each account's full current balance lands under one
 * category (a MIXED 401(k) shows in full under retirement — NOT split across
 * tax buckets), $0-balance categories are dropped, and slices come out in
 * `CATEGORY_ORDER`. `share` is `dollars / total`, 0..1. Returns [] when no
 * account carries a positive balance. Pure; unit-tested directly.
 */
export function deriveByAccountTypeAllocation(
  accounts: ReadonlyArray<AccountWithCurrentBalance>,
): ReadonlyArray<DashboardByTypeSlice> {
  const byCategory = new Map<AccountCategory, number>();
  for (const a of accounts) {
    const dollars = a.currentBalance ?? 0;
    if (dollars <= 0) continue;
    const category = accountCategory(a.type);
    byCategory.set(category, (byCategory.get(category) ?? 0) + dollars);
  }
  const total = [...byCategory.values()].reduce((s, v) => s + v, 0);
  if (total <= 0) return [];
  return CATEGORY_ORDER.flatMap((category) => {
    const dollars = byCategory.get(category) ?? 0;
    if (dollars <= 0) return [];
    return [{ category, dollars, share: dollars / total }];
  });
}

/**
 * Active deterministic method the dashboard's projected-at-retirement
 * KPI + chart render. TWR is the BPP default; the view-model re-points
 * it to Planned when TWR has no contributing account (its own fallback
 * effect, which `setActiveMethod` drives here).
 */
function useActiveMethod(): {
  activeMethod: ProjectionMethod;
  setActiveMethod: (m: ProjectionMethod) => void;
} {
  const [activeMethod, setActiveMethod] = useState<ProjectionMethod>('twr');
  return { activeMethod, setActiveMethod };
}

export function useDashboardProjection(): DashboardProjection {
  const { resolvedTheme } = useTheme();
  const dataLoad = useBalanceProjectionData();
  const {
    scenarios: canonicalScenarios,
    selectedScenarioId,
    members: canonicalMembers,
    accounts: canonicalAccounts,
    balances: canonicalBalances,
    expenses: canonicalExpenses,
    expenseCategories: canonicalExpenseCategories,
    incomeStreams: canonicalIncome,
    ssBenefits,
    ready,
    error,
  } = dataLoad;

  const { activeMethod, setActiveMethod } = useActiveMethod();
  const [data, setData] = useState<PipelineData | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  // Single real-clock anchor captured ONCE per render so the engines +
  // view-deflator can't drift across a clock-minute boundary (mirrors
  // BalanceProjectionPage).
  const renderNow = new Date();
  const nowYear = renderNow.getFullYear();
  const nowMonthIndex = renderNow.getMonth();
  const nowDay = renderNow.getDate();

  // Run the shared projection pipeline for the active scenario — the
  // same load-effect BalanceProjectionPage uses. Swallow the one typed
  // config error (incompatible withdrawal-strategy + allocation
  // override) into a null pipeline: the dashboard's deterministic KPIs
  // then read "—" rather than crashing the landing page. Net worth /
  // allocation are computed off the raw aggregates below and stay live.
  useEffect(() => {
    if (!ready) return;
    if (canonicalScenarios.length === 0 || !selectedScenarioId) {
      setData(null);
      setConfigError(null);
      return;
    }
    if (!canonicalScenarios.some((s) => s.id === selectedScenarioId)) {
      setData(null);
      setConfigError(null);
      return;
    }
    try {
      setData(
        loadPageData({
          scenarios: canonicalScenarios,
          selectedScenarioId,
          members: canonicalMembers,
          accounts: canonicalAccounts,
          balances: canonicalBalances,
          expenses: canonicalExpenses,
          incomeStreams: canonicalIncome,
          ssBenefits,
          categories: canonicalExpenseCategories,
          todayYear: nowYear,
          todayMonthIndex: nowMonthIndex,
        }),
      );
      setConfigError(null);
    } catch (e) {
      if (e instanceof TaxIntegrationInvalidInputError) {
        setData(null);
        setConfigError(friendlyProjectionErrorMessage(e));
      } else {
        throw e;
      }
    }
  }, [
    ready,
    selectedScenarioId,
    canonicalScenarios,
    canonicalMembers,
    canonicalAccounts,
    canonicalBalances,
    canonicalExpenses,
    canonicalExpenseCategories,
    canonicalIncome,
    ssBenefits,
    nowYear,
    nowMonthIndex,
  ]);

  const vm = useBalanceProjectionViewModel({
    data,
    selectedScenarioId,
    canonicalBalances,
    canonicalExpenses,
    expenseCategories: canonicalExpenseCategories,
    canonicalIncome,
    ssBenefits,
    displayMode: 'today',
    cashflowGranularity: 'yearly',
    incomeBreakdownGranularity: 'yearly',
    activeMethod,
    setActiveMethod,
    // The Dashboard projection never selects a Monte Carlo basis — it always
    // renders the deterministic method. Pass a fixed null basis + noop setter.
    activeMcBasis: null,
    setActiveMcBasis: NOOP_SET_MC_BASIS,
    nowYear,
    nowMonthIndex,
    nowDay,
    resolvedTheme,
  });

  // Cheap, immediate aggregates — net worth + allocation come straight
  // off the raw account/balance aggregates (no projection needed) so
  // they paint before the pipeline resolves and never block on the MC
  // worker. Same authoritative `computePortfolioSummary` the Account
  // Balances ledger uses, over ALL accounts (incl. inactive).
  const portfolio = useMemo(() => {
    return computePortfolioSummary(
      canonicalAccounts.map((account) => ({ account, ownerDisplayName: '' })),
      [...canonicalBalances],
    );
  }, [canonicalAccounts, canonicalBalances]);

  // Tax-treatment allocation — thin adapter over the unit-tested
  // `deriveTaxTreatmentAllocation` helper (all the bucketing math lives
  // there). Tax-free splits into a Roth slice and an HSA slice; the helper's
  // pre-tax slice is derived by subtraction so a PRE_TAX HSA is never
  // double-counted.
  const allocation = useMemo<ReadonlyArray<DashboardAllocationSlice>>(() => {
    const total = portfolio.summary.totalCurrentBalance;
    if (total <= 0) return [];
    const split = deriveTaxTreatmentAllocation(
      portfolio.summary,
      portfolio.accounts,
    );
    const dollarsByBucket: Record<TaxTreatmentSliceKey, number> = {
      pretax: split.pretaxBalance,
      taxable: split.taxableBalance,
      taxfree_roth: split.taxFreeRoth,
      taxfree_hsa: split.taxFreeHsa,
    };
    return BUCKET_ORDER.flatMap((bucket) => {
      const dollars = dollarsByBucket[bucket];
      if (dollars <= 0) return [];
      return [{ bucket, dollars, share: dollars / total }];
    });
  }, [portfolio.summary, portfolio.accounts]);

  // By-account-type allocation — whole accounts grouped by `accountCategory`.
  // The bucketing math lives in the unit-tested `deriveByAccountTypeAllocation`
  // helper; this is just the memoized adapter.
  const allocationByType = useMemo<ReadonlyArray<DashboardByTypeSlice>>(
    () => deriveByAccountTypeAllocation(portfolio.accounts),
    [portfolio.accounts],
  );

  // Active-scenario annual spend at the current year, via the shared
  // expense projection (today's dollars). Reuses the exact context the
  // Expenses page + the single-expense form preview build from, so the
  // KPI can't silently disagree with the Expenses page total. Requires
  // a resolved primary retirement date (the context anchor); falls back
  // to null until the pipeline resolves it.
  const annualSpend = useMemo<number | null>(() => {
    if (!data || !data.primaryMember) return null;
    const primaryRetirementIso = data.memberRetirementById.get(
      data.primaryMember.id,
    );
    if (!primaryRetirementIso) return null;
    const resolvedExpenses = resolveExpensesForScenario(
      data.selectedScenarioId,
      data.scenarios,
      [...canonicalExpenses],
    );
    const secondary = data.members.find((m) => !m.payload.isPrimary) ?? null;
    const ctx = buildExpenseProjectionContext({
      resolved: data.resolved,
      primary: { birthdate: data.primaryMember.payload.birthdate },
      secondary: secondary
        ? { birthdate: secondary.payload.birthdate }
        : null,
      primaryRetirementIso,
    });
    const points = projectExpensesByYear(resolvedExpenses, ctx, {
      from: nowYear,
      to: nowYear,
    });
    return points[0]?.totalBase ?? null;
  }, [data, canonicalExpenses, nowYear]);

  const projectedAtRetirement = useMemo<number | null>(() => {
    if (!vm.displayedTotals) return null;
    const t = vm.displayedTotals[activeMethod];
    if (!t || t.total <= 0) return null;
    return t.total;
  }, [vm.displayedTotals, activeMethod]);

  return {
    ready,
    error,
    configError,
    accountCount: canonicalAccounts.length,
    netWorth: portfolio.summary.totalCurrentBalance,
    annualSpend,
    allocation,
    allocationByType,
    projectedAtRetirement,
    vm: data ? vm : null,
  };
}
