/**
 * `RowView` discriminated union + the `useRowView` / `deriveRowView`
 * derivation. Extracted from `ss-optimizer-page-chrome.tsx` to keep that
 * file under the ≤400-ln shape limit. Pure data — no JSX — so a `.ts`
 * file is enough.
 */
import { useMemo } from 'react';
import type { OptimizerWorkerOutbound } from '../workers/claim-age-optimizer.worker';
import type { UnsupportedScenarioReason } from '../lib/optimizer-unsupported';
import { resolveScenario, type ScenarioAggregate } from '../lib/scenario-resolution';
import { DEFAULT_LIFE_EXPECTANCY_AGE, type RetirementAgePerMember } from '../db/types';
import type {
  OptimizerAggregates,
  ScenarioRow,
} from './ss-optimizer-page-chrome';

export type EmptyReason = 'no-primary-member' | 'no-retirement-date';
export type UnsupportedReason = UnsupportedScenarioReason;

/** A scenario's current (resolved) Social Security claim age per member —
 *  the baseline the optimizer's recommendation is compared against. `null`
 *  when no claim age is set on the scenario or any ancestor. */
export interface CurrentClaimAges {
  readonly primary: RetirementAgePerMember | null;
  readonly secondary: RetirementAgePerMember | null;
}

/** Resolve the scenario's current claim ages by walking the override
 *  chain (first-wins inheritance from ancestors, same as the projection). */
export function resolveCurrentClaimAges(
  scenarioId: string,
  scenarios: ReadonlyArray<ScenarioAggregate>,
): CurrentClaimAges {
  const ss = resolveScenario(scenarioId, [...scenarios]).socialSecurity;
  return { primary: ss?.primary ?? null, secondary: ss?.secondary ?? null };
}

/**
 * Does the current claim age already equal the recommendation? Years and
 * months both count: a current 65 years 6 months is NOT a match for a "65"
 * recommendation, but it is for a recommendation that carries the same 6
 * months (the stored pair ranked highest). A `null` recommendation
 * (secondary past the claim-age window) matches only a `null` current age;
 * callers skip the comparison for such a member, whose stored age Save keeps.
 * Single source of truth for both the "show just the age" display rule and
 * the already-applied button state.
 */
export function claimAgeMatches(
  current: RetirementAgePerMember | null,
  recommendedYears: number | null,
  recommendedMonths = 0,
): boolean {
  const currentYears = current?.ageYears ?? null;
  if (currentYears !== recommendedYears) return false;
  if ((current?.ageMonths ?? 0) !== recommendedMonths) return false;
  return true;
}

export type RowView =
  | { kind: 'loading' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }
  | { kind: 'empty'; reason: EmptyReason }
  | { kind: 'both-missing-pia' }
  | { kind: 'past-window' }
  | { kind: 'unsupported'; reason: UnsupportedReason }
  | {
      kind: 'ready';
      winner: NonNullable<
        Extract<OptimizerWorkerOutbound, { kind: 'result' }>['winner']
      >;
      primaryHasPia: boolean;
      secondaryHasPia: boolean;
      secondaryPastWindow: boolean;
      hasSecondary: boolean;
      missingPiaMembers: ReadonlyArray<string>;
      /** Live current claim ages — drives the "current → recommended"
       *  cell display. Resolved from `aggregates` so it tracks an Apply
       *  immediately, even on the MC tab (which doesn't re-run). */
      current: CurrentClaimAges;
      alreadyAtOptimum: boolean;
      /** Metric value at the scenario's current claim ages — drives the
       *  "current → recommended" metric cell. `undefined` when the current
       *  pair isn't a candidate (the 1-D primary-only fallback). */
      baselineMetricValue: number | undefined;
      parentName: string | null;
      resolvedFromAncestor: boolean;
      /** The fixed death age the optimizer assumed for this scenario;
       *  retained for the MC result (the former per-row disclosure was removed). */
      assumedDeathAge: number;
    };

