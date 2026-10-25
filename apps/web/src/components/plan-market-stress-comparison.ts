/**
 * Runs the four named market stresses against the base run and reports success-probability and shortfall deltas. See
 * docs/math-projections.md, "The four market stress tests".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  STRESS_CASE_IDS,
  applyStress,
  computeStressDelta,
  type StressCaseId,
  type StressDelta,
} from '../lib/market-stress';
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo-types';
import { createMcPool } from '../monte-carlo/mc-worker-pool';
import MCWorker from '../workers/monte-carlo.worker.ts?worker';
import { computeCacheKey, getCached, putCached } from '../db/monte-carlo-cache';

interface StressCaseVm {
  readonly caseId: StressCaseId;
  readonly state: 'pending' | 'ready' | 'error';
  /** Base-vs-stress deltas. `null` until the case resolves. */
  readonly delta: StressDelta | null;
  /** The stressed run's summary, so the comparison can plot its fan next to the base one. */
  readonly summary: MonteCarloSummary | null;
  /** Path-level progress; present only while this case is on the worker. */
  readonly progress: { readonly done: number; readonly total: number } | null;
}

export interface MarketStressComparisonVm {
  /** True once a base result and base input exist. */
  readonly canRun: boolean;
  /** `done` includes a fully cached comparison that never reached the worker. */
  readonly state: 'idle' | 'running' | 'done';
  /**
   * One entry per case in presentation order; empty until the walk starts, and rows resolve one at
   * a time.
   */
  readonly cases: ReadonlyArray<StressCaseVm>;
  readonly completed: number;
  readonly total: number;
  /**
   * Retries failed cases (worker crash or timeout); the walk itself starts automatically. No-op
   * while one is in flight.
   */
  readonly run: () => void;
}

export interface MarketStressComparisonArgs {
  /**
   * The base plan's input without `pathCount` / `seed`: the hook stamps the base run's own, so
   * every stress draws the same months as the displayed result.
   */
  readonly baseInput: MonteCarloInput | null;
  readonly baseResult: MonteCarloSummary | null;
  /**
   * Content signature of the base run paired with the plan on screen. `null` withholds the
   * comparison: a plan edited during the debounce or worker window would otherwise publish new plan
   * + stress − old plan.
   */
  readonly baseSignature: string | null;
  /**
   * Latest birth year in the household, anchoring the longevity stress's age-105 cap. `null`
   * withholds the comparison.
   */
  readonly longestLivedBirthYear: number | null;
  /**
   * True while the page's primary run is working. A Recalculate leaves the pair key unchanged, so
   * the walk needs this input to stand down; otherwise it would compete with the Recalculate and
   * its results would be discarded.
   */
  readonly baseRunInFlight: boolean;
}

// Bounded wait for one stress case: the surface has no Cancel, so a hung worker would leave it
// "Comparing…" forever.
const STRESS_CASE_TIMEOUT_MS = 300_000;

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function logStressCaseFailure(caseId: StressCaseId, reason: unknown): void {
  console.warn('[market-stress] stress case unavailable', {
    caseId,
    reason: reasonText(reason),
  });
}

function logStressPoolFailure(reason: unknown): void {
  console.warn('[market-stress] comparison unavailable — worker pool failed to start', {
    reason: reasonText(reason),
  });
}

// `disposed` is the liveness flag, not `pool`: the pool is built lazily, so `null` can mean "not
// built yet".
interface McWalk {
  disposed: boolean;
  pool: ReturnType<typeof createMcPool> | null;
}

// The content signature leads: seed and path count cannot tell two plans apart, because a
// Recalculate reuses a seed across edits.
function pairKeyFor(
  baseResult: MonteCarloSummary | null,
  baseSignature: string | null,
  longestLivedBirthYear: number | null,
): string | null {
  if (baseResult === null || baseSignature === null) return null;
  if (longestLivedBirthYear === null) return null;
  return `${baseSignature}::${baseResult.seed}::${baseResult.pathCount}::${longestLivedBirthYear}`;
}

