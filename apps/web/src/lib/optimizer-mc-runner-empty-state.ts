/**
 * Empty-state + grid helpers for `optimizer-mc-runner-helpers.ts`:
 *  - `hasResolvedRetirementDate` — per-scenario probe mirroring the
 *    deterministic worker's check (drives "no-retirement-date" vs
 *    "missing-pia"/"past-window" routing).
 *  - `noRetirementDateOutcome` / `pastWindowOrMissingPia` — pre-seed
 *    outcomes for empty-grid scenarios that never reach the worker.
 *  - `ageYearsToday` — birthdate→years helper feeding `buildCandidateGrid`.
 *
 * Split out of `optimizer-mc-runner-helpers.ts` to keep that file under
 * the ≤400-ln shape cap.
 * Pure mechanical extraction; no
 * logic change.
 */
import { resolveScenario, type ScenarioAggregate } from './scenario-resolution';
import { resolveMemberRetirementDates } from './retirement-date-math';
import type {
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import type { OptimizerMcOutcome } from './optimizer-mc-runner-types';
import type { PiaState } from './optimizer-mc-runner-helpers';

export function pastWindowOrMissingPia(piaState: PiaState): OptimizerMcOutcome {
  // The page derives row variants from `winner === null` (past-window)
  // + `missingPiaMembers` (both-missing-pia / PIA-not-set cells). Emit
  // `winner: null` so the page picks the right variant.
  return {
    kind: 'result',
    winner: null,
    partial: true,
    missingPiaMembers: piaState.missingPiaMembers,
    alreadyAtOptimum: false,
  };
}

export function noRetirementDateOutcome(): OptimizerMcOutcome {
  // Per-scenario empty-state. The page maps this to the
  // "Set a primary retirement age…" EmptyReasonRow copy.
  return { kind: 'empty', reason: 'no-retirement-date' };
}

/**
 * Per-scenario "primary's resolved retirement date exists?"
 * probe. Mirrors `hasResolvedRetirementDate` in
 * `claim-age-optimizer.worker.ts`. Walks the scenario chain via
 * `resolveScenario`, then runs `resolveMemberRetirementDates` against
 * the resolved override; returns false when the primary's date can't
 * be resolved (no `retirementAge` override anywhere on the chain, or
 * the primary's birthdate is unusable for date math).
 */
export function hasResolvedRetirementDate(args: {
  readonly scenarioId: string;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
}): boolean {
  const primary = args.members.find((m) => m.payload.isPrimary);
  if (!primary) return false;
  const resolved = resolveScenario(args.scenarioId, [...args.scenarios]);
  if (!resolved.retirementAge) return false;
  const dates = resolveMemberRetirementDates(
    resolved.retirementAge,
    args.members.map((m) => ({
      id: m.id,
      isPrimary: m.payload.isPrimary,
      birthdate: m.payload.birthdate ?? '',
    })),
  );
  return (dates.get(primary.id) ?? null) !== null;
}

export function ageYearsToday(birthdate: string | undefined, today: Date): number {
  if (!birthdate || birthdate.length < 10) return 0;
  const y = Number(birthdate.slice(0, 4));
  const m = Number(birthdate.slice(5, 7));
  const d = Number(birthdate.slice(8, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return 0;
  const todayMs = today.getTime();
  const birthMs = Date.UTC(y, m - 1, d);
  return (todayMs - birthMs) / (365.2425 * 24 * 3600 * 1000);
}
