// Monte Carlo orchestrator for the claim-age optimizer: fans every `(scenario, primaryAge, secondaryAge)`
// triple across a pool of `monte-carlo.worker.ts` workers and keeps the best success probability per scenario.

import {
  CbpUnconfiguredError,
  NoPrimaryRetirementError,
} from './balance-projection-runner';
import {
  buildOptimizerMcScenarioSetup,
  OPTIMIZER_MC_SEED,
  type OptimizerMcScenarioSetup,
} from './balance-projection-runner-mc';
import { ENGINE_VERSION } from './monte-carlo';
import { resolveScenario, type ScenarioAggregate } from './scenario-resolution';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
  SocialSecurityOverride,
} from '../db/types';
import { DEFAULT_LIFE_EXPECTANCY_AGE } from '../db/types';
import type { MonteCarloInput } from './monte-carlo';
import { totalMonths } from './claim-age-optimizer/pick-winner';
// Vite `?worker` import.
import MCWorker from '../workers/monte-carlo.worker.ts?worker';
import {
  createMcPool,
  mcPoolSize,
  type MinimalMcWorker,
} from '../monte-carlo/mc-worker-pool';
import {
  buildTriples,
  derivePartial,
  derivePiaState,
  derivePrecheckEmpty,
  isAlreadyAtOptimum,
  matchesCurrentClaim,
  type PiaState,
  type Triple,
} from './optimizer-mc-runner-helpers';
import type {
  OptimizerMcOutcome,
  OptimizerMcResult,
  OptimizerMcScenarioProgress,
  OptimizerMcWinner,
} from './optimizer-mc-runner-types';

export type {
  OptimizerMcOutcome,
  OptimizerMcResult,
  OptimizerMcScenarioProgress,
} from './optimizer-mc-runner-types';

// Whole-year grid step; 2 gives the coarse 25-pair grid.
const OPTIMIZER_MC_CANDIDATE_STEP_YEARS = 1;
/** Fallback MC path count per triple when the caller passes no `pathCount`. */
export const OPTIMIZER_MC_DEFAULT_PATH_COUNT = 1000;

// Bounded so adversarial input variation cannot grow the cache without limit; LRU eviction.
const OPTIMIZER_MC_CACHE_MAX_ENTRIES = 500;

// Per-scenario outcome keyed on a hash of every optimizer-relevant input. Warm for the page session, cold on reload.
// A Map keeps insertion order, so the first key is the LRU victim and a hit re-inserts.
const optimizerOutcomeCache = new Map<string, OptimizerMcOutcome>();

