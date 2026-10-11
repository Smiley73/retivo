/**
 * Pure write algebra for a scenario's per-expense patch entry
 * (`Scenario.overrides.expenses.patches[id]`). Extracted so the
 * ExpenseFormPage scenario-patch Save branch and the whole-expense
 * Reset path share one implementation instead of duplicating the
 * dedup → rebuild-ExpensesOverride → rebuild-ScenarioPayload steps.
 *
 * Pre-prefix snapshots wrote raw canonical ids as patch keys; the
 * sparse resolver expects the `aggregate:`-prefixed id.
 * Every write therefore drops BOTH the prefixed and the raw key for
 * this expense, then (when a merged patch survives) re-inserts under
 * the prefixed id only — collapsing any legacy duplicate. Empty keys
 * are pruned so a scenario that no longer overrides anything carries
 * no `expenses` / `patches` object at all.
 */
import type {
  ExpensePayload,
  ExpensesOverride,
  PatchWithClears,
  ScenarioPayload,
} from '../db/types';

/**
 * Next `ScenarioPayload` after writing (or clearing) this expense's
 * patch entry. The `mergedPatchOrNull` argument carries TWO distinct
 * `null` meanings:
 *   - the whole-patch `null` (or an empty object) is the *reset
 *     argument* — "drop this expense's patch entry" (the ND14
 *     whole-expense Reset);
 *   - inside a non-empty `PatchWithClears` patch, a per-key `null` is a
 *     *clear-marker* on an inherited optional. Those ride through the
 *     dedup unchanged; the resolver strips them at read time.
 * A non-empty patch replaces this expense's entry under `prefixedId`.
 * The canonical Expense aggregate is never touched here.
 *
 * @param scenarioPayload the scenario being patched (read-only input)
 * @param prefixedId      `aggregate:<canonicalId>` — the resolver key
 * @param rawId           the unprefixed canonical id (legacy key to dedup)
 * @param mergedPatchOrNull the full merged patch (per-key `null`s allowed
 *                          as clear-markers), or whole-patch null to clear
 */
export function buildScenarioExpensePatchWrite(
  scenarioPayload: ScenarioPayload,
  prefixedId: string,
  rawId: string,
  mergedPatchOrNull: PatchWithClears<ExpensePayload> | null,
): ScenarioPayload {
  const existingExpenses: ExpensesOverride =
    scenarioPayload.overrides.expenses ?? {};
  const dedupPatches: Record<string, PatchWithClears<ExpensePayload>> = {};
  for (const [k, v] of Object.entries(existingExpenses.patches ?? {})) {
    if (k !== prefixedId && k !== rawId) dedupPatches[k] = v;
  }
  if (mergedPatchOrNull && Object.keys(mergedPatchOrNull).length > 0) {
    dedupPatches[prefixedId] = mergedPatchOrNull;
  }
  const nextExpenses: ExpensesOverride = { ...existingExpenses };
  if (Object.keys(dedupPatches).length > 0) {
    nextExpenses.patches = dedupPatches;
  } else {
    delete nextExpenses.patches;
  }
  const nextOverrides = { ...scenarioPayload.overrides };
  if (Object.keys(nextExpenses).length > 0) {
    nextOverrides.expenses = nextExpenses;
  } else {
    delete nextOverrides.expenses;
  }
  return { ...scenarioPayload, overrides: nextOverrides };
}
