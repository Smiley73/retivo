/** Pure logic for ExpenseFormPage: the scenario-patch delta algebra and the glide save-time fact resolver. Kept parallel to, not unified with, the income helpers (different override fields). */
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

// Per-key delta against the resolved payload the form opened with. Any optional present in opened but absent in the rebuild emits null (the clear-marker the resolver strips): a cleared discretionaryGlide, or a dropped end (a recurring → oneOff flip or cleared end). `description` clears to '' (its real value).
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
  // `end` exists on built only for recurring frequencies: emit the new value, else null to clear the inherited end (a recurring → oneOff flip).
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
  // False (same as absent) emits null to clear an inherited true, and is omitted if the opened value was also absent or false.
  const builtHsa = built.hsaQualified === true ? true : undefined;
  const openedHsa = opened.hsaQualified === true ? true : undefined;
  if (builtHsa !== openedHsa) {
    delta.hsaQualified = builtHsa ?? (openedHsa !== undefined ? null : undefined);
    if (delta.hsaQualified === undefined) delete delta.hsaQualified;
  }
  return delta;
}

/** Merges the per-key delta into this expense's existing patch, never replacing it; pre-prefix snapshots could store the patch under the raw canonical id, so either key is read and both are dropped. */
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
* Scenario-derived facts the save-time glide validation needs (primary retirement year/month and resolved life expectancy); `scId` null selects the primary scenario.
* lifeExpectancy keeps the preview and Save paths resolving a `lifetime` glide-end identically (otherwise resolveEndMonth falls back to DEFAULT_LIFE_EXPECTANCY_AGE on Save).
* Defaults to the unresolved posture (year NaN, month0 0), assigning each field as it resolves, so glideProblem treats unresolved anchors as errors.
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
  }
  return { retirementYear, retirementMonth0, lifeExpectancy };
}
