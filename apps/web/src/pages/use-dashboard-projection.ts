/** Dashboard view-model hook: reuses the Balance Projection data load, pipeline and view model, with Today's dollars and yearly granularity fixed. */
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
} from './balance-projection-page-data';
import {
  useBalanceProjectionViewModel,
  type BalanceProjectionViewModel,
} from './use-balance-projection-view-model';
import type { ProjectionMethod } from '../components/ProjectionChart';

const NOOP_SET_MC_BASIS = (): void => {};

export type TaxTreatmentSliceKey =
  | 'pretax'
  | 'taxable'
  | 'taxfree_roth'
  | 'taxfree_hsa';

/** Per-bucket allocation share (dollars / total, 0..1), ordered pretax → taxable → taxfree_roth → taxfree_hsa. */
export interface DashboardAllocationSlice {
  readonly bucket: TaxTreatmentSliceKey;
  readonly dollars: number;
  readonly share: number;
}

/** Per-category share (dollars / total, 0..1) of whole accounts by accountCategory. */
export interface DashboardByTypeSlice {
  readonly category: AccountCategory;
  readonly dollars: number;
  readonly share: number;
}

export interface DashboardProjection {
  readonly ready: boolean;
  readonly error: string | null;
  /** Set when the scenario's settings are mutually incompatible; the KPIs read "—" under an inline banner instead of crashing. */
  readonly configError: string | null;
  readonly accountCount: number;
  readonly netWorth: number;
  readonly annualSpend: number | null;
  readonly allocation: ReadonlyArray<DashboardAllocationSlice>;
  /** Whole-account categories; intentionally does not match `allocation` (a MIXED 401(k) shows in full under retirement here). */
  readonly allocationByType: ReadonlyArray<DashboardByTypeSlice>;
  readonly projectedAtRetirement: number | null;
  readonly vm: BalanceProjectionViewModel | null;
}

const BUCKET_ORDER: ReadonlyArray<TaxTreatmentSliceKey> = [
  'pretax',
  'taxable',
  'taxfree_roth',
  'taxfree_hsa',
];

const CATEGORY_ORDER: ReadonlyArray<AccountCategory> = [
  'retirement',
  'roth',
  'brokerage',
  'hsa',
  'cash',
  'other',
];

/** Buckets whole accounts by accountCategory (a MIXED 401(k) shows in full under retirement); $0 categories are dropped. */
function deriveByAccountTypeAllocation(
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

  const renderNow = new Date();
  const nowYear = renderNow.getFullYear();
  const nowMonthIndex = renderNow.getMonth();
  const nowDay = renderNow.getDate();

  // Swallow the one typed config error (incompatible withdrawal-strategy and allocation override) into a null pipeline so the KPIs read "—" and net worth stays live.
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
    activeMcBasis: null,
    setActiveMcBasis: NOOP_SET_MC_BASIS,
    nowYear,
    nowMonthIndex,
    nowDay,
    resolvedTheme,
  });

  const portfolio = useMemo(() => {
    return computePortfolioSummary(
      canonicalAccounts.map((account) => ({ account, ownerDisplayName: '' })),
      [...canonicalBalances],
    );
  }, [canonicalAccounts, canonicalBalances]);

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

  const allocationByType = useMemo<ReadonlyArray<DashboardByTypeSlice>>(
    () => deriveByAccountTypeAllocation(portfolio.accounts),
    [portfolio.accounts],
  );

  // Reuses the context the Expenses page and the form preview build from, so the KPI can't disagree with the Expenses total.
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
