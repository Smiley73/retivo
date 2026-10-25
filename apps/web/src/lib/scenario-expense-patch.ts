/**
 * Pure write for a scenario's per-expense patch entry (`Scenario.overrides.expenses.patches[id]`), shared by the form Save branch and whole-expense Reset.
 * Legacy snapshots keyed patches by raw canonical id while the resolver expects `aggregate:<id>`, so every write drops both keys and re-inserts under the prefixed one; empty objects are pruned.
 */
import type {
  ExpensePayload,
  ExpensesOverride,
  PatchWithClears,
  ScenarioPayload,
} from '../db/types';

/**
 * Next `ScenarioPayload` after writing or clearing this expense's patch entry.
 * A whole-patch `null` or empty object drops the entry; a per-key `null` inside a patch is a
 * clear-marker the resolver strips at read time.
 *
 * @param prefixedId `aggregate:<canonicalId>`, the resolver key
 * @param rawId the unprefixed canonical id (legacy key to dedup)
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