// Cache-first; the key includes the seed, so a hit is paired with the displayed base sample.
// Disposal is checked after both pre-dispatch awaits. There is no check after `pool.run`: a
// disposed pool settles its dispatches as `aborted`, and the outer walk drops the reply. The pool
// is a factory because `createMcPool` spawns its worker eagerly; a fully cached plan must not spawn
// one, nor a browser that cannot spawn one turn cached answers into "Unavailable" rows. `null` was
// already logged.
async function runStressCase(
  caseId: StressCaseId,
  stressInput: MonteCarloInput,
  ensurePool: () => ReturnType<typeof createMcPool> | null,
  isDisposed: () => boolean,
  onProgress: (done: number, total: number) => void,
): Promise<MonteCarloSummary | null> {
  const key = await computeCacheKey({ ...stressInput, onProgress: undefined });
  if (isDisposed()) return null;
  const cached = await getCached(key);
  if (isDisposed()) return null;
  // A cache hit never reaches the worker, so it reports no progress.
  if (cached) return cached;
  const pool = ensurePool();
  if (pool === null) return null;
  const reply = await pool.run(stressInput, onProgress);
  if (reply.kind !== 'result') {
    // `aborted` is this hook's own disposal; logging it would write warnings for work the app
    // cancelled.
    if (reply.kind !== 'aborted') {
      logStressCaseFailure(caseId, `worker replied "${reply.kind}"`);
    }
    return null;
  }
  // Fire-and-forget write against the separate market-stress budget, so it cannot evict primary
  // scenario results.
  void putCached(key, reply.summary, 'marketStress').catch((e: unknown) => {
    logStressCaseFailure(caseId, e);
  });
  return reply.summary;
}

/**
 * Walks the four stress cases once a base run has settled for the plan on screen, publishing each
 * delta as it lands.
 */
