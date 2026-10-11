/**
 * Per-candidate at-horizon metric for the claim-age optimizer.
 *
 * This module is a thin wrapper around `runBalanceProjection`
 * (the shared BPP-equivalent pipeline). The candidate's SS pair is
 * applied as a transient top-of-chain overlay; the runner re-resolves
 * the scenario chain, walks every BPP routing path (CBP election,
 * targeted-deposit accumulation, post-primary contribution synthesis,
 * per-account `project()` + drawdown), and returns the at-horizon
 * Today's-dollar balance. For the Monte Carlo metric, this module
 * delegates to the injected `mcRunner` — the runner the page wires up
 * lives in `optimizer-mc-runner.ts` and owns the `monte-carlo.worker.ts`
 * lifecycle.
 *
 * The SS-dependent slice still rebuilds per candidate — that
 * rebuild is now part of `runBalanceProjection`'s pipeline (resolves
 * scenario → builds SS context → projects SS by month → folds into
 * `buildMonthlyIncomeSeries`). The overlay carries the candidate SS
 * pair, so every per-candidate call sees a different SS slice.
 *
 * Deterministic metric values are in today's dollars —
 * `realDeflatorAt(ctx, horizonYear, 11)` (December anchor, matching
 * the Balance Projection page's Today's-dollars convention). The runner
 * applies the deflator before returning.
 */
import type { ScenarioAggregate } from '../scenario-resolution';
import { resolveScenario } from '../scenario-resolution';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  RetirementAgePerMember,
  SocialSecurityBenefitPayload,
} from '../../db/types';
import { runBalanceProjection } from '../balance-projection-runner';
import type { ProjectionMethod } from '../balance-projection-runner-types';
import type { OptimizerMcRunner, SurvivorClaimAges } from './types';

export type OptimizerMetric = 'balance' | 'mc';

/** Sentinel returned by `simulateOneCandidate` when the requested
 *  deterministic `projectionMethod` is `'twr'` and the Historical method
 *  is unavailable (degenerate case: all active non-CBP accounts lack
 *  empirical TWR history) — i.e. the metric is unranked for
 *  this scenario. `pickWinner` is short-circuited by the orchestrator in
 *  that case, so this sentinel never lands in a CandidateResult's
 *  `metricValue`. */
const TWR_METHOD_UNAVAILABLE = Number.NaN;

export interface SimulateOneCandidateArgs {
  readonly scenario: ScenarioAggregate;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly candidate: {
    readonly primary: RetirementAgePerMember;
    readonly secondary?: RetirementAgePerMember;
    /** Survivor claim-age dimension (absent for single-member plans /
     *  inert dimension — the projection then withholds survivor results). */
    readonly survivor?: SurvivorClaimAges;
  };
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  readonly expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  /** Flag-derived medical category ids — threaded into the
   *  deterministic projection so the +2pp medical-inflation default follows
   *  the flag. */
  readonly medicalCategoryIds?: ReadonlyArray<string>;
  readonly metric: OptimizerMetric;
  readonly today: Date;
  readonly mcRunner?: OptimizerMcRunner;
  /** Defaults to `'planned'` for the deterministic metric. `'twr'`
   *  routes per-account rates through the empirical TWR derivation. */
  readonly projectionMethod?: ProjectionMethod;
}

export async function simulateOneCandidate(
  args: SimulateOneCandidateArgs,
): Promise<number> {
  if (args.metric === 'mc') {
    if (!args.mcRunner) {
      throw new Error("simulateOneCandidate: metric='mc' requires an mcRunner");
    }
    const resolved = resolveScenario(args.scenario.id, [...args.scenarios]);
    const summary = await args.mcRunner({
      scenario: args.scenario,
      scenarios: args.scenarios,
      resolved,
      candidate: args.candidate,
    });
    return summary.successProbability;
  }
  // Deterministic — route through the BPP-equivalent helper with the
  // candidate SS pair as an overlay.
  const result = runBalanceProjection({
    scenarioId: args.scenario.id,
    scenarios: args.scenarios,
    accounts: args.accounts,
    balances: args.balances,
    members: args.members,
    ssBenefits: args.ssBenefits,
    expenses: args.expenses,
    incomeStreams: args.incomeStreams,
    medicalCategoryIds: args.medicalCategoryIds,
    // numbers-in. Optimizer keeps UTC for cross-machine
    // reproducibility of the candidate ranking grid.
    todayYear: args.today.getUTCFullYear(),
    todayMonthIndex: args.today.getUTCMonth(),
    method: args.projectionMethod ?? 'planned',
    candidateOverlay: {
      socialSecurity: {
        primary: args.candidate.primary,
        ...(args.candidate.secondary
          ? { secondary: args.candidate.secondary }
          : {}),
        // The corrected SS context — the candidate's survivor claim-age
        // dimension rides the overlay so each simulation runs the
        // worker/survivor rules against explicit ages.
        ...(args.candidate.survivor ? { survivor: args.candidate.survivor } : {}),
      },
    },
  });
  if (!result.methodAvailable) return TWR_METHOD_UNAVAILABLE;
  return result.atHorizonTodayDollars;
}