export function useRowView(
  row: ScenarioRow,
  aggregates: OptimizerAggregates,
): RowView {
  return useMemo(() => deriveRowView(row, aggregates), [row, aggregates]);
}

function deriveRowView(
  row: ScenarioRow,
  aggregates: OptimizerAggregates,
): RowView {
  if (row.cancelled) return { kind: 'cancelled' };
  if (row.loading || !row.result) return { kind: 'loading' };
  if (row.result.kind === 'error') return { kind: 'error', message: row.result.message };
  if (row.result.kind === 'empty') {
    return { kind: 'empty', reason: row.result.reason };
  }
  if (row.result.kind === 'unsupported') {
    return { kind: 'unsupported', reason: row.result.reason };
  }
  if (row.result.kind === 'twr-insufficient') {
    // MC tab doesn't emit this kind, but the discriminated union now
    // includes it — collapse to a loading-row equivalent so the type
    // narrowing below is exhaustive without bleeding TWR-specific copy
    // onto the MC tab.
    return { kind: 'loading' };
  }
  const winner = row.result.winner;
  const primary = aggregates.members.find((m) => m.payload.isPrimary);
  const secondary = aggregates.members.find((m) => !m.payload.isPrimary);
  const missingPiaMembers = row.result.missingPiaMembers;
  const primaryHasPia = primary !== undefined && !missingPiaMembers.includes(primary.id);
  const secondaryHasPia =
    secondary !== undefined && !missingPiaMembers.includes(secondary.id);
  if (!primaryHasPia && (secondary === undefined || !secondaryHasPia)) {
    return { kind: 'both-missing-pia' };
  }
  // `winner: null` on a `'result'` reply = empty candidate grid on
  // every eligible member (everyone past the claim-age window). Falls
  // through to LoadingRow without this branch.
  if (!winner) return { kind: 'past-window' };
  const secondaryPastWindow =
    secondary !== undefined &&
    winner.secondaryAgeYears === null &&
    secondaryHasPia;
  const resolvedFromAncestor =
    row.scenario.payload.overrides.socialSecurity === undefined &&
    row.scenario.payload.parentScenarioId !== null;
  const current = resolveCurrentClaimAges(row.scenario.id, aggregates.scenarios);
  // Derive "already at optimum" live from the current claim age vs the
  // recommendation rather than trusting the engine's baked-in flag. The
  // MC tab doesn't re-run after Apply, so its baked flag goes stale; a
  // live comparison flips the row to "Applied" the moment the override
  // lands. Equivalent to the engine flag on the deterministic tab (which
  // re-runs), keeping both tabs consistent.
  const alreadyAtOptimum =
    claimAgeMatches(current.primary, winner.primaryAgeYears, winner.primaryAgeMonths) &&
    (secondary === undefined ||
      winner.secondaryAgeYears === null ||
      claimAgeMatches(
        current.secondary,
        winner.secondaryAgeYears,
        winner.secondaryAgeMonths,
      ));
  // Assumed death age. Prefer the value the runner forwarded onto the
  // result; otherwise resolve it from the scenario chain (deterministic
  // tab / older payloads).
  const assumedDeathAge =
    row.result.assumedDeathAge ??
    resolveAssumedDeathAge(row.scenario.id, aggregates.scenarios);
  return {
    kind: 'ready',
    winner,
    primaryHasPia,
    secondaryHasPia,
    secondaryPastWindow,
    hasSecondary: secondary !== undefined,
    missingPiaMembers,
    current,
    alreadyAtOptimum,
    baselineMetricValue: row.result.baselineMetricValue,
    parentName: row.parentName,
    resolvedFromAncestor,
    assumedDeathAge,
  };
}

/** Resolve the assumed primary death age from the scenario chain
 *  (fallback when the result payload omits it). */
function resolveAssumedDeathAge(
  scenarioId: string,
  scenarios: ReadonlyArray<ScenarioAggregate>,
): number {
  const resolved = resolveScenario(scenarioId, [...scenarios]);
  return resolved.lifeExpectancy?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE;
}
