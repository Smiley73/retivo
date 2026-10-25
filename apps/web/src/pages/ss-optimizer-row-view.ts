/** RowView discriminated union and the useRowView / deriveRowView derivation (pure data, no JSX). */
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

/** The scenario's resolved claim age per member, the baseline the recommendation is compared against; null when none is set on the scenario or any ancestor. */
export interface CurrentClaimAges {
  readonly primary: RetirementAgePerMember | null;
  readonly secondary: RetirementAgePerMember | null;
}

/** Walks the override chain (first-wins from ancestors, as the projection does). */
export function resolveCurrentClaimAges(
  scenarioId: string,
  scenarios: ReadonlyArray<ScenarioAggregate>,
): CurrentClaimAges {
  const ss = resolveScenario(scenarioId, [...scenarios]).socialSecurity;
  return { primary: ss?.primary ?? null, secondary: ss?.secondary ?? null };
}

/** Whether the current claim age equals the recommendation (years and months); callers skip a null recommendation. */
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

type OptimizerWinner = NonNullable<
  Extract<OptimizerWorkerOutbound, { kind: 'result' }>['winner']
>;

/**
 * Whether the current claim ages equal the recommendation, derived live rather than from the engine's baked flag: the MC
 * tab doesn't re-run after Apply, so the baked flag goes stale.
 */
export function isAlreadyAtOptimum(
  current: CurrentClaimAges,
  winner: OptimizerWinner,
  hasSecondary: boolean,
): boolean {
  return (
    claimAgeMatches(current.primary, winner.primaryAgeYears, winner.primaryAgeMonths) &&
    (!hasSecondary ||
      winner.secondaryAgeYears === null ||
      claimAgeMatches(current.secondary, winner.secondaryAgeYears, winner.secondaryAgeMonths))
  );
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
      winner: OptimizerWinner;
      primaryHasPia: boolean;
      secondaryHasPia: boolean;
      secondaryPastWindow: boolean;
      hasSecondary: boolean;
      missingPiaMembers: ReadonlyArray<string>;
      /** Live current claim ages, resolved from `aggregates` so the cell tracks an Apply immediately, even on the MC tab (which doesn't re-run). */
      current: CurrentClaimAges;
      alreadyAtOptimum: boolean;
      /** Metric value at the current claim ages; undefined when the current pair isn't a candidate (the 1-D primary-only fallback). */
      baselineMetricValue: number | undefined;
      parentName: string | null;
      resolvedFromAncestor: boolean;
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
    // The MC tab doesn't emit this kind: collapse it to a loading row so the narrowing stays exhaustive without TWR-specific copy.
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
  // winner: null on a 'result' reply means an empty candidate grid on every eligible member (all past the claim-age window).
  if (!winner) return { kind: 'past-window' };
  const secondaryPastWindow =
    secondary !== undefined &&
    winner.secondaryAgeYears === null &&
    secondaryHasPia;
  const resolvedFromAncestor =
    row.scenario.payload.overrides.socialSecurity === undefined &&
    row.scenario.payload.parentScenarioId !== null;
  const current = resolveCurrentClaimAges(row.scenario.id, aggregates.scenarios);
  // Prefer the runner-forwarded value; else resolve from the scenario chain.
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
    alreadyAtOptimum: isAlreadyAtOptimum(current, winner, secondary !== undefined),
    baselineMetricValue: row.result.baselineMetricValue,
    parentName: row.parentName,
    resolvedFromAncestor,
    assumedDeathAge,
  };
}

function resolveAssumedDeathAge(
  scenarioId: string,
  scenarios: ReadonlyArray<ScenarioAggregate>,
): number {
  const resolved = resolveScenario(scenarioId, [...scenarios]);
  return resolved.lifeExpectancy?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE;
}
