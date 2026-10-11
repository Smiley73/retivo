/**
 * Balance Projection page's expense-projection context factory.
 *
 * Symmetric to `buildExpenseProjectionContext` in
 * `./expense-projection.ts` (which builds the Expenses page's context
 * with inflation hard-pinned to 0%). This factory builds the Balance
 * Projection page's context: it carries the scenario's `inflation`,
 * `discretionarySpending`, and `lifeExpectancy` overrides through to
 * the engine, and — critically — anchors `(todayYear, todayMonthIndex)`
 * to the same `now` instant the view deflator uses, so the
 * today's / future-dollars toggle stays self-consistent at any time of
 * year.
 */
import {
  type ProjectionContext as ExpenseProjectionContext,
  type ProjectionInflation,
} from './expense-projection';
import type { ScenarioOverrides } from '../db/types';

/** Inputs to {@link buildBalanceExpenseContext}. `nowYear` +
 *  `nowMonthIndex` are the real-clock primitives the caller already
 *  captured ONCE per render for the view deflator + income context —
 *  share them here so all three sides of the page anchor at the same
 *  `(year, month)` and there is no clock-boundary race within one render
 *  (an earlier shape accepted a `Date` per call site, which let two
 *  memos drift across a clock-minute boundary). */
export interface BuildBalanceExpenseContextInput {
  nowYear: number;
  /** 0-11. */
  nowMonthIndex: number;
  retirementYear: number;
  primary?: { birthdate?: string | null };
  secondary?: { birthdate?: string | null };
  /** Resolved per-category inflation (general rate + the per-category
   *  effective-rate `Map` from `resolveInflationForScenario`). The `Map`
   *  form (not the stored `Record`) so the engine reads per-category rates
   *  directly; absent ⇒ the engine pins inflation to 0% per its default. */
  inflation?: ProjectionInflation;
  discretionarySpending?: ScenarioOverrides['discretionarySpending'];
  lifeExpectancy?: ScenarioOverrides['lifeExpectancy'];
}

/** Build the expense-projection context for the Balance Projection
 *  page. Pure; no Date.now() side effects. */
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
