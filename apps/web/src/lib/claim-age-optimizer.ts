// Claim-age optimizer engine barrel: re-exports the engine modules and provides `optimiseClaimAgesForScenario`, the orchestrator the page and worker call.

import type { ScenarioAggregate } from './scenario-resolution';
import { resolveScenario } from './scenario-resolution';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import {
  simulateOneCandidate,
  type OptimizerMetric,
} from './claim-age-optimizer/simulate-candidate';
import type { ProjectionMethod } from './balance-projection-runner-types';
import {
  pickWinner,
  baselineMetricForResolved,
  type CandidateResult,
  type Winner,
} from './claim-age-optimizer/pick-winner';
import type { OptimizerMcRunner } from './claim-age-optimizer/types';
import {
  buildGrids,
  buildPairs,
  buildSurvivorDimension,
  derivePiaState,
  findMembers,
  resolvedSsPair,
  type PairSpec,
} from './claim-age-optimizer/orchestrator-helpers';

export {
  mergeSsOverride,
} from './claim-age-optimizer/merge-ss-override';

export interface OptimiseClaimAgesArgs {
  readonly scenario: ScenarioAggregate;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  readonly expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  /** Threaded into each candidate's projection so the +2pp medical-inflation default follows the flag. */
  readonly medicalCategoryIds?: ReadonlyArray<string>;
  readonly metric: OptimizerMetric;
  readonly today: Date;
  readonly mcRunner?: OptimizerMcRunner;
  /** Defaults to `'planned'`; the deterministic optimizer page passes `'twr'` for the TWR child row. */
  readonly projectionMethod?: ProjectionMethod;
}

export interface OptimizerResult {
  readonly winner: Winner | null;
  /** True when part of the joint grid was skipped (a member's PIA missing, or past the claim-age window); the page surfaces it on the row. */
  readonly partial: boolean;
  /** Members with no PIA set; the row links to /social-security. */
  readonly missingPiaMembers: ReadonlyArray<string>;
  /** The metric at the scenario's current claim ages, shown as "current → recommended"; undefined when the current pair is not a candidate. */
  readonly baselineMetricValue?: number;
  /** `'twr'` with an active non-CBP account under two years of history; detected on the first candidate, which short-circuits the grid. */
  readonly twrInsufficient?: boolean;
}

export async function optimiseClaimAgesForScenario(
  args: OptimiseClaimAgesArgs,
): Promise<OptimizerResult> {
  const { primary, secondary } = findMembers(args.members);
  if (!primary) {
    return { winner: null, partial: true, missingPiaMembers: [] };
  }
  const piaState = derivePiaState({
    primary,
    secondary,
    ssBenefits: args.ssBenefits,
  });
  const grids = buildGrids({ primary, secondary, piaState, today: args.today });
  const resolved = resolveScenario(args.scenario.id, [...args.scenarios]);
  const resolvedPair = resolvedSsPair(
    resolved.socialSecurity,
    secondary !== undefined && grids.secondary.length > 0,
  );
  // The independent survivor claim-age dimension for supported two-spouse scenarios; an inert one leaves candidates survivor-free.
  const survivorDimension = buildSurvivorDimension({
    primary,
    secondary,
    piaState,
    resolved,
  });
  const pairs = buildPairs({
    primaryGrid: grids.primary,
    secondaryGrid: grids.secondary,
    hasSecondary: secondary !== undefined,
    resolvedOverride: resolved.socialSecurity,
    survivorDimension,
  });
  const partial = grids.partial;
  if (pairs.length === 0) {
    return { winner: null, partial, missingPiaMembers: piaState.missingPiaMembers };
  }
  const candidatesResult = await runCandidates({ pairs, args });
  if (candidatesResult.twrInsufficient) {
    return {
      winner: null,
      partial,
      missingPiaMembers: piaState.missingPiaMembers,
      twrInsufficient: true,
    };
  }
  const winner = pickWinner({
    results: candidatesResult.results,
    currentResolvedPair: resolvedPair,
  });
  const baselineMetricValue = baselineMetricForResolved(
    candidatesResult.results,
    resolvedPair,
  );
  return {
    winner,
    partial,
    missingPiaMembers: piaState.missingPiaMembers,
    baselineMetricValue,
  };
}

interface RunCandidatesOut {
  readonly results: CandidateResult[];
  readonly twrInsufficient: boolean;
}

async function runCandidates(args: {
  pairs: ReadonlyArray<PairSpec>;
  args: OptimiseClaimAgesArgs;
}): Promise<RunCandidatesOut> {
  const results: CandidateResult[] = [];
  for (const pair of args.pairs) {
    const value = await simulateOneCandidate({
      scenario: args.args.scenario,
      scenarios: args.args.scenarios,
      candidate: pair.candidate,
      accounts: args.args.accounts,
      balances: args.args.balances,
      members: args.args.members,
      ssBenefits: args.args.ssBenefits,
      expenses: args.args.expenses,
      incomeStreams: args.args.incomeStreams,
      medicalCategoryIds: args.args.medicalCategoryIds,
      metric: args.args.metric,
      today: args.args.today,
      mcRunner: args.args.mcRunner,
      projectionMethod: args.args.projectionMethod,
    });
    // `TWR_METHOD_UNAVAILABLE` is NaN, which only the runner's short-circuit emits.
    if (Number.isNaN(value)) {
      return { results, twrInsufficient: true };
    }
    results.push({
      primaryAgeYears: pair.primaryAgeYears,
      ...(pair.primaryAgeMonths !== undefined
        ? { primaryAgeMonths: pair.primaryAgeMonths }
        : {}),
      secondaryAgeYears: pair.secondaryAgeYears,
      ...(pair.secondaryAgeMonths !== undefined
        ? { secondaryAgeMonths: pair.secondaryAgeMonths }
        : {}),
      metricValue: value,
    });
  }
  return { results, twrInsufficient: false };
}
