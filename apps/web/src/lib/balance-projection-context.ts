/**
 * Expense-projection context factory for the Balance Projection page, anchored to the same `now` as the view
 * deflator.
 */
import {
  type ProjectionContext as ExpenseProjectionContext,
  type ProjectionInflation,
} from './expense-projection';
import type { ScenarioOverrides } from '../db/types';

/** Inputs to {@link buildBalanceExpenseContext}; the clock primitives are captured once per render. */
export interface BuildBalanceExpenseContextInput {
  nowYear: number;
  /** 0-11. */
  nowMonthIndex: number;
  retirementYear: number;
  primary?: { birthdate?: string | null };
  secondary?: { birthdate?: string | null };
  /** Resolved per-category inflation; absent pins inflation to 0%. */
  inflation?: ProjectionInflation;
  discretionarySpending?: ScenarioOverrides['discretionarySpending'];
  lifeExpectancy?: ScenarioOverrides['lifeExpectancy'];
}

/** Builds the expense-projection context for the Balance Projection page. Pure. */
export function buildBalanceExpenseContext(
  input: BuildBalanceExpenseContextInput,
): ExpenseProjectionContext {
  return {
    todayYear: input.nowYear,
    todayMonthIndex: input.nowMonthIndex,
    retirementYear: input.retirementYear,
    primary: input.primary?.birthdate
      ? { birthdate: input.primary.birthdate }
      : undefined,
    secondary: input.secondary?.birthdate
      ? { birthdate: input.secondary.birthdate }
      : undefined,
    inflation: input.inflation,
    discretionarySpending: input.discretionarySpending,
    lifeExpectancy: input.lifeExpectancy,
    extendBeyondLifetime: false,
  };
}