function cacheGet(key: string): OptimizerMcOutcome | undefined {
  const hit = optimizerOutcomeCache.get(key);
  if (hit === undefined) return undefined;
  optimizerOutcomeCache.delete(key);
  optimizerOutcomeCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, outcome: OptimizerMcOutcome): void {
  if (optimizerOutcomeCache.has(key)) optimizerOutcomeCache.delete(key);
  optimizerOutcomeCache.set(key, outcome);
  while (optimizerOutcomeCache.size > OPTIMIZER_MC_CACHE_MAX_ENTRIES) {
    const oldest = optimizerOutcomeCache.keys().next().value;
    if (oldest === undefined) break;
    optimizerOutcomeCache.delete(oldest);
  }
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Sorted by id; the payload is serialised too so a payload edit without a version bump still misses.
function aggregateSignature(
  list: ReadonlyArray<{ id: string; version: number; payload: unknown }>,
): unknown {
  return list
    .map((a) => ({ id: a.id, version: a.version, payload: a.payload }))
    .sort((x, y) => x.id.localeCompare(y.id));
}

// Includes every optimizer-relevant input (scenario graph, data, path count, today, step, seed, `ENGINE_VERSION`).
function optimizerCacheKey(
  args: RunOptimizerMonteCarloArgs,
  scenarioId: string,
  pathCount: number,
  stepYears: number,
): string {
  const payload = {
    scenarioId,
    scenarios: aggregateSignature(args.scenarios),
    accounts: aggregateSignature(args.accounts),
    balances: aggregateSignature(args.balances),
    members: aggregateSignature(args.members),
    ssBenefits: aggregateSignature(args.ssBenefits),
    expenses: aggregateSignature(args.expenses),
    incomeStreams: aggregateSignature(args.incomeStreams),
    // Sorted, so a flag-set change gives a fresh key and a stale cached setup never returns wrong rankings.
    medicalCategoryIds: [...(args.medicalCategoryIds ?? [])].sort(),
    pathCount,
    stepYears,
    seed: OPTIMIZER_MC_SEED,
    todayYear: args.today.getUTCFullYear(),
    todayMonthIndex: args.today.getUTCMonth(),
    engineVersion: ENGINE_VERSION,
  };
  return fnv1a(JSON.stringify(payload));
}

export interface OptimizerMcProgress {
  readonly scenarioIdx: number;
  readonly pairIdx: number;
  /** Global 1-based triple index, so 1-D fallbacks do not overshoot the joint-product expectation. */
  readonly cumulativeIdx: number;
  readonly totals: {
    readonly scenarios: number;
    readonly pairs: number;
    readonly totalPairs: number;
  };
}

export interface RunOptimizerMonteCarloArgs {
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  readonly expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  /** Flag-derived medical category ids: they set the +2pp medical-inflation default and are part of the cache signature. */
  readonly medicalCategoryIds?: ReadonlyArray<string>;
  readonly today: Date;
  readonly candidateStepYears?: number;
  readonly pathCount?: number;
  readonly onProgress?: (p: OptimizerMcProgress) => void;
  /** Fires once per scenario when its outcome is final, so the page fills the table incrementally; the returned map stays authoritative. */
  readonly onScenarioResult?: (
    scenarioId: string,
    outcome: OptimizerMcOutcome,
  ) => void;
  /** Per-scenario progress in path units, sampled from the worker's progress messages. */
  readonly onScenarioProgress?: (
    scenarioId: string,
    progress: OptimizerMcScenarioProgress,
  ) => void;
  readonly signal?: AbortSignal;
  /** Test injection point. The pool calls it once per worker, so a shared instance needs `concurrency: 1`. */
  readonly workerFactory?: () => MinimalMcWorker;
  /** Worker-pool size override; defaults to `mcPoolSize`. */
  readonly concurrency?: number;
}

export async function runOptimizerMonteCarlo(
  args: RunOptimizerMonteCarloArgs,
): Promise<OptimizerMcResult> {
  const stepYears = args.candidateStepYears ?? OPTIMIZER_MC_CANDIDATE_STEP_YEARS;
  const pathCount = args.pathCount ?? OPTIMIZER_MC_DEFAULT_PATH_COUNT;
  const winnersByScenario = new Map<string, OptimizerMcWinner | null>();
  // Success probability at the user's current claim ages, for the "current → recommended" cell.
  const baselinesByScenario = new Map<string, number>();
  // Memoised per scenario so the per-triple match check stays cheap.
  const currentSsByScenario = new Map<string, SocialSecurityOverride | undefined>();
  const currentSsFor = (scenarioId: string): SocialSecurityOverride | undefined => {
    if (currentSsByScenario.has(scenarioId)) return currentSsByScenario.get(scenarioId);
    const ss = resolveScenario(scenarioId, [...args.scenarios]).socialSecurity;
    currentSsByScenario.set(scenarioId, ss);
    return ss;
  };
  const outcomesByScenario = new Map<string, OptimizerMcOutcome>();
  // Same `empty` outcome the deterministic worker emits when no primary retirement date resolves.
  const emptyReason = derivePrecheckEmpty({ members: args.members });
  if (emptyReason) {
    for (const sc of args.scenarios.filter((s) => !s.deletedAt)) {
      const outcome: OptimizerMcOutcome = { kind: 'empty', reason: emptyReason };
      outcomesByScenario.set(sc.id, outcome);
      args.onScenarioResult?.(sc.id, outcome);
    }
    return outcomesByScenario;
  }
  // Built first so pre-seeded outcomes survive a pre-aborted signal.
  const triples = buildTriples({
    scenarios: args.scenarios,
    members: args.members,
    ssBenefits: args.ssBenefits,
    today: args.today,
    stepYears,
  });
  // Shared by the live per-scenario emit and the final collapse, so they match.
  const ctx: ResolveCtx = {
    piaState: derivePiaState(args.members, args.ssBenefits),
    hasSecondary: args.members.some((m) => !m.payload.isPrimary),
  };
  for (const seed of triples.preSeededOutcomes) {
    outcomesByScenario.set(seed.scenarioId, seed.outcome);
    args.onScenarioResult?.(seed.scenarioId, seed.outcome);
  }
  // Scenarios whose full input signature hits the session cache skip all MC work; pre-seeded ones are never re-keyed.
  const cacheKeyByScenario = new Map<string, string>();
  const servedFromCache = new Set<string>();
  for (const sc of args.scenarios.filter((s) => !s.deletedAt)) {
    if (outcomesByScenario.has(sc.id)) continue; // pre-seeded terminal
    const key = optimizerCacheKey(args, sc.id, pathCount, stepYears);
    cacheKeyByScenario.set(sc.id, key);
    const hit = cacheGet(key);
    if (hit !== undefined) {
      outcomesByScenario.set(sc.id, hit);
      servedFromCache.add(sc.id);
      args.onScenarioResult?.(sc.id, hit);
    }
  }
  // Pre-aborted: skip worker construction (leak guard); `finalise` marks the rest `cancelled`.
  if (args.signal?.aborted) {
    return finalise(args, outcomesByScenario, winnersByScenario, baselinesByScenario, ctx);
  }
  const dispatchTriples = triples.list.filter(
    (t) => !servedFromCache.has(t.scenarioId),
  );
  // Triples left per scenario, decremented as each is accounted (so correct under out-of-order replies); at 0 the outcome is emitted.
  const remainingByScenario = new Map<string, number>();
  // Static grid size: the denominator of the per-row progress bar.
  const totalTriplesByScenario = new Map<string, number>();
  for (const t of dispatchTriples) {
    remainingByScenario.set(
      t.scenarioId,
      (remainingByScenario.get(t.scenarioId) ?? 0) + 1,
    );
    totalTriplesByScenario.set(
      t.scenarioId,
      (totalTriplesByScenario.get(t.scenarioId) ?? 0) + 1,
    );
  }
  // The invariant input is built once per scenario and only the candidate `ssByYear` overlay swaps per
  // triple. A thrown setup is cached as the error so later triples reuse the terminal outcome.
  const setupByScenario = new Map<string, OptimizerMcScenarioSetup | { error: unknown }>();
  const factory = args.workerFactory ?? (() => createDefaultMcWorker());
  const poolSize = mcPoolSize(dispatchTriples.length, args.concurrency);
  const pool = createMcPool({ factory, size: poolSize, signal: args.signal });
  const totals = {
    scenarios: triples.scenarioCount,
    pairs: triples.pairCount,
    totalPairs: triples.list.length,
  };
  // Advances at dispatch in grid order, so it never overshoots `totalPairs`.
  let cumulativeIdx = 0;
  // Several triples of one scenario can be in flight, so progress sums the completed base and every in-flight triple's latest paths.
  const progressByScenario = new Map<
    string,
    { completedTriples: number; inflight: Map<Triple, number> }
  >();
  const progressFor = (
    id: string,
  ): { completedTriples: number; inflight: Map<Triple, number> } => {
    let p = progressByScenario.get(id);
    if (!p) {
      p = { completedTriples: 0, inflight: new Map() };
      progressByScenario.set(id, p);
    }
    return p;
  };
  const accountDone = (scenarioId: string): void => {
    const remaining = (remainingByScenario.get(scenarioId) ?? 1) - 1;
    remainingByScenario.set(scenarioId, remaining);
    if (remaining === 0) {
      const outcome = resolveOutcome(
        args,
        scenarioId,
        outcomesByScenario,
        winnersByScenario,
        baselinesByScenario,
        { ...ctx, aborted: false },
      );
      args.onScenarioResult?.(scenarioId, outcome);
    }
  };
  // First terminal outcome wins; a terminal scenario has no numeric winner, so determinism is unaffected.
  const setTerminal = (scenarioId: string, outcome: OptimizerMcOutcome): void => {
    const existing = outcomesByScenario.get(scenarioId);
    if (existing && existing.kind !== 'result') return;
    outcomesByScenario.set(scenarioId, outcome);
  };
  const setupFor = (scenarioId: string): OptimizerMcScenarioSetup => {
    const cached = setupByScenario.get(scenarioId);
    if (cached) {
      if ('error' in cached) throw cached.error;
      return cached;
    }
    try {
      const setup = buildOptimizerMcScenarioSetup({
        scenarioId,
        scenarios: args.scenarios,
        accounts: args.accounts,
        balances: args.balances,
        members: args.members,
        ssBenefits: args.ssBenefits,
        expenses: args.expenses,
        incomeStreams: args.incomeStreams,
        medicalCategoryIds: args.medicalCategoryIds,
        // UTC, so the candidate grid ranks identically across timezones.
        todayYear: args.today.getUTCFullYear(),
        todayMonthIndex: args.today.getUTCMonth(),
      });
      setupByScenario.set(scenarioId, setup);
      return setup;
    } catch (e) {
      setupByScenario.set(scenarioId, { error: e });
      throw e;
    }
  };
  try {
    await runWithConcurrency(
      dispatchTriples,
      poolSize,
      args.signal,
      async (triple) => {
        if (args.signal?.aborted) {
          accountDone(triple.scenarioId);
          return;
        }
        // Skip triples of an already-terminated scenario, still accounted so the final emit fires.
        const existing = outcomesByScenario.get(triple.scenarioId);
        if (existing !== undefined && existing.kind !== 'result') {
          accountDone(triple.scenarioId);
          return;
        }
        cumulativeIdx += 1;
        args.onProgress?.({
          scenarioIdx: triple.scenarioIdx,
          pairIdx: triple.pairIdx,
          cumulativeIdx,
          totals,
        });
        let input: MonteCarloInput;
        try {
          // `successOnly` skips the worker's planned overlay: the optimizer reads only `successProbability`.
          input = setupFor(triple.scenarioId).mcInputForCandidate(triple.overlay, {
            successOnly: true,
          });
        } catch (e) {
          if (e instanceof CbpUnconfiguredError) {
            setTerminal(triple.scenarioId, {
              kind: 'unsupported',
              reason: 'cbp-unconfigured',
            });
          } else if (e instanceof NoPrimaryRetirementError) {
            setTerminal(triple.scenarioId, {
              kind: 'empty',
              reason: 'no-retirement-date',
            });
          } else {
            setTerminal(triple.scenarioId, {
              kind: 'error',
              message: (e as Error).message ?? String(e),
            });
          }
          accountDone(triple.scenarioId);
          return;
        }
        const pinnedInput: MonteCarloInput = {
          ...input,
          pathCount,
          seed: OPTIMIZER_MC_SEED,
        };
        const scenarioTotalPaths =
          (totalTriplesByScenario.get(triple.scenarioId) ?? 1) * pathCount;
        const reply = await pool.run(pinnedInput, (donePaths) => {
          const sp = progressFor(triple.scenarioId);
          sp.inflight.set(triple, donePaths);
          let inflightSum = 0;
          for (const v of sp.inflight.values()) inflightSum += v;
          args.onScenarioProgress?.(triple.scenarioId, {
            done: sp.completedTriples * pathCount + inflightSum,
            total: scenarioTotalPaths,
          });
        });
        // Only a triple that ran on a worker advances the progress base.
        if (reply.kind === 'result' || reply.kind === 'error') {
          const sp = progressFor(triple.scenarioId);
          sp.completedTriples += 1;
          sp.inflight.delete(triple);
        }
        if (args.signal?.aborted || reply.kind === 'aborted') {
          accountDone(triple.scenarioId);
          return;
        }
        if (reply.kind === 'error') {
          setTerminal(triple.scenarioId, {
            kind: 'error',
            message: reply.message,
          });
          accountDone(triple.scenarioId);
          return;
        }
        // Max success probability with a lower-age tie-break: both are order-independent.
        const candidate: OptimizerMcWinner = {
          primaryAgeYears: triple.primaryAgeYears,
          ...(triple.primaryAgeMonths !== undefined
            ? { primaryAgeMonths: triple.primaryAgeMonths }
            : {}),
          secondaryAgeYears: triple.secondaryAgeYears,
          ...(triple.secondaryAgeMonths !== undefined
            ? { secondaryAgeMonths: triple.secondaryAgeMonths }
            : {}),
          metricValue: reply.summary.successProbability,
        };
        // Baseline: success at the current claim ages, when this triple sits exactly on the resolved pair.
        if (
          matchesCurrentClaim(
            triple.primaryAgeYears,
            triple.secondaryAgeYears,
            currentSsFor(triple.scenarioId),
            triple.primaryAgeMonths,
            triple.secondaryAgeMonths,
          )
        ) {
          baselinesByScenario.set(triple.scenarioId, candidate.metricValue);
        }
        const prior = winnersByScenario.get(triple.scenarioId);
        if (
          !prior ||
          candidate.metricValue > prior.metricValue ||
          (candidate.metricValue === prior.metricValue &&
            breaksTieLowerAge(candidate, prior))
        ) {
          winnersByScenario.set(triple.scenarioId, candidate);
        }
        accountDone(triple.scenarioId);
      },
    );
    const result = finalise(
      args,
      outcomesByScenario,
      winnersByScenario,
      baselinesByScenario,
      ctx,
    );
    // Cache fresh outcomes, never a `cancelled` one; cache-served and pre-seeded scenarios have no key to store.
    if (!args.signal?.aborted) {
      for (const [scenarioId, key] of cacheKeyByScenario) {
        if (servedFromCache.has(scenarioId)) continue;
        const outcome = result.get(scenarioId);
        if (outcome && outcome.kind !== 'cancelled') cacheSet(key, outcome);
      }
    }
    return result;
  } finally {
    pool.dispose();
  }
}

/**
 * Runs `handler` over `items` with at most `limit` active. The drivers pull from
 * a shared cursor in list order, so each handler's synchronous prefix (the bar
 * emit) runs in grid order. Un-pulled items are left for `finalise` to cancel.
 */
async function runWithConcurrency(
  items: ReadonlyArray<Triple>,
  limit: number,
  signal: AbortSignal | undefined,
  handler: (item: Triple) => Promise<void>,
): Promise<void> {
  let next = 0;
  const drive = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await handler(items[i]);
    }
  };
  const driverCount = Math.min(Math.max(1, limit), items.length);
  const drivers: Promise<void>[] = [];
  for (let k = 0; k < driverCount; k += 1) drivers.push(drive());
  await Promise.all(drivers);
}

