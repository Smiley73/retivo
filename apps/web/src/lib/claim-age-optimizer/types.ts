/**
 * Shared types for the claim-age optimizer engine. Kept separate from
 * `simulate-candidate.ts` so the barrel + tests can import the MC
 * runner shape without pulling the projection dependencies.
 */
import type { ScenarioAggregate } from '../scenario-resolution';
import type {
  RetirementAgePerMember,
  ScenarioOverrides,
} from '../../db/types';

/** Minimal MC-summary shape the optimizer consumes. Mirrors the
 *  subset of `monte-carlo.ts`'s `MonteCarloResult.summary` the page
 *  needs — the MC runner supplies it. */
interface MonteCarloRunSummary {
  /** 0..1 fraction of paths that didn't deplete by horizon. */
  readonly successProbability: number;
}

/**
 * Per-member SURVIVOR claim ages carried on a candidate — the
 * independent survivor claim-age dimension. Distinct from the own claim
 * ages: the optimizer bakes the RESOLVED survivor ages into every
 * candidate VERBATIM (`buildSurvivorCandidateGrid` is verbatim-or-inert —
 * never a transformed value) so each simulation runs the corrected
 * worker/survivor context; absent member keys fall back to the resolved
 * stored section (or, with none stored, the withheld-survivor-results
 * state).
 */
export interface SurvivorClaimAges {
  readonly primary?: RetirementAgePerMember;
  readonly secondary?: RetirementAgePerMember;
}

interface OptimizerMcRunnerArgs {
  readonly scenario: ScenarioAggregate;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly resolved: ScenarioOverrides;
  readonly candidate: {
    readonly primary: RetirementAgePerMember;
    readonly secondary?: RetirementAgePerMember;
    /** Survivor claim-age dimension — absent for single-member plans. */
    readonly survivor?: SurvivorClaimAges;
  };
}

/** Injected dependency — supplied by the MC orchestrator. */
export type OptimizerMcRunner = (
  args: OptimizerMcRunnerArgs,
) => Promise<MonteCarloRunSummary>;
