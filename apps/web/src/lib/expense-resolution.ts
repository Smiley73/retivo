/**
 * Resolves the active expense list for a given scenario.
 *
 * Thin wrapper that delegates to the per-id sparse resolver in
 * [expense-override-resolution.ts]. Kept as the public name the planning
 * engines and the Balance Projection page consume so callers don't need to
 * track the rename.
 */
import {
  resolveExpensesForScenarioSparse,
  type ResolvedExpense as SparseResolvedExpense,
} from './expense-override-resolution';
import type { ScenarioAggregate } from './scenario-resolution';
import type { Aggregate, ExpensePayload } from '../db/types';

export type ResolvedExpense = SparseResolvedExpense;

export function resolveExpensesForScenario(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
  canonicalExpenses: Aggregate<ExpensePayload>[],
): ResolvedExpense[] {
  return resolveExpensesForScenarioSparse(
    scenarioId,
    allScenarios,
    canonicalExpenses,
  );
}
