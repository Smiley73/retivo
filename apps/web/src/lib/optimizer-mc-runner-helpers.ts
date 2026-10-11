/**
 * Pure helpers for `optimizer-mc-runner.ts`:
 *  - PIA state derivation (which household members have a PIA set).
 *  - Per-scenario triples builder (mirrors
 *    `claim-age-optimizer/orchestrator-helpers.buildPairs` for the
 *    deterministic path; handles every empty-grid + 1-D fallback
 *    branch).
 *  - `alreadyAtOptimum` + partial-state derivation feeding the
 *    deterministic-equivalent row contract.
 *
 * Split out of `optimizer-mc-runner.ts` to keep that file under the
 * ≤400-ln shape cap.
 */
import { buildCandidateGrid } from './claim-age-optimizer/build-grid';
import {
  buildSurvivorDimension,
  DEFAULT_PRIMARY_CLAIM_AGE,
  DEFAULT_SECONDARY_CLAIM_AGE,
} from './claim-age-optimizer/orchestrator-helpers';
import type { SurvivorClaimAges } from './claim-age-optimizer/types';
import { resolveScenario, type ScenarioAggregate } from './scenario-resolution';
import { resolveMemberRetirementDates } from './retirement-date-math';
import {
  ageYearsToday,
  hasResolvedRetirementDate,
  noRetirementDateOutcome,
  pastWindowOrMissingPia,
} from './optimizer-mc-runner-empty-state';
import type {
  Aggregate,
  HouseholdMemberPayload,
  RetirementAgePerMember,
  SocialSecurityBenefitPayload,
  SocialSecurityOverride,
} from '../db/types';
import type {
  OptimizerMcOutcome,
  OptimizerMcWinner,
} from './optimizer-mc-runner-types';

export interface PiaState {
  readonly primaryHasPia: boolean;
  readonly secondaryHasPia: boolean;
  readonly missingPiaMembers: ReadonlyArray<string>;
}

export function derivePiaState(
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
  ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>,
): PiaState {
  const primary = members.find((m) => m.payload.isPrimary);
  const secondary = members.find((m) => !m.payload.isPrimary);
  const piaByMember = new Map<string, number | null>();
  for (const b of ssBenefits) {
    piaByMember.set(b.payload.householdMemberId, b.payload.pia ?? null);
  }
  const missing: string[] = [];
  const primaryHasPia =
    primary !== undefined && (piaByMember.get(primary.id) ?? null) !== null;
  if (primary && !primaryHasPia) missing.push(primary.id);
  const secondaryHasPia =
    secondary !== undefined && (piaByMember.get(secondary.id) ?? null) !== null;
  if (secondary && !secondaryHasPia) missing.push(secondary.id);
  return { primaryHasPia, secondaryHasPia, missingPiaMembers: missing };
}

export interface Triple {
  readonly scenarioId: string;
  readonly scenarioIdx: number;
  readonly pairIdx: number;
  readonly primaryAgeYears: number;
  readonly secondaryAgeYears: number | null;
  readonly overlay: {
    readonly socialSecurity: {
      readonly primary: RetirementAgePerMember;
      readonly secondary?: RetirementAgePerMember;
      /** The candidate's survivor claim-age dimension (the stored,
       *  validated ages) — carried so MC evaluates the same plan the
       *  deterministic candidates simulate. Absent → the resolved
       *  scenario's stored survivor section applies downstream. */
      readonly survivor?: SurvivorClaimAges;
    };
  };
}

interface PreSeededOutcome {
  readonly scenarioId: string;
  readonly outcome: OptimizerMcOutcome;
}

export interface TriplesBundle {
  readonly list: ReadonlyArray<Triple>;
  readonly scenarioCount: number;
  readonly pairCount: number;
  /** Empty-grid scenarios that never reach the worker — seed past-
   *  window / both-missing-PIA outcomes up-front so the page doesn't
   *  stall on them. */
  readonly preSeededOutcomes: ReadonlyArray<PreSeededOutcome>;
}

export interface BuildTriplesArgs {
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  readonly today: Date;
  readonly stepYears: number;
}

