/**
 * Pure write algebra for a scenario's per-income patch entry
 * (`Scenario.overrides.income.patches[id]`). The income twin of
 * `scenario-expense-patch.ts` — extracted from IncomeFormPage so
 * the patch dedup → rebuild-IncomeOverride → rebuild-ScenarioPayload
 * steps live beside their expense counterpart instead of inline in the
 * page. Kept domain-split (no generic merge) on purpose: the override
 * slots, payload types, and governing rules differ.
 *
 * Pre-prefix snapshots wrote raw canonical ids as patch keys; the
 * sparse resolver expects the `aggregate:`-prefixed id.
 * Every write therefore drops BOTH the prefixed and the raw key for
 * this income, then (when a merged patch survives) re-inserts under
 * the prefixed id only — collapsing any legacy duplicate. Empty keys
 * are pruned so a scenario that no longer overrides anything carries
 * no `income` / `patches` object at all.
 */
import type {
  IncomeStreamPayload,
  IncomeOverride,
  PatchWithClears,
  ScenarioPayload,
} from '../db/types';

/**
 * Next `ScenarioPayload` after writing (or clearing) this income's
 * patch entry. The `mergedPatchOrNull` argument carries TWO distinct
 * `null` meanings:
 *   - the whole-patch `null` (or an empty object) is the *reset
 *     argument* — "drop this income's patch entry";
 *   - inside a non-empty `PatchWithClears` patch, a per-key `null` is a
 *     *clear-marker* on an inherited optional. Those ride through the
 *     dedup unchanged; the resolver strips them at read time.
 * A non-empty patch replaces this income's entry under `prefixedId`.
 * The canonical IncomeStream aggregate is never touched here.
 *
 * @param scenarioPayload the scenario being patched (read-only input)
 * @param prefixedId      `aggregate:<canonicalId>` — the resolver key
 * @param rawId           the unprefixed canonical id (legacy key to dedup)
 * @param mergedPatchOrNull the full merged patch (per-key `null`s allowed
 *                          as clear-markers), or whole-patch null to clear
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
