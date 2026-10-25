// Empty-state and grid helpers split out of `optimizer-mc-runner-helpers.ts`: pre-seed outcomes for empty-grid scenarios that never reach the worker, and the retirement-date probe.

import { resolveScenario, type ScenarioAggregate } from './scenario-resolution';
import { resolveMemberRetirementDates } from './retirement-date-math';
import type {
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import type { OptimizerMcOutcome } from './optimizer-mc-runner-types';
import type { PiaState } from './optimizer-mc-runner-helpers';

export function pastWindowOrMissingPia(piaState: PiaState): OptimizerMcOutcome {
  // `winner: null` is how the page picks the past-window and missing-PIA row variants.
  return {
    kind: 'result',
    winner: null,
    partial: true,
    missingPiaMembers: piaState.missingPiaMembers,
    alreadyAtOptimum: false,
  };
}

export function noRetirementDateOutcome(): OptimizerMcOutcome {
  return { kind: 'empty', reason: 'no-retirement-date' };
}

/** Whether the primary's retirement date resolves for the scenario (mirrors the deterministic worker's check); false with no `retirementAge` on the chain or an unusable birthdate. */
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
