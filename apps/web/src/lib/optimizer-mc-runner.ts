/**
 * Monte Carlo orchestrator for the claim-age optimizer. Walks every
 * `(scenario, primaryAge, secondaryAge)` candidate triple, assembles a
 * `MonteCarloInput` per triple via `runBalanceProjectionMc`, dispatches
 * each input across a pool of owned `monte-carlo.worker.ts` instances,
 * accumulates the max `summary.successProbability` per scenario, reports
 * progress scenario-by-scenario, and supports cancellation via an
 * `AbortSignal`.
 *
 * Each candidate triple is fully independent and posts a constant seed,
 * so its result is a pure function of its input — execution order
 * does not affect any winner. The orchestrator therefore fans triples
 * out across a {@link createMcPool} worker pool (the dominant slow case is
 * a single couple scenario with a 9×9 = 81-triple grid, so the
 * parallelism has to work *within* a scenario, not just across
 * scenarios) and handles replies as they land rather than in dispatch
 * order. The pool workers are the **sole** site that executes
 * `runMonteCarlo` — the orchestrator never calls it on the main thread.
 *
 * Every triple posts `seed = 1` (constant) so tie-break
 * determinism on flat metric surfaces is stable across runs. Reusing
 * the scenario's persisted MC seed would couple the optimizer to the
 * Plan-stress-test card.
 *
 * Per-scenario return contract. The orchestrator
 * returns one outcome per scenario in a `Map`. Each outcome is one of:
 *  - `result` — winner + partial + missingPiaMembers + alreadyAtOptimum
 *    (matches the deterministic `OptimizerResult` shape so the page's
 *    Apply gate + tooltip + missing-PIA callout work without per-metric
 *    branches). `winner === null` here means past-window (both grids
 *    empty) — same convention as the deterministic path.
 *  - `unsupported` — single `cbp-unconfigured` reason; the runner
 *    throws `CbpUnconfiguredError` on the first triple and the
 *    orchestrator surfaces it for that scenario alone.
 *  - `error` — non-`CbpUnconfigured` throw on assembly, OR a worker
 *    `{ kind: 'error' }` reply mid-run. Other scenarios keep running
 *    so a single bad scenario does not abort the whole sweep.
 *
 * Helpers (PIA derivation, triple-building per empty-grid branch,
 * already-at-optimum check) live in `optimizer-mc-runner-helpers.ts`
 * so this file stays under the ≤400-ln shape cap.
 */
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
// Vite `?worker` import — same pattern as `MonteCarloProvider.tsx`.
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

// Re-exported so existing callers/tests keep importing the worker shape
// from the orchestrator; the canonical definition now lives with the pool.
export type { MinimalMcWorker } from '../monte-carlo/mc-worker-pool';

/** Whole-year grid step. Increase to 2 → `{62, 64, 66, 68, 70}` (25-pair
 *  coarse grid) without restructuring the orchestrator. */
const OPTIMIZER_MC_CANDIDATE_STEP_YEARS = 1;
/** Default MC path count per triple. The page exposes a 1k/5k/10k
 *  selector backed by the {@link RunOptimizerMonteCarloArgs.pathCount}
 *  override; this is the fallback. Tests + headless callers that
 *  don't pass `pathCount` get this value. */
export const OPTIMIZER_MC_DEFAULT_PATH_COUNT = 1000;

/* ---------- in-memory session outcome cache ---------- */

/** Max in-memory cache entries. The optimizer grid is ~81 candidates per
 *  scenario, so a session never approaches this cap in normal use; the
 *  bound (CODING_STANDARDS stateful-singleton rule) prevents unbounded
 *  growth under adversarial input variation. LRU eviction on overflow. */
export const OPTIMIZER_MC_CACHE_MAX_ENTRIES = 500;

/** Module-level session cache: per-scenario final optimizer outcome keyed
 *  on a stable hash of every optimizer-relevant input. Warm within a page
 *  session; cold on reload (no persistence). A `Map` preserves
 *  insertion order, so the first key is the LRU victim; a hit re-inserts to
 *  mark most-recently-used. */
const optimizerOutcomeCache = new Map<string, OptimizerMcOutcome>();

/** Test-only: clear the session cache so a fresh run recomputes. */
export function clearOptimizerMcCache(): void {
  optimizerOutcomeCache.clear();
}

/** Test-only: current cache entry count (for the max-bound AC). */
export function optimizerMcCacheSize(): number {
  return optimizerOutcomeCache.size;
}