export function buildTriples(args: BuildTriplesArgs): TriplesBundle {
  const nonDeleted = args.scenarios.filter((s) => !s.deletedAt);
  const primary = args.members.find((m) => m.payload.isPrimary);
  const secondary = args.members.find((m) => !m.payload.isPrimary);
  const piaState = derivePiaState(args.members, args.ssBenefits);
  const primaryGrid = primary
    ? subSampleGrid(
        buildCandidateGrid({
          memberAgeYearsToday: ageYearsToday(primary.payload.birthdate, args.today),
          hasPia: piaState.primaryHasPia,
        }),
        args.stepYears,
      )
    : [];
  const secondaryGrid = secondary
    ? subSampleGrid(
        buildCandidateGrid({
          memberAgeYearsToday: ageYearsToday(secondary.payload.birthdate, args.today),
          hasPia: piaState.secondaryHasPia,
        }),
        args.stepYears,
      )
    : [];
  const list: Triple[] = [];
  const preSeededOutcomes: PreSeededOutcome[] = [];
  let scenarioIdx = 0;
  for (const sc of nonDeleted) {
    scenarioIdx += 1;
    // Scenario-aware empty-state routing. When the scenario's
    // resolved chain has no retirement date AND we'd otherwise pre-seed
    // a `missing-pia`/`past-window` outcome (both grids empty), the
    // user needs the "Set a primary retirement age…" copy — not the
    // misleading "Add PIAs" callout. Mirrors `hasResolvedRetirementDate`
    // in claim-age-optimizer.worker.ts (which the deterministic path
    // checks before dispatching to the engine). Scenarios with a usable
    // grid keep their existing routing — `processTriple` catches a
    // `NoPrimaryRetirementError` thrown mid-sweep and surfaces the same
    // `empty: no-retirement-date` outcome.
    const scenarioMissingRetirementDate = !hasResolvedRetirementDate({
      scenarioId: sc.id,
      scenarios: args.scenarios,
      members: args.members,
    });
    // Handle every empty-grid combination explicitly. Mirrors
    // `buildPairs` in claim-age-optimizer/orchestrator-helpers.ts.
    if (!secondary) {
      if (primaryGrid.length === 0) {
        preSeededOutcomes.push({
          scenarioId: sc.id,
          outcome: scenarioMissingRetirementDate
            ? noRetirementDateOutcome()
            : pastWindowOrMissingPia(piaState),
        });
        continue;
      }
      appendSingleMemberTriples({
        list,
        primaryGrid,
        scenarioId: sc.id,
        scenarioIdx,
      });
      continue;
    }
    if (primaryGrid.length === 0 && secondaryGrid.length === 0) {
      preSeededOutcomes.push({
        scenarioId: sc.id,
        outcome: scenarioMissingRetirementDate
          ? noRetirementDateOutcome()
          : pastWindowOrMissingPia(piaState),
      });
      continue;
    }
    const resolved = resolveScenario(sc.id, [...args.scenarios]);
    // The survivor claim-age dimension carries the user's stored
    // survivor age VERBATIM (at most one candidate; out-of-window → inert,
    // falling back to the same stored section everywhere) onto every triple
    // so MC evaluates the SAME plan the deterministic candidates simulate.
    const survivor = primary
      ? buildSurvivorDimension({
          primary,
          secondary,
          piaState,
          resolved,
        }).candidates[0]?.survivor
      : undefined;
    if (secondaryGrid.length === 0) {
      appendPrimaryOnlyTriples({
        list,
        primaryGrid,
        secondaryFallback:
          resolved.socialSecurity?.secondary ?? DEFAULT_SECONDARY_CLAIM_AGE,
        scenarioId: sc.id,
        scenarioIdx,
        survivor,
      });
      continue;
    }
    if (primaryGrid.length === 0) {
      appendSecondaryOnlyTriples({
        list,
        secondaryGrid,
        primaryFallback:
          resolved.socialSecurity?.primary ?? DEFAULT_PRIMARY_CLAIM_AGE,
        scenarioId: sc.id,
        scenarioIdx,
        survivor,
      });
      continue;
    }
    appendJointTriples({
      list,
      primaryGrid,
      secondaryGrid,
      scenarioId: sc.id,
      scenarioIdx,
      survivor,
    });
  }
  const pairsPerScenario = secondary
    ? Math.max(
        1,
        primaryGrid.length * secondaryGrid.length,
        primaryGrid.length,
        secondaryGrid.length,
      )
    : Math.max(1, primaryGrid.length);
  return {
    list,
    scenarioCount: nonDeleted.length,
    pairCount: pairsPerScenario,
    preSeededOutcomes,
  };
}

function appendSingleMemberTriples(opts: {
  list: Triple[];
  primaryGrid: ReadonlyArray<number>;
  scenarioId: string;
  scenarioIdx: number;
}): void {
  let pairIdx = 0;
  for (const p of opts.primaryGrid) {
    pairIdx += 1;
    opts.list.push({
      scenarioId: opts.scenarioId,
      scenarioIdx: opts.scenarioIdx,
      pairIdx,
      primaryAgeYears: p,
      secondaryAgeYears: null,
      overlay: {
        socialSecurity: { primary: { ageYears: p, ageMonths: 0 } },
      },
    });
  }
}

function appendPrimaryOnlyTriples(opts: {
  list: Triple[];
  primaryGrid: ReadonlyArray<number>;
  secondaryFallback: RetirementAgePerMember;
  scenarioId: string;
  scenarioIdx: number;
  survivor?: SurvivorClaimAges;
}): void {
  let pairIdx = 0;
  for (const p of opts.primaryGrid) {
    pairIdx += 1;
    opts.list.push({
      scenarioId: opts.scenarioId,
      scenarioIdx: opts.scenarioIdx,
      pairIdx,
      primaryAgeYears: p,
      secondaryAgeYears: null,
      overlay: {
        socialSecurity: {
          primary: { ageYears: p, ageMonths: 0 },
          secondary: opts.secondaryFallback,
          ...(opts.survivor ? { survivor: opts.survivor } : {}),
        },
      },
    });
  }
}

