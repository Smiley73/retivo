/**
 * Pure (non-React) logic for `ExpenseFormPage`: the scenario-patch delta
 * algebra and the glide save-time fact resolver. Extracted from the page
 * so the page file holds JSX/state only.
 *
 * NOTE: `IncomeFormPage` has structurally parallel `*ScenarioPatchDelta` /
 * `compute*ScenarioPatchSave` helpers in `income-form-logic.ts`. They are
 * NOT unified here — they operate on different override fields
 * (expense-only glide/hsaQualified vs income-only rollover/windfall keys)
 * and a forced shared abstraction would be premature.
 */
import { jsonEq } from '../lib/json-eq';
import { buildScenarioExpensePatchWrite } from '../lib/scenario-expense-patch';
import { resolveScenario } from '../lib/scenario-resolution';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { resolveMemberRetirementDates } from '../lib/retirement-date-math';
import type {
  Aggregate,
  DiscretionaryGlideOverride,
  ExpensePayload,
  HouseholdMemberPayload,
  LifeExpectancyOverride,
  PatchWithClears,
  ScenarioPayload,
} from '../db/types';

/**
 * Per-key delta between the form's built payload and the resolved
 * payload the form opened with. Only top-level keys whose value
 * changed are emitted. `description` clears to `''` (an empty string is
 * the field's real value, not a key removal), matching income's `notes`.
 *
 * Uniform `null` clear-rule: any optional present in
 * `opened` but absent in the rebuilt payload emits `null`, the
 * clear-marker the resolver strips after the chain merge (rather than
 * value-equivalent-neutral special-cases):
 *   - `discretionaryGlide` cleared (the editor now emits `undefined` in
 *     scenario-patch mode when off) → `null`, not the neutral no-op
 *     object;
 *   - a dropped `end` (a recurring→oneOff flip, or a cleared end) →
 *     `null`, so the scenario resolves with no end window rather than
 *     re-inheriting the canonical one.
 */
function scenarioPatchDelta(
  built: ExpensePayload,
  opened: ExpensePayload,
  descriptionInput: string,
  glide: DiscretionaryGlideOverride | undefined,
): PatchWithClears<ExpensePayload> {
  const delta: PatchWithClears<ExpensePayload> = {};
  if (built.name !== opened.name) delta.name = built.name;
  if (built.amount !== opened.amount) delta.amount = built.amount;
  if (built.frequency !== opened.frequency) delta.frequency = built.frequency;
  if (built.classification !== opened.classification)
    delta.classification = built.classification;
  if (built.categoryId !== opened.categoryId)
    delta.categoryId = built.categoryId;
  if (!jsonEq(built.start, opened.start)) delta.start = built.start;
  const desc = descriptionInput.trim();
  if (desc !== (opened.description ?? '')) delta.description = desc;
  // `end` lives on built only for recurring frequencies. When it changed
  // from what the scenario opened with: emit the new value if present,
  // else `null` to clear the inherited end. A one-off has no `end`,
  // so a recurring→oneOff flip that opened with an `end` clears it.
  const builtEnd = built.frequency !== 'oneOff' ? built.end : undefined;
  if (!jsonEq(builtEnd, opened.end)) {
    delta.end = builtEnd ?? (opened.end !== undefined ? null : undefined);
    if (delta.end === undefined) delete delta.end;
  }
  if (!jsonEq(glide, opened.discretionaryGlide)) {
    delta.discretionaryGlide =
      glide ?? (opened.discretionaryGlide !== undefined ? null : undefined);
    if (delta.discretionaryGlide === undefined) delete delta.discretionaryGlide;
  }
  // Emit hsaQualified in the patch only when changed. True is stored
  // explicitly; false (same as absent) uses null to clear an inherited
  // true (the clear-marker), or is omitted if the opened value was also
  // absent/false.
  const builtHsa = built.hsaQualified === true ? true : undefined;
  const openedHsa = opened.hsaQualified === true ? true : undefined;
  if (builtHsa !== openedHsa) {
    delta.hsaQualified = builtHsa ?? (openedHsa !== undefined ? null : undefined);
    if (delta.hsaQualified === undefined) delete delta.hsaQualified;
  }
  return delta;
}