interface ResolveCtx {
  readonly piaState: PiaState;
  readonly hasSecondary: boolean;
}

// Collapses a scenario's winner into its outcome, or returns an existing terminal one. An
// aborted scenario with no winner is `cancelled`, not `winner: null`, which the page renders as past-window.
function resolveOutcome(
  args: RunOptimizerMonteCarloArgs,
  scenarioId: string,
  outcomes: Map<string, OptimizerMcOutcome>,
  winners: ReadonlyMap<string, OptimizerMcWinner | null>,
  baselines: ReadonlyMap<string, number>,
  ctx: ResolveCtx & { readonly aborted: boolean },
): OptimizerMcOutcome {
  const existing = outcomes.get(scenarioId);
  if (existing) return existing;
  const winner = winners.get(scenarioId) ?? null;
  if (ctx.aborted && !winner) {
    const cancelled: OptimizerMcOutcome = { kind: 'cancelled' };
    outcomes.set(scenarioId, cancelled);
    return cancelled;
  }
  const resolved = resolveScenario(scenarioId, [...args.scenarios]);
  const alreadyAtOptimum = winner
    ? isAlreadyAtOptimum(winner, resolved.socialSecurity)
    : false;
  const assumedDeathAge =
    resolved.lifeExpectancy?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE;
  const outcome: OptimizerMcOutcome = {
    kind: 'result',
    winner,
    partial: derivePartial({
      piaState: ctx.piaState,
      hasSecondary: ctx.hasSecondary,
      winner,
    }),
    missingPiaMembers: ctx.piaState.missingPiaMembers,
    alreadyAtOptimum,
    baselineMetricValue: baselines.get(scenarioId),
    assumedDeathAge,
  };
  outcomes.set(scenarioId, outcome);
  return outcome;
}