export function useMarketStressComparison({
  baseInput,
  baseResult,
  baseSignature,
  longestLivedBirthYear,
  baseRunInFlight,
}: MarketStressComparisonArgs): MarketStressComparisonVm {
  const pairKey = pairKeyFor(baseResult, baseSignature, longestLivedBirthYear);
  const [runState, setRunState] = useState<{
    pairKey: string;
    // True only while a walk is in flight; a walk that timed out or failed to build its pool must
    // not leave a bar standing.
    walking: boolean;
    cases: ReadonlyArray<StressCaseVm>;
  } | null>(null);

  // Read inside the async walk without re-arming it: identity churn with an unchanged pair key must
  // not abort a run.
  const latest = useRef({
    baseInput,
    baseResult,
    baseSignature,
    longestLivedBirthYear,
  });
  latest.current = {
    baseInput,
    baseResult,
    baseSignature,
    longestLivedBirthYear,
  };

  // One pool and abort flag per walk, so the pool is disposed on completion, unmount and a base-run
  // change.
  const walkRef = useRef<McWalk | null>(null);
  const disposeActiveWalk = useCallback(() => {
    const walk = walkRef.current;
    if (walk === null) return;
    walk.disposed = true;
    walk.pool?.dispose();
    walk.pool = null;
    // Clearing the ref re-arms the entry guard below; otherwise the replacement walk would no-op.
    walkRef.current = null;
  }, []);

  useEffect(() => () => disposeActiveWalk(), [disposeActiveWalk]);

  const canRun =
    baseInput !== null &&
    baseResult !== null &&
    baseSignature !== null &&
    longestLivedBirthYear !== null;
  const running =
    runState !== null &&
    runState.walking &&
    runState.cases.some((c) => c.state === 'pending');

  const run = useCallback(() => {
    const {
      baseInput: input,
      baseResult: result,
      baseSignature: signature,
      longestLivedBirthYear: birthYear,
    } = latest.current;
    if (input === null || result === null || birthYear === null) return;
    const key = pairKeyFor(result, signature, birthYear);
    if (key === null) return;
    if (walkRef.current && !walkRef.current.disposed) return;

    setRunState({
      pairKey: key,
      walking: true,
      cases: STRESS_CASE_IDS.map((caseId) => ({
        caseId,
        state: 'pending' as const,
        delta: null,
        summary: null,
        progress: null,
      })),
    });

    // The base run's actual seed and path count, so every stress draws the months the base result
    // drew.
    const pairedBase: MonteCarloInput = {
      ...input,
      pathCount: result.pathCount,
      seed: result.seed,
    };
    const walk: McWalk = { disposed: false, pool: null };
    walkRef.current = walk;

    // Built on the first case to miss the cache. A pool failure is logged once and remembered;
    // later cases still read their own cache entry.
    let poolFailed = false;
    const ensurePool = (): ReturnType<typeof createMcPool> | null => {
      if (walk.disposed || poolFailed) return null;
      if (walk.pool === null) {
        try {
          walk.pool = createMcPool({ factory: () => new MCWorker(), size: 1 });
        } catch (e) {
          poolFailed = true;
          logStressPoolFailure(e);
          return null;
        }
      }
      return walk.pool;
    };

    // Publishes only into the run state this walk started, so a superseded walk cannot overwrite a
    // newer comparison.
    const publish = (
      caseId: StressCaseId,
      summary: MonteCarloSummary | null,
    ): void => {
      const delta =
        summary === null ? null : computeStressDelta(caseId, result, summary);
      setRunState((prev) =>
        prev === null || prev.pairKey !== key
          ? prev
          : {
              ...prev,
              cases: prev.cases.map((c) =>
                c.caseId === caseId
                  ? {
                      caseId,
                      state: delta ? 'ready' : 'error',
                      delta,
                      summary,
                      // A settled case must not keep a frozen bar beside its number.
                      progress: null,
                    }
                  : c,
              ),
            },
      );
    };

    // Same pair-key guard as `publish`, plus a state guard so a straggler tick cannot re-open a bar
    // on a finished row.
    const publishProgress = (
      caseId: StressCaseId,
      done: number,
      total: number,
    ): void => {
      setRunState((prev) =>
        prev === null || prev.pairKey !== key
          ? prev
          : {
              ...prev,
              cases: prev.cases.map((c) =>
                c.caseId === caseId && c.state === 'pending'
                  ? { ...c, progress: { done, total } }
                  : c,
              ),
            },
      );
    };

    void (async () => {
      try {
        for (const caseId of STRESS_CASE_IDS) {
          if (walk.disposed) return;
          let summary: MonteCarloSummary | null = null;
          let timedOut = false;
          let timer: number | undefined;
          try {
            const settled = await Promise.race([
              runStressCase(
                caseId,
                applyStress(pairedBase, caseId, { longestLivedBirthYear: birthYear }),
                ensurePool,
                () => walk.disposed,
                (done, total) => {
                  if (walk.disposed) return;
                  publishProgress(caseId, done, total);
                },
              ),
              new Promise<'timeout'>((resolve) => {
                timer = window.setTimeout(
                  () => resolve('timeout'),
                  STRESS_CASE_TIMEOUT_MS,
                );
              }),
            ]);
            if (settled === 'timeout') {
              timedOut = true;
              logStressCaseFailure(caseId, 'worker did not respond in time');
            } else {
              summary = settled;
            }
          } catch (e) {
            logStressCaseFailure(caseId, e);
          } finally {
            if (timer !== undefined) window.clearTimeout(timer);
          }
          if (walk.disposed) return;
          publish(caseId, summary);
          if (timedOut) {
            // The pool is presumed wedged: stop, and settle the cases that never ran.
            for (const remaining of STRESS_CASE_IDS.slice(
              STRESS_CASE_IDS.indexOf(caseId) + 1,
            )) {
              publish(remaining, null);
            }
            return;
          }
        }
      } finally {
        // A replacement walk can carry the same pair key (StrictMode double-invoke, Fast Refresh),
        // so a superseded walk must not publish `walking: false` over it.
        const isActive = walkRef.current === walk;
        walk.pool?.dispose();
        walk.pool = null;
        walk.disposed = true;
        if (isActive) {
          walkRef.current = null;
          setRunState((prev) =>
            prev === null || prev.pairKey !== key ? prev : { ...prev, walking: false },
          );
        }
      }
    })();
  }, []);

  // Dispose, then start, in one effect: split across two, effect order on a remount would decide
  // whether the fresh walk survives.
  useEffect(() => {
    disposeActiveWalk();
    setRunState((prev) => {
      if (prev === null || prev.pairKey !== pairKey) return null;
      // The walk was just stood down; leaving `walking` set would hold a progress bar over a walk
      // that no longer exists.
      return prev.walking ? { ...prev, walking: false } : prev;
    });
    // Four extra 10,000-path runs are real work, so wait for the primary run: `pairKey` covers an
    // edit, `baseRunInFlight` a Recalculate.
    if (pairKey !== null && canRun && !baseRunInFlight) run();
  }, [pairKey, canRun, baseRunInFlight, disposeActiveWalk, run]);

  const cases = runState?.pairKey === pairKey ? (runState?.cases ?? []) : [];
  const completed = cases.filter((c) => c.state !== 'pending').length;
  return {
    canRun,
    state: cases.length === 0 ? 'idle' : running ? 'running' : 'done',
    cases,
    completed,
    total: cases.length === 0 ? STRESS_CASE_IDS.length : cases.length,
    run,
  };
}
