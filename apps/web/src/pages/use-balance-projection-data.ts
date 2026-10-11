/**
 * Balance Projection page — data-load hook. Centralises every IndexedDB
 * read the page needs (scenarios, members, accounts, balances, expenses,
 * income streams, SS benefits, selected-scenario singleton) behind one
 * hook so the page itself stays a presentation layer.
 *
 * Reads go through the reactive `useAggregates(type)` live-query layer: one
 * hook per aggregate type, each re-reading on any write to its own store
 * (single writes via the per-store fine signal, bulk fills via the coarse
 * `WORKSPACE_CHANGED_EVENT`).
 * The cross-type slices and the selected-scenario
 * resolution are derived from those hooks' outputs, so a half-synced first
 * load or a demo bulk fill surfaces without a manual reload — no per-page
 * revision dependency to forget.
 *
 * Selected-scenario resolution re-runs whenever the scenarios list changes
 * (so a bulk fill that lands while BPP is mounted on an empty workspace
 * re-resolves the base scenario instead of staying null) and on a sidebar
 * pick via `SELECTED_SCENARIO_CHANGED_EVENT`.
 */
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
  /** Expense categories (id + name) for the cashflow "by category" toggle's
   *  legend / band names. Read additively — a read error degrades the page
   *  to Total-only (gated into `ready` but NOT `error`). */
  readonly expenseCategories: ReadonlyArray<Aggregate<ExpenseCategoryPayload>>;
  readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  /** True once the first reload settled (success or empty). The page
   *  uses this to distinguish first-paint (`!ready` → loading skeleton)
   *  from a resolved empty workspace. */
  readonly ready: boolean;
  readonly error: string | null;
}

export type UseBalanceProjectionDataResult = BalanceProjectionData;

/**
 * Reads every aggregate type BPP renders via `useAggregates`, tracks the
 * selected scenario, and returns a single `BalanceProjectionData` value the
 * page slices into individual memos.
 */
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

  // NOTE: `expenseCategoryQuery.error` is deliberately NOT in this
  // disjunction. Category names are additive (the cashflow "by category"
  // toggle); a category read error leaves the slice empty → `categoryMeta`
  // empty → toggle disabled → Total-only, but never blanks the whole page.
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

  // Selected-scenario id from the IDB singleton. Re-resolved whenever the
  // scenarios list changes (a bulk fill / sync bootstrap that populates an
  // empty workspace re-resolves the base scenario) and on a sidebar pick
  // (`SELECTED_SCENARIO_CHANGED_EVENT`). Reading the singleton is async, so it
  // lives in an effect; the scenarios list it validates against is the reactive
  // `useAggregates('scenario')` output, so the effect re-runs on the
  // empty→populated transition.
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
        // Leave `selectedScenarioId` as-is (a stale-but-resolved id beats
        // clearing it under a transient read failure). The scenarios list is
        // already reactive, so the next write re-runs this effect.
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
