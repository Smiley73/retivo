/** Data-load hook for the Balance Projection page: one reactive useAggregates read per aggregate type plus the selected scenario, so a half-synced first load or a bulk fill surfaces without a manual reload. */
import { useEffect, useState } from 'react';
import { readSelectedScenario } from '../db/store';
import { useAggregates } from '../lib/use-aggregates';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpenseCategoryPayload,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import { SELECTED_SCENARIO_CHANGED_EVENT } from '../lib/scenario-mutations';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

interface BalanceProjectionData {
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly selectedScenarioId: string | null;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  /** Read additively: a read error degrades to Total-only, gated into `ready` but not `error`. */
  readonly expenseCategories: ReadonlyArray<Aggregate<ExpenseCategoryPayload>>;
  readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  readonly ready: boolean;
  readonly error: string | null;
}

export type UseBalanceProjectionDataResult = BalanceProjectionData;

export function useBalanceProjectionData(): UseBalanceProjectionDataResult {
  const scenarioQuery = useAggregates('scenario');
  const memberQuery = useAggregates('householdMember');
  const accountQuery = useAggregates('account');
  const balanceQuery = useAggregates('accountBalance');
  const expenseQuery = useAggregates('expense');
  const expenseCategoryQuery = useAggregates('expenseCategory');
  const incomeQuery = useAggregates('incomeStream');
  const ssQuery = useAggregates('socialSecurityBenefit');

  const scenarios = scenarioQuery.aggregates as ReadonlyArray<ScenarioAggregate>;
  const members =
    memberQuery.aggregates as ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  const accounts =
    accountQuery.aggregates as ReadonlyArray<Aggregate<AccountPayload>>;
  const balances =
    balanceQuery.aggregates as ReadonlyArray<Aggregate<AccountBalancePayload>>;
  const expenses =
    expenseQuery.aggregates as ReadonlyArray<Aggregate<ExpensePayload>>;
  const expenseCategories =
    expenseCategoryQuery.aggregates as ReadonlyArray<
      Aggregate<ExpenseCategoryPayload>
    >;
  const incomeStreams =
    incomeQuery.aggregates as ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  const ssBenefits =
    ssQuery.aggregates as ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;

  // The page renders as soon as every slice has settled its first read.
  const ready =
    scenarioQuery.ready &&
    memberQuery.ready &&
    accountQuery.ready &&
    balanceQuery.ready &&
    expenseQuery.ready &&
    expenseCategoryQuery.ready &&
    incomeQuery.ready &&
    ssQuery.ready;

  // expenseCategoryQuery.error is excluded: a category read error only disables the "by category" toggle and must not blank the page.
  const error: string | null = [
    scenarioQuery.error,
    memberQuery.error,
    accountQuery.error,
    balanceQuery.error,
    expenseQuery.error,
    incomeQuery.error,
    ssQuery.error,
  ].some((e) => e !== null)
    ? 'Failed to load projection data.'
    : null;

  // Re-resolved when the scenarios list changes (a bulk fill populating an empty workspace) and on a sidebar pick; the singleton read is async, hence the effect.
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const sel = await readSelectedScenario();
        if (cancelled) return;
        const base = scenarios.find((s) => s.payload.isPrimary);
        const validId =
          sel && scenarios.some((s) => s.id === sel.scenarioId)
            ? sel.scenarioId
            : (base?.id ?? null);
        setSelectedScenarioId(validId);
      } catch {
        // Keep the stale-but-resolved id under a transient read failure; the reactive list re-runs this effect on the next write.
      }
    };
    void refresh();
    const onSelected = (): void => void refresh();
    window.addEventListener(SELECTED_SCENARIO_CHANGED_EVENT, onSelected);
    return () => {
      cancelled = true;
      window.removeEventListener(SELECTED_SCENARIO_CHANGED_EVENT, onSelected);
    };
  }, [scenarios]);

  return {
    scenarios,
    selectedScenarioId,
    members,
    accounts,
    balances,
    expenses,
    expenseCategories,
    incomeStreams,
    ssBenefits,
    ready,
    error,
  };
}