function finalise(
  args: RunOptimizerMonteCarloArgs,
  outcomes: Map<string, OptimizerMcOutcome>,
  winners: ReadonlyMap<string, OptimizerMcWinner | null>,
  baselines: ReadonlyMap<string, number>,
  ctx: ResolveCtx,
): OptimizerMcResult {
  const aborted = args.signal?.aborted === true;
  for (const sc of args.scenarios.filter((s) => !s.deletedAt)) {
    resolveOutcome(args, sc.id, outcomes, winners, baselines, { ...ctx, aborted });
  }
  return outcomes;
}

function createDefaultMcWorker(): MinimalMcWorker {
  const w = new MCWorker();
  return w as unknown as MinimalMcWorker;
}

function breaksTieLowerAge(
  candidate: OptimizerMcWinner,
  prior: OptimizerMcWinner,
): boolean {
  const cp = totalMonths(candidate.primaryAgeYears, candidate.primaryAgeMonths);
  const pp = totalMonths(prior.primaryAgeYears, prior.primaryAgeMonths);
  if (cp !== pp) return cp < pp;
  const cs =
    candidate.secondaryAgeYears === null
      ? Number.POSITIVE_INFINITY
      : totalMonths(candidate.secondaryAgeYears, candidate.secondaryAgeMonths);
  const ps =
    prior.secondaryAgeYears === null
      ? Number.POSITIVE_INFINITY
      : totalMonths(prior.secondaryAgeYears, prior.secondaryAgeMonths);
  return cs < ps;
}