function cacheGet(key: string): OptimizerMcOutcome | undefined {
  const hit = optimizerOutcomeCache.get(key);
  if (hit === undefined) return undefined;
  // LRU touch: move to most-recently-used position.
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

/** FNV-1a 32-bit hash of a string — fast, synchronous, dependency-free.
 *  Collision probability is negligible for a per-session cache keyed on a
 *  full input serialisation. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Compact, change-sensitive snapshot of one aggregate array — id +
 *  version + payload — sorted by id for order-independence. Any payload
 *  edit bumps `version`, but the payload is serialised too so a test that
 *  mutates a payload without bumping the version still produces a miss. */
function aggregateSignature(
  list: ReadonlyArray<{ id: string; version: number; payload: unknown }>,
): unknown {
  return list
    .map((a) => ({ id: a.id, version: a.version, payload: a.payload }))
    .sort((x, y) => x.id.localeCompare(y.id));
}

/** Per-scenario session cache key. Includes every optimizer-relevant
 *  input so any change — scenario graph, accounts, balances, members, SS
 *  benefits, expenses, income streams, path count, today anchor, candidate
 *  step, pinned seed, or `ENGINE_VERSION` — produces a fresh key (miss). */
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
    // A flag-set change must produce a fresh key (sorted for
    // order-independence) so a stale cached setup never returns wrong rankings.
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
  /** Global 1-based triple index; bar uses this so 1-D fallbacks
   *  don't overshoot the joint-product expectation. */
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
  /** Flag-derived medical category ids — threaded into each scenario's
   *  MC setup so the +2pp medical-inflation default follows the flag, AND
   *  into the FNV setup-cache signature so a flag-set change can't collide on
   *  a stale cached setup. */
  readonly medicalCategoryIds?: ReadonlyArray<string>;
  readonly today: Date;
  readonly candidateStepYears?: number;
  readonly pathCount?: number;
  readonly onProgress?: (p: OptimizerMcProgress) => void;
  /** Fires once per scenario the moment its outcome is final — pre-
   *  seeded empty/past-window scenarios up-front, terminated
   *  (unsupported/error) scenarios when they terminate, and normal
   *  scenarios when their last candidate triple resolves. Lets the page
   *  fill the table scenario-by-scenario instead of waiting for the
   *  whole sweep (mirrors the deterministic path's `onMethodResult`).
   *  The end-of-run return map stays the authoritative reconcile. */
  readonly onScenarioResult?: (
    scenarioId: string,
    outcome: OptimizerMcOutcome,
  ) => void;
  /** Smooth per-scenario progress in path units, emitted as the
   *  in-flight scenario's grid simulates (sampled from the MC worker's
   *  own `{ kind: 'progress' }` messages). Lets the page drive a
   *  per-row bar that climbs to 100 % before `onScenarioResult` fires. */
  readonly onScenarioProgress?: (
    scenarioId: string,
    progress: OptimizerMcScenarioProgress,
  ) => void;
  readonly signal?: AbortSignal;
  /** Injected for tests to bypass the real `?worker` import. The pool
   *  calls this once per worker, so a factory that returns a shared
   *  instance only models a single-worker pool — pass `concurrency: 1`
   *  with it, or return a fresh worker per call to exercise the pool. */
  readonly workerFactory?: () => MinimalMcWorker;
  /** Worker-pool size override. Defaults to {@link mcPoolSize}
   *  (the logical cores minus one, capped to the triple count). Tests pin it
   *  for deterministic dispatch; a value of `1` reproduces the legacy
   *  single-worker serial path exactly. */
  readonly concurrency?: number;
}

