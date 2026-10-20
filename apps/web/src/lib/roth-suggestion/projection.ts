/**
 * One planned-basis projection per call, with the bookkeeping a worker-safe
 * search needs around it: a count of projections run, a macrotask yield so a
 * cancel message can be delivered between projections, an abort check before
 * each one, and a progress tick after it.
 *
 * Each projection runs the same three steps as `runBalanceProjection`
 * (pipeline context, cashflow series, planned drawdown) but keeps the raw
 * `DrawdownYear` rows, which carry the per-account balances the after-tax
 * ranking reads and that the thinned public result drops.
 */
import type { MagiCapWindow } from '../../db/types';
import { buildCashflowSeries } from '../balance-projection-runner-cashflow';
import { buildPipelineContext } from '../balance-projection-runner-context';
import { runDrawdownForMethod } from '../balance-projection-runner-drawdown';
import type {
  CashflowSeries,
  PipelineContext,
  RunBalanceProjectionArgs,
} from '../balance-projection-runner-types';
import type { DrawdownYear } from '../drawdown-engine-types';
import type { ProjectionContext } from '../projection-context';
import { overlayScenarios } from './overlay';
import type { RothSuggestionProgress, RothSuggestionRequest } from './types';

/** Hard ceiling on projections per search, a worker's time budget. */
export const MAX_PROJECTIONS = 500;

/** A pipeline context and its cashflow series, reusable while the inputs that
 *  feed them (not the ladder) stay put. */
export interface PreparedProjection {
  readonly ctx: PipelineContext;
  readonly series: CashflowSeries;
}

export interface PlannedProjection {
  readonly years: readonly DrawdownYear[];
  readonly projCtx: ProjectionContext;
  readonly horizonYear: number;
  readonly atHorizonTodayDollars: number;
}

/** Thrown inside the search when its AbortSignal aborts; the orchestrator
 *  turns it into a `cancelled` result. */
export class RothSuggestionCancelled extends Error {
  constructor() {
    super('Roth suggestion search cancelled');
    this.name = 'RothSuggestionCancelled';
  }
}

/** Projection arguments for the target scenario with the death ages and,
 *  when given, a candidate ladder placed on it. */
export function buildProjectionArgs(
  request: RothSuggestionRequest,
  ladder: readonly MagiCapWindow[] | undefined,
): RunBalanceProjectionArgs {
  const { projection, deathAges } = request;
  return {
    scenarioId: projection.selectedScenarioId,
    scenarios: overlayScenarios({
      scenarios: projection.scenarios,
      scenarioId: projection.selectedScenarioId,
      deathAges,
      ...(ladder !== undefined ? { ladder } : {}),
    }),
    accounts: [...projection.accounts],
    balances: [...projection.balances],
    members: [...projection.members],
    ssBenefits: [...projection.ssBenefits],
    expenses: [...projection.expenses],
    incomeStreams: [...projection.incomeStreams],
    todayYear: projection.todayYear,
    todayMonthIndex: projection.todayMonthIndex,
    method: 'planned',
    ...(projection.bundle !== undefined ? { taxBundle: projection.bundle } : {}),
  };
}

/** The pipeline context and cashflow series for `args`, or null when the
 *  household has no primary member or no resolvable retirement date. */
export function prepareProjection(args: RunBalanceProjectionArgs): PreparedProjection | null {
  const ctx = buildPipelineContext(args);
  return ctx === null ? null : { ctx, series: buildCashflowSeries(args, ctx) };
}

/** The planned drawdown for a prepared projection, or null when the scenario
 *  has no portfolio to draw down. Throws what the engine throws for a missing
 *  custom drawdown order or an uncalibrated cap window. */
function runPlannedDrawdown(
  args: RunBalanceProjectionArgs,
  prepared: PreparedProjection,
): PlannedProjection | null {
  const { ctx, series } = prepared;
  const result = runDrawdownForMethod(args, ctx, series, 'planned');
  if (result === null || result.years.length === 0) return null;
  return {
    years: result.years,
    projCtx: ctx.projCtx,
    horizonYear: ctx.horizonYear,
    atHorizonTodayDollars: result.atHorizonTodayDollars,
  };
}

/** Lets the event loop deliver queued messages. A resolved `await` is a
 *  microtask and does not drain the macrotask queue a worker's cancel message
 *  waits in, so this schedules a real task. */
function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export interface ProjectionRunner {
  readonly projectionsRun: () => number;
  /** Runs one projection; throws `RothSuggestionCancelled` when aborted. */
  readonly project: (
    ladder: readonly MagiCapWindow[] | undefined,
    prepared?: PreparedProjection,
  ) => Promise<PlannedProjection | null>;
  /** Reports progress after a projection; `candidateFinished` counts the
   *  candidate that projection completed. Silent once aborted. */
  readonly tick: (candidateFinished: boolean) => void;
}

export function createProjectionRunner(
  request: RothSuggestionRequest,
  candidatesTotal: number,
): ProjectionRunner {
  let run = 0;
  let candidatesDone = 0;
  const { signal, onProgress } = request;
  return {
    projectionsRun: () => run,
    project: async (ladder, prepared) => {
      await yieldMacrotask();
      if (signal?.aborted === true) throw new RothSuggestionCancelled();
      if (run >= MAX_PROJECTIONS) {
        throw new Error(`Roth suggestion search exceeded ${MAX_PROJECTIONS} projections`);
      }
      run += 1;
      const args = buildProjectionArgs(request, ladder);
      return runPlannedDrawdown(args, prepared ?? requirePrepared(args));
    },
    tick: (candidateFinished) => {
      if (candidateFinished) candidatesDone += 1;
      if (signal?.aborted === true || onProgress === undefined) return;
      const progress: RothSuggestionProgress = {
        projectionsRun: run,
        candidatesDone,
        candidatesTotal,
      };
      onProgress(progress);
    },
  };
}

function requirePrepared(args: RunBalanceProjectionArgs): PreparedProjection {
  const prepared = prepareProjection(args);
  if (prepared === null) throw new Error('Candidate projection lost its primary member');
  return prepared;
}