/**
 * Scenario-patch Save: compute the next `ScenarioPayload` for this
 * scenario after merging the per-key delta into THIS expense's existing
 * patch (never replace; pre-existing patch keys on this expense
 * are preserved). Pre-prefix snapshots could store the patch under the
 * raw canonical id, so the merge reads either key and the shared write
 * helper drops both. Pure — the caller persists via `saveScenario`.
 */
export function computeScenarioPatchSave(
  scenarioPayload: ScenarioPayload,
  builtPayload: ExpensePayload,
  opened: ExpensePayload,
  descriptionInput: string,
  glide: DiscretionaryGlideOverride | undefined,
  prefixedId: string,
  rawId: string,
): ScenarioPayload {
  const delta = scenarioPatchDelta(
    builtPayload,
    opened,
    descriptionInput,
    glide,
  );
  const allPatches = scenarioPayload.overrides.expenses?.patches ?? {};
  const existingPatch: PatchWithClears<ExpensePayload> =
    (allPatches[prefixedId] as PatchWithClears<ExpensePayload> | undefined) ??
    (allPatches[rawId] as PatchWithClears<ExpensePayload> | undefined) ??
    {};
  const mergedPatch: PatchWithClears<ExpensePayload> = {
    ...existingPatch,
    ...delta,
  };
  return buildScenarioExpensePatchWrite(
    scenarioPayload,
    prefixedId,
    rawId,
    mergedPatch,
  );
}

/**
 * Resolve the scenario-derived facts a save-time glide validation needs:
 * the primary member's retirement year/month and the scenario's resolved
 * life expectancy. `scId` null selects the primary scenario (canonical
 * Save), matching `buildGlideCtx`'s prior primary-vs-scId selection.
 *
 * `lifeExpectancy` carries the scenario's resolved value so a `lifetime`
 * glide-end anchor resolves to the SAME month the preview/engine context
 * (buildExpenseProjectionContext) resolves it to — without it,
 * resolveEndMonth's `lifetime` branch falls back to
 * DEFAULT_LIFE_EXPECTANCY_AGE on the Save path while the preview uses the
 * override, breaking preview↔Save parity (A-r3-1). Pure.
 *
 * Defaults to the unresolved posture (year NaN, month0 0) and assigns
 * each field as it resolves, so a throw after `resolveScenario` succeeds
 * keeps the already-resolved `lifeExpectancy` (exact prior semantics).
 * glideProblem treats unresolved anchors as errors; month0 0 is only the
 * can't-resolve fallback.
 */
export type GlideScenarioFacts = {
  retirementYear: number;
  retirementMonth0: number;
  lifeExpectancy: LifeExpectancyOverride | undefined;
};

export function resolveGlideScenarioFacts(
  scId: string | null,
  scenarios: ScenarioAggregate[],
  members: Aggregate<HouseholdMemberPayload>[],
): GlideScenarioFacts {
  const primary = members.find((m) => m.payload.isPrimary);
  let retirementYear = NaN;
  let retirementMonth0 = 0;
  let lifeExpectancy: LifeExpectancyOverride | undefined;
  try {
    const sc = scId
      ? scenarios.find((s) => s.id === scId)
      : scenarios.find((s) => s.payload.isPrimary);
    if (sc && primary?.payload.birthdate) {
      const resolved = resolveScenario(sc.id, scenarios);
      lifeExpectancy = resolved.lifeExpectancy;
      const map = resolveMemberRetirementDates(
        resolved.retirementAge,
        members.map((m) => ({
          id: m.id,
          isPrimary: m.payload.isPrimary,
          birthdate: m.payload.birthdate ?? '',
        })),
      );
      const iso = map.get(primary.id);
      if (iso) {
        retirementYear = new Date(iso).getUTCFullYear();
        retirementMonth0 = new Date(iso).getUTCMonth();
      }
    }
  } catch {
    // leave year NaN / month0 0 / lifeExpectancy as-resolved —
    // glideProblem treats unresolved anchors as errors; month0 0 is
    // only the can't-resolve fallback (matches the prior posture).
  }
  return { retirementYear, retirementMonth0, lifeExpectancy };
}