function appendSecondaryOnlyTriples(opts: {
  list: Triple[];
  secondaryGrid: ReadonlyArray<number>;
  primaryFallback: RetirementAgePerMember;
  scenarioId: string;
  scenarioIdx: number;
  survivor?: SurvivorClaimAges;
}): void {
  let pairIdx = 0;
  for (const s of opts.secondaryGrid) {
    pairIdx += 1;
    opts.list.push({
      scenarioId: opts.scenarioId,
      scenarioIdx: opts.scenarioIdx,
      pairIdx,
      primaryAgeYears: opts.primaryFallback.ageYears,
      secondaryAgeYears: s,
      overlay: {
        socialSecurity: {
          primary: opts.primaryFallback,
          secondary: { ageYears: s, ageMonths: 0 },
          ...(opts.survivor ? { survivor: opts.survivor } : {}),
        },
      },
    });
  }
}

function appendJointTriples(opts: {
  list: Triple[];
  primaryGrid: ReadonlyArray<number>;
  secondaryGrid: ReadonlyArray<number>;
  scenarioId: string;
  scenarioIdx: number;
  survivor?: SurvivorClaimAges;
}): void {
  let pairIdx = 0;
  for (const p of opts.primaryGrid) {
    for (const s of opts.secondaryGrid) {
      pairIdx += 1;
      opts.list.push({
        scenarioId: opts.scenarioId,
        scenarioIdx: opts.scenarioIdx,
        pairIdx,
        primaryAgeYears: p,
        secondaryAgeYears: s,
        overlay: {
          socialSecurity: {
            primary: { ageYears: p, ageMonths: 0 },
            secondary: { ageYears: s, ageMonths: 0 },
            ...(opts.survivor ? { survivor: opts.survivor } : {}),
          },
        },
      });
    }
  }
}

/**
 * Does a whole-year candidate pair sit exactly at the scenario's current
 * (resolved) claim ages? Mirrors the deterministic path's `pairsEqual`
 * (the resolved override's ageMonths must be 0 to match a
 * whole-year candidate). Used both for `alreadyAtOptimum` and to capture
 * the baseline metric value at the current claim ages.
 */
export function matchesCurrentClaim(
  primaryAgeYears: number,
  secondaryAgeYears: number | null,
  resolved: SocialSecurityOverride | undefined,
): boolean {
  if (!resolved) return false;
  if (primaryAgeYears !== resolved.primary.ageYears) return false;
  if ((resolved.primary.ageMonths ?? 0) !== 0) return false;
  const resSec = resolved.secondary?.ageYears ?? null;
  if (secondaryAgeYears !== resSec) return false;
  if ((resolved.secondary?.ageMonths ?? 0) !== 0) return false;
  return true;
}

export function isAlreadyAtOptimum(
  winner: OptimizerMcWinner,
  resolved: SocialSecurityOverride | undefined,
): boolean {
  return matchesCurrentClaim(
    winner.primaryAgeYears,
    winner.secondaryAgeYears,
    resolved,
  );
}

export function derivePartial(opts: {
  readonly piaState: { primaryHasPia: boolean; secondaryHasPia: boolean };
  readonly hasSecondary: boolean;
  readonly winner: OptimizerMcWinner | null;
}): boolean {
  if (!opts.piaState.primaryHasPia) return true;
  if (opts.hasSecondary && !opts.piaState.secondaryHasPia) return true;
  if (opts.winner === null) return true;
  if (opts.hasSecondary && opts.winner.secondaryAgeYears === null) return true;
  return false;
}

function subSampleGrid(
  grid: ReadonlyArray<number>,
  stepYears: number,
): ReadonlyArray<number> {
  if (stepYears <= 1) return grid;
  const out: number[] = [];
  for (let i = 0; i < grid.length; i += stepYears) {
    out.push(grid[i]);
  }
  return out;
}

/**
 * Precheck. Returns the `empty` reason when the household state
 * can't resolve any scenario's primary retirement date — independent
 * of scenario-level overrides. Per-scenario `retirementAge` overrides
 * that fail are surfaced as `NoPrimaryRetirementError` during the
 * per-triple call and handled there.
 */
export function derivePrecheckEmpty(args: {
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
}): 'no-primary-member' | 'no-retirement-date' | null {
  const primary = args.members.find((m) => m.payload.isPrimary);
  if (!primary) return 'no-primary-member';
  // If the primary's birthdate isn't a valid ISO date, every
  // scenario's `resolveMemberRetirementDates` returns null —
  // surface up-front rather than waiting for the first triple to
  // throw. Probe with a `{ primary: { ageYears: 67, ageMonths: 0 } }`
  // synthetic retirementAge (matches the deterministic worker's
  // shape-check on `hasResolvableRetirementDate`).
  const probe = resolveMemberRetirementDates(
    { primary: { ageYears: 67, ageMonths: 0 } },
    [{ id: primary.id, isPrimary: true, birthdate: primary.payload.birthdate ?? '' }],
  );
  if ((probe.get(primary.id) ?? null) === null) return 'no-retirement-date';
  return null;
}