export async function runOptimizerMonteCarlo(
  args: RunOptimizerMonteCarloArgs,
): Promise<OptimizerMcResult> {
  const stepYears = args.candidateStepYears ?? OPTIMIZER_MC_CANDIDATE_STEP_YEARS;
  const pathCount = args.pathCount ?? OPTIMIZER_MC_DEFAULT_PATH_COUNT;
  const winnersByScenario = new Map<string, OptimizerMcWinner | null>();
  // Per-scenario MC success probability at the user's current claim ages
  // — captured when a candidate triple lands exactly on the resolved
  // whole-year pair. Drives the "current → recommended" metric cell.
  const baselinesByScenario = new Map<string, number>();
  // Memoised resolved SS override per scenario — the baseline the
  // recommendation is compared against. Resolved once per scenario so the
  // per-triple match check stays cheap.
  const currentSsByScenario = new Map<string, SocialSecurityOverride | undefined>();
  const currentSsFor = (scenarioId: string): SocialSecurityOverride | undefined => {
    if (currentSsByScenario.has(scenarioId)) return currentSsByScenario.get(scenarioId);
    const ss = resolveScenario(scenarioId, [...args.scenarios]).socialSecurity;
    currentSsByScenario.set(scenarioId, ss);
    return ss;
  };
  const outcomesByScenario = new Map<string, OptimizerMcOutcome>();
  // Emit the same `empty` variants the deterministic worker
  // emits when household state can't resolve a primary retirement
  // date. The page maps `empty` → `EmptyReasonRow` copy ("Set a
  // primary retirement age on the Scenarios page") instead of the
  // generic ErrorRow with raw error text. Scoped per-scenario because
  // each scenario can have its own retirementAge override.
  const emptyReason = derivePrecheckEmpty({ members: args.members });
  if (emptyReason) {
    for (const sc of args.scenarios.filter((s) => !s.deletedAt)) {
      const outcome: OptimizerMcOutcome = { kind: 'empty', reason: emptyReason };
      outcomesByScenario.set(sc.id, outcome);
      args.onScenarioResult?.(sc.id, outcome);
    }
    return outcomesByScenario;
  }
  // Build triples first so pre-seeded outcomes (no-PIA / past-window /
  // no-retirement-date) are preserved even on a pre-aborted signal.
  // Triple-build is pure compute, no worker.
  const triples = buildTriples({
    scenarios: args.scenarios,
    members: args.members,
    ssBenefits: args.ssBenefits,
    today: args.today,
    stepYears,
  });
  // Derived once and shared by the live per-scenario emit + the final
  // collapse so an incrementally-emitted row matches the end-of-run
  // reconcile exactly.
  const ctx: ResolveCtx = {
    piaState: derivePiaState(args.members, args.ssBenefits),
    hasSecondary: args.members.some((m) => !m.payload.isPrimary),
  };
  for (const seed of triples.preSeededOutcomes) {
    outcomesByScenario.set(seed.scenarioId, seed.outcome);
    args.onScenarioResult?.(seed.scenarioId, seed.outcome);
  }
  // Session cache: serve any scenario whose full input signature
  // hits the in-memory cache, skipping all MC work for it. Pre-seeded
  // scenarios already have a terminal outcome, so they are never re-keyed.
  // Cache keys are reused at finalise to store freshly-computed outcomes.
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
  // Pre-aborted signal: skip worker construction (leak guard).
  // `finalise` collapses unprocessed scenarios to `cancelled`.
  if (args.signal?.aborted) {
    return finalise(args, outcomesByScenario, winnersByScenario, baselinesByScenario, ctx);
  }
  // Triples for cache-served scenarios are dropped — their outcome is
  // already emitted from the session cache, so no MC work runs for them.
  const dispatchTriples = triples.list.filter(
    (t) => !servedFromCache.has(t.scenarioId),
  );
  // Per-scenario triple tally — decremented as each triple is accounted
  // (dispatched, skipped, errored, or aborted). When a scenario's count
  // hits 0 its grid is exhausted, so we collapse + emit its final
  // outcome. Driven by completion, not dispatch order, so it is correct
  // under out-of-order replies from the pool.
  const remainingByScenario = new Map<string, number>();
  // Static per-scenario grid size — denominator for the smooth per-row
  // progress bar (total = triples × pathCount). Mirrors the tally above
  // but never decremented.
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
  // Per-scenario MC setup: the invariant `MonteCarloInput` is built
  // once per scenario and the candidate `ssByYear` overlay is swapped per
  // triple. Lazily memoised; a thrown setup (no-primary / CBP-unconfigured)
  // is cached as the error so the remaining triples reuse the terminal
  // outcome without re-running the failing pipeline.
  const setupByScenario = new Map<string, OptimizerMcScenarioSetup | { error: unknown }>();
  const factory = args.workerFactory ?? (() => createDefaultMcWorker());
  const poolSize = mcPoolSize(dispatchTriples.length, args.concurrency);
  const pool = createMcPool({ factory, size: poolSize, signal: args.signal });
  const totals = {
    scenarios: triples.scenarioCount,
    pairs: triples.pairCount,
    totalPairs: triples.list.length,
  };
  // Cumulative bar counter — incremented as triples are *dispatched*.
  // Drivers pull triples in list order, so even with a multi-worker pool
  // the bar advances in grid order and never overshoots `totalPairs`.
  let cumulativeIdx = 0;
  // Per-scenario smooth-progress accumulator (path units). Multiple
  // triples of one scenario can be in flight at once, so the numerator
  // sums the completed-triple base with every in-flight triple's latest
  // path progress. Collapses to the legacy `completed × pathCount +
  // donePaths` formula when only one triple of the scenario runs at a
  // time (e.g. `concurrency: 1`).
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
  // Account one triple as consumed: decrement its scenario's tally and,
  // when the grid is exhausted, collapse + emit the final outcome.
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
  // First terminal outcome wins (stable under concurrent assembly throws
  // / worker errors). A scenario with a terminal outcome has no numeric
  // winner, so which triple set it never affects determinism.
  const setTerminal = (scenarioId: string, outcome: OptimizerMcOutcome): void => {
    const existing = outcomesByScenario.get(scenarioId);
    if (existing && existing.kind !== 'result') return;
    outcomesByScenario.set(scenarioId, outcome);
  };
  // Build (or reuse) the per-scenario invariant MC setup. Throws are
  // converted to terminal outcomes by the caller.
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
        // numbers-in. Optimizer keeps UTC so the candidate grid
        // ranks identically across machines/timezones.
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
        // Skip remaining triples for a scenario already terminated
        // (unsupported / error / empty) — still accounted so the
        // final-triple emit fires. Saves the main-thread assembly cost
        // for not-yet-pulled triples.
        const existing = outcomesByScenario.get(triple.scenarioId);
        if (existing !== undefined && existing.kind !== 'result') {
          accountDone(triple.scenarioId);
          return;
        }
        // Cumulative bar advances at dispatch, in grid order.
        cumulativeIdx += 1;
        args.onProgress?.({
          scenarioIdx: triple.scenarioIdx,
          pairIdx: triple.pairIdx,
          cumulativeIdx,
          totals,
        });
        let input: MonteCarloInput;
        try {
          // Build the invariant per-scenario setup once, then swap only
          // the candidate `ssByYear` overlay. `successOnly` skips the
          // worker's `runPlannedOverlay` call — the optimizer reads
          // only `successProbability`, never the planned overlay.
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
            // Scenario-level retirement-age unresolvable → match
            // the deterministic worker's `empty` variant.
            setTerminal(triple.scenarioId, {
              kind: 'empty',
              reason: 'no-retirement-date',
            });
          } else {
            // non-CBP throw on assembly surfaces as a per-scenario
            // error; remaining scenarios continue.
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
        // A triple that actually ran on a worker advances the smooth-bar
        // base; an aborted one leaves it untouched.
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
          // Worker error for one triple — surface as per-scenario
          // error and skip the rest of that scenario's triples.
          setTerminal(triple.scenarioId, {
            kind: 'error',
            message: reply.message,
          });
          accountDone(triple.scenarioId);
          return;
        }
        // result → accumulate the per-scenario winner (max success
        // probability, lower-age tie-break). Both are order-independent,
        // so the winner is identical regardless of reply ordering.
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
        // Capture the baseline (success at the user's current claim ages)
        // when this triple sits exactly on the resolved pair, months included.
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
    // Store freshly-computed outcomes in the session cache so a repeat run
    // with identical inputs hits the cache and skips MC entirely. A
    // `cancelled` outcome (aborted before its grid resolved) is never
    // cached. Scenarios served from the cache or pre-seeded (no cache key)
    // are skipped.
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
 * Run `handler` over `items` with at most `limit` invocations active at
 * once. `limit` drivers pull from a shared cursor in list order, so the
 * synchronous prefix of each `handler` (the cumulative-bar emit) runs in
 * grid order even though the awaited tails complete out of order. Stops
 * pulling once `signal` aborts — un-pulled items are left for `finalise`
 * to collapse to `cancelled`.
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

/** Derived state shared by the live per-scenario emit + the final
 *  collapse. Kept on one object so both paths stay in lock-step. */
interface ResolveCtx {
  readonly piaState: PiaState;
  readonly hasSecondary: boolean;
}

/**
 * Collapse one scenario's running winner-accumulator into its final
 * outcome — or return the already-set terminal outcome (unsupported /
 * error / empty / pre-seeded past-window) untouched.
 * `alreadyAtOptimum` is computed here so the row contract matches the
 * deterministic worker output. An aborted scenario with no
 * accumulated winner is `cancelled`, never a `result` with
 * `winner: null` (which the page renders as past-window). Sets the
 * outcome into `outcomes` and returns it so callers can emit it.
 */
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
  // Disclosure only: the fixed primary death age assumed this run.
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
  // Total months, so 66 beats 66 years 4 months on an exact tie.
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
