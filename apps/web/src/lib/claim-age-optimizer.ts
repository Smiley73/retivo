/**
 * Claim-age optimizer engine — barrel. Re-exports the four engine
 * modules (`build-grid`, `simulate-candidate`, `pick-winner`,
 * `merge-ss-override`) and provides the top-level
 * `optimiseClaimAgesForScenario` orchestrator the page + worker call.
 */
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
  /** Flag-derived medical category ids — threaded into each candidate's
   *  projection so the +2pp medical-inflation default follows the flag. */
  readonly medicalCategoryIds?: ReadonlyArray<string>;
  readonly metric: OptimizerMetric;
  readonly today: Date;
  readonly mcRunner?: OptimizerMcRunner;
  /** Defaults to `'planned'` — every existing caller continues to read
   *  planned. The deterministic optimizer page passes `'twr'` for the
   *  TWR child row; the runner uses empirical per-account rates. */
  readonly projectionMethod?: ProjectionMethod;
}

export interface OptimizerResult {
  readonly winner: Winner | null;
  /** True when the search was forced to skip part of the joint grid —
   *  e.g. one member's PIA missing (1-D fallback) or past the claim-age
   *  window. The page surfaces this on the row. */
  readonly partial: boolean;
  /** Members whose PIA is unset — surfaces a per-row callout linking to
   *  /social-security. */
  readonly missingPiaMembers: ReadonlyArray<string>;
  /** The metric value (at-horizon balance / MC success) at the scenario's
   *  CURRENT resolved claim ages — the baseline the page renders as
   *  "current → recommended". `undefined` when the current pair isn't a
   *  whole-year candidate in the searched grid (so there's no exact
   *  baseline to show). */
  readonly baselineMetricValue?: number;
  /** True when `projectionMethod === 'twr'` and at least one active
   *  non-CBP account has insufficient (< 2 yr) balance history. The
   *  orchestrator detects this on the first candidate (the answer
   *  doesn't depend on the SS overlay) and short-circuits the rest of
   *  the grid. The page reads this to render the TWR child row's
   *  "Insufficient history" message. */
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
  const resolvedPair = resolvedSsPair(resolved.socialSecurity, secondary !== undefined);
  // The independent survivor claim-age dimension for supported
  // two-spouse scenarios (death order from resolved life expectancies —
  // either spouse can be the survivor). Individual own-claim grids stay
  // unchanged; an inert dimension leaves candidates survivor-free so the
  // simulation runs the withheld-survivor state.
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
    // `TWR_METHOD_UNAVAILABLE === Number.NaN`. NaN compares unequal to
    // itself, so this is the right discriminator — only the runner's
    // short-circuit ever emits NaN here.
    if (Number.isNaN(value)) {
      // TWR insufficient — same answer for every candidate, abort grid.
      return { results, twrInsufficient: true };
    }
    results.push({
      primaryAgeYears: pair.primaryAgeYears,
      secondaryAgeYears: pair.secondaryAgeYears,
      metricValue: value,
    });
  }
  return { results, twrInsufficient: false };
}

// Re-exported names — keep alphabetical with the imports so adding a
// new export is a one-line change.
