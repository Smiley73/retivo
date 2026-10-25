/**
 * Pure write for a scenario's per-income patch entry (`Scenario.overrides.income.patches[id]`); the income twin of `scenario-expense-patch.ts`, kept domain-split because the override slots, payload types and rules differ.
 * Legacy snapshots keyed patches by raw canonical id while the resolver expects `aggregate:<id>`, so every write drops both keys and re-inserts under the prefixed one; empty objects are pruned.
 */
import type {
  IncomeStreamPayload,
  IncomeOverride,
  PatchWithClears,
  ScenarioPayload,
} from '../db/types';

/**
 * Next `ScenarioPayload` after writing or clearing this income's patch entry.
 * A whole-patch `null` or empty object drops the entry; a per-key `null` inside a patch is a
 * clear-marker the resolver strips at read time.
 *
 * @param prefixedId `aggregate:<canonicalId>`, the resolver key
 * @param rawId the unprefixed canonical id (legacy key to dedup)
 */
export function buildScenarioIncomePatchWrite(
  scenarioPayload: ScenarioPayload,
  prefixedId: string,
  rawId: string,
  mergedPatchOrNull: PatchWithClears<IncomeStreamPayload> | null,
): ScenarioPayload {
  const existingIncome: IncomeOverride =
    scenarioPayload.overrides.income ?? {};
  const dedupPatches: Record<string, PatchWithClears<IncomeStreamPayload>> = {};
  for (const [k, v] of Object.entries(existingIncome.patches ?? {})) {
    if (k !== prefixedId && k !== rawId) dedupPatches[k] = v;
  }
  if (mergedPatchOrNull && Object.keys(mergedPatchOrNull).length > 0) {
    dedupPatches[prefixedId] = mergedPatchOrNull;
  }
  const nextIncome: IncomeOverride = { ...existingIncome };
  if (Object.keys(dedupPatches).length > 0) {
    nextIncome.patches = dedupPatches;
  } else {
    delete nextIncome.patches;
  }
  const nextOverrides = { ...scenarioPayload.overrides };
  if (Object.keys(nextIncome).length > 0) {
    nextOverrides.income = nextIncome;
  } else {
    delete nextOverrides.income;
  }
  return { ...scenarioPayload, overrides: nextOverrides };
}
