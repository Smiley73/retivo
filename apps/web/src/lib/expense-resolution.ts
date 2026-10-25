// Public name the planning engines and the Balance Projection page use for the active expense list; delegates to `expense-override-resolution.ts`.
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
