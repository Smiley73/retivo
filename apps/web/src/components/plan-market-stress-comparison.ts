/**
 * Market-stress comparison hook.
 *
 * Runs the market-stress core (`lib/market-stress.ts`) on the Balance
 * Projection page: for each named sensitivity — higher fees, lower returns,
 * higher inflation, and a longer life — it re-runs the plan with that shock
 * applied and reports the success-probability and shortfall deltas against the
 * base run.
 *
 * SAME RANDOM PATHS. Every stress run reuses the BASE run's actual seed and
 * path count, and the fee / return / inflation shocks are deterministic
 * mean-shifts that never touch the RNG, so a stress differs from its base only
 * by the assumption that changed — never by luck of the draw. The longevity
 * shock only EXTENDS the horizon, so the overlapping years draw identical
 * months.
 *
 * AUTOMATIC, ONCE THE BASE RUN SETTLES. The comparison starts on its own as
 * soon as a base result exists for the plan on screen, and re-starts whenever
 * that base run changes. It used to be opt-in behind a button, but the button
 * could not do the one thing its label promised: every case is cache-first on a
 * SEED-INCLUSIVE key, and a stress run is a pure function of its input, so
 * pressing it on an unchanged plan only ever re-served the numbers already
 * displayed. A different sample comes from the page's own Recalculate, which
 * re-seeds the base run and invalidates the pair. Runs go through ONE size-1
 * worker pool, sequentially, and the pool is disposed on completion, on
 * unmount, and whenever the base run changes underneath it.
 *
 * PROGRESS. Because those runs are long, the VM reports progress at BOTH
 * granularities the rest of the app uses (`use-scenario-bulk-recompute.ts`, the
 * SS optimizer): a coarse `completed / total` in case units, plus per-case
 * path-level `progress` forwarded from `pool.run`'s `onProgress` for the one
 * case currently on the worker. The consumer renders the shared
 * `McProgressBar` from each.
 *
 * PAIRED TO A SETTLED BASE RUN. The comparison is only offered once the page's
 * PRIMARY run has settled for the plan currently on screen, and its pair
 * identity carries that run's CONTENT SIGNATURE as well as its seed / path
 * count. Without the signature two different plans that happen to share a seed
 * would look like the same base run, so an edit made during the debounce or
 * worker window could publish `new plan + stress − old plan`.
 *
 * See docs/math-projections.md, "The four market stress tests".
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

/** Per-case comparison state. */
interface StressCaseVm {
  readonly caseId: StressCaseId;
  /** `pending` while queued or in flight; `ready` once its delta is known. */
  readonly state: 'pending' | 'ready' | 'error';
  /** Base-vs-stress deltas. `null` until the case resolves. */
  readonly delta: StressDelta | null;
  /** The stressed run's full summary, so the comparison can PLOT the stressed
   *  percentile fan next to the base one. `null` until the case resolves. */
  readonly summary: MonteCarloSummary | null;
  /** Path-level progress for the case CURRENTLY on the worker, mirroring the
   *  Scenarios bulk-recompute fine-progress map: present only while this case
   *  is simulating, `null` while it is queued, served from cache, or settled.
   *  Drives the per-row determinate `McProgressBar`. */
  readonly progress: { readonly done: number; readonly total: number } | null;
}

/** The whole comparison surface's view model. */
export interface MarketStressComparisonVm {
  /** True once a base result + a base input exist, i.e. a comparison can run. */
  readonly canRun: boolean;
  /** `running` while a walk is in flight; `idle` in the render before the
   *  automatic walk is armed; `done` once every case has settled — which
   *  includes a fully cached comparison that reached the worker not at all. */
  readonly state: 'idle' | 'running' | 'done';
  /** One entry per named case, in presentation order. Empty only until the
   *  automatic walk starts; cases resolve one at a time, so a caller must
   *  expect resolved and unresolved rows together. */
  readonly cases: ReadonlyArray<StressCaseVm>;
  /** Cases resolved so far / total, for the progress readout. */
  readonly completed: number;
  readonly total: number;
  /** Re-run the comparison. The walk starts automatically, so this exists only
   *  for RETRYING cases that failed — a worker crash or a per-case timeout.
   *  No-op while a walk is already in flight. */
  readonly run: () => void;
}

export interface MarketStressComparisonArgs {
  /** The base plan's Monte Carlo input, WITHOUT the page's `pathCount`/`seed`
   *  overrides — this hook stamps the base run's own values so the comparison
   *  is seed-paired with the numbers on screen. `null` while invalid. */
  readonly baseInput: MonteCarloInput | null;
  /** The base run's settled summary. `null` until the primary run completes. */
  readonly baseResult: MonteCarloSummary | null;
  /** Content signature of the base run PAIRED WITH the plan currently on
   *  screen. `null` whenever the primary run has not settled for the current
   *  input — while it is in flight, while a debounced edit is pending, or when
   *  the displayed result belongs to a superseded plan. A `null` here withholds
   *  the comparison entirely: pairing a fresh input with a stale result would
   *  publish `new plan + stress − old plan`. */
  readonly baseSignature: string | null;
  /** Birth year of the household's youngest member (the latest birth year)
   *  — anchors the longevity stress's age-105 cap. `null` when no member has a usable
   *  birthdate, which withholds the comparison rather than guessing an age. */
  readonly longestLivedBirthYear: number | null;
  /** True while the page's PRIMARY run is working — a debounced edit, a manual
   *  Recalculate, or an error retry.
   *
   *  This has to be an input of its own, because a Recalculate does NOT change
   *  the pair key: `kickRun('recalc')` deliberately leaves the previously
   *  settled run in place (it is still the summary on screen), so the signature,
   *  seed and path count the pair is built from are all unchanged until the new
   *  sample lands. Without this flag the arming effect never fires, and the
   *  now-obsolete walk keeps a worker saturated for the whole Recalculate —
   *  competing with the very run the user asked for, which shards across every
   *  other core — only for its results to be discarded when the new seed
   *  re-keys the pair. The walk is therefore stood down while the primary run
   *  is in flight and started again from whatever pair comes out of it. */
  readonly baseRunInFlight: boolean;
}

/**
 * Bounded wait for ONE stress case. A worker that never posts back (a hung
 * kernel, a devtools-suspended worker, a browser that silently killed it)
 * would otherwise leave this surface "Comparing…" forever — it has no Cancel
 * button of its own, unlike the primary run. On expiry the pool is disposed
 * and every unresolved case settles as unavailable. Deliberately generous: a
 * 10,000-path run is seconds-to-a-minute of work, so this can only ever fire
 * on a genuinely stuck worker.
 */
export const STRESS_CASE_TIMEOUT_MS = 300_000;

/** Readable text for anything thrown, without losing an `Error`'s message. */
function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Record why one case could not be compared before it is mapped to the
 *  user-safe "Unavailable" cell. Without this the failure is invisible: the
 *  cell is identical for a worker crash, a cache read error, and a timeout. */
function logStressCaseFailure(caseId: StressCaseId, reason: unknown): void {
  console.warn('[market-stress] stress case unavailable', {
    caseId,
    reason: reasonText(reason),
  });
}

/** Record a failure that stops the comparison before ANY case can run — the
 *  worker pool itself could not be built. No case id exists yet to attribute
 *  it to, so it is logged once for the whole comparison. */
function logStressPoolFailure(reason: unknown): void {
  console.warn('[market-stress] comparison unavailable — worker pool failed to start', {
    reason: reasonText(reason),
  });
}

/** The one in-flight sequential walk: its abort flag plus the size-1 pool it
 *  owns. `disposed` is the liveness flag, NOT `pool` — the pool is built LAZILY
 *  on the first case that misses the cache and nulled again on disposal, so
 *  `null` means "not built yet" as often as it means "gone". */
interface McWalk {
  disposed: boolean;
  pool: ReturnType<typeof createMcPool> | null;
}

/** Identity of the base run a comparison is paired to. A change here
 *  invalidates any comparison already on screen. The CONTENT SIGNATURE leads:
 *  seed + path count alone cannot tell two different plans apart (the auto-run
 *  seed is derived from the signature, but a manual Recalculate reuses a seed
 *  across edits), so an in-flight comparison must be invalidated by the plan
 *  edit itself, not only by a seed change. */
function pairKeyFor(
  baseResult: MonteCarloSummary | null,
  baseSignature: string | null,
  longestLivedBirthYear: number | null,
): string | null {
  if (baseResult === null || baseSignature === null) return null;
  if (longestLivedBirthYear === null) return null;
  return `${baseSignature}::${baseResult.seed}::${baseResult.pathCount}::${longestLivedBirthYear}`;
}

/** Run one stress case, cache-first. The cache key is SEED-INCLUSIVE, so a hit
 *  is guaranteed to be paired with the same base sample the page displays.
 *
 *  Disposal is checked after BOTH pre-dispatch awaits — the key hash and the
 *  IndexedDB read — because the pair key can change during either, and there is
 *  no reason to start a 10,000-path run for a comparison that is already
 *  obsolete. There is deliberately NO check after `pool.run`: the pool itself
 *  settles a dispatch made to (or in flight on) a disposed pool as
 *  `{ kind: 'aborted' }` (`mc-worker-pool.ts` — `dispatch` resolves immediately
 *  when `disposed`, and `dispose()` settles every queued and busy slot), so this
 *  await always resolves rather than pinning the stressed input's
 *  `Float64Array` ledger until the timeout. The obsolete reply is then dropped
 *  by the outer walk: it returns on `walk.disposed` before publishing, and
 *  `publish` additionally ignores any outcome whose pair key is no longer the
 *  one on screen.
 *
 *  The pool arrives as a FACTORY, not a pool, and is asked for only after the
 *  cache misses. `createMcPool` constructs its worker eagerly, so building it
 *  up front spawned and immediately tore down a whole Monte Carlo worker on
 *  every visit to an already-compared plan — and turned a browser that will not
 *  spawn one (strict CSP, an enterprise policy, memory pressure) into four
 *  "Unavailable" rows sitting on top of four perfectly good cached answers.
 *  A `null` from the factory means the pool could not be built and has ALREADY
 *  been logged for the comparison as a whole. */
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
  // A cache hit never reaches the worker, so it reports no progress at all —
  // the row simply settles. Only a real run drives a bar.
  if (cached) return cached;
  const pool = ensurePool();
  if (pool === null) return null;
  const reply = await pool.run(stressInput, onProgress);
  if (reply.kind !== 'result') {
    // `aborted` is this hook's own disposal coming back to it — the pair key
    // changed, or the page unmounted, while the case was on the worker. That is
    // routine on any edit or navigation, and logging it wrote warnings into the
    // user's persisted diagnostics log for work the app itself cancelled.
    if (reply.kind !== 'aborted') {
      logStressCaseFailure(caseId, `worker replied "${reply.kind}"`);
    }
    return null;
  }
  // Fire-and-forget cache write (non-fatal on failure), like the primary run —
  // the comparison is already correct without it, so a failed write is logged
  // rather than surfaced. Charged to the SEPARATE market-stress budget so the
  // comparison's entries can never evict the primary scenario results the
  // Scenarios page's cached metrics read.
  void putCached(key, reply.summary, 'marketStress').catch((e: unknown) => {
    logStressCaseFailure(caseId, e);
  });
  return reply.summary;
}

/**
 * Build the market-stress comparison view model. The walk over the four named
 * cases is armed by an effect as soon as a base run has settled for the plan on
 * screen, and each delta is published as it lands.
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
    /** True only while a WALK is in flight — false again once it settles,
     *  including for the walk that resolved every case from the cache without
     *  reaching the worker. Distinct from "some case is unresolved": a walk
     *  that timed out or failed to build its pool settles every case without
     *  running, and must not leave a progress bar standing. */
    walking: boolean;
    cases: ReadonlyArray<StressCaseVm>;
  } | null>(null);

  // Read the latest inputs inside the async walk without re-arming it: an
  // identity churn that leaves the pair key unchanged must not abort a run.
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

  // One live pool + one abort flag for the in-flight walk, so unmount (or a
  // base-run change) stops the worker instead of stranding it.
  const walkRef = useRef<McWalk | null>(null);
  const disposeActiveWalk = useCallback(() => {
    const walk = walkRef.current;
    if (walk === null) return;
    walk.disposed = true;
    walk.pool?.dispose();
    walk.pool = null;
    // Clearing the ref is what re-arms the entry guard below: without it a
    // superseded walk would keep the guard closed, and the replacement walk the
    // new pair key arms would silently no-op — costing that base run its
    // comparison for the rest of the page's life.
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

    // The base run's ACTUAL seed + path count, so every stress draws the same
    // months the displayed base result drew.
    const pairedBase: MonteCarloInput = {
      ...input,
      pathCount: result.pathCount,
      seed: result.seed,
    };
    const walk: McWalk = { disposed: false, pool: null };
    walkRef.current = walk;

    /** The size-1 pool, built on the FIRST case to miss the cache and never
     *  before — see `runStressCase`. `createMcPool` constructs its worker
     *  eagerly, so a browser that refuses to spawn one throws HERE rather than
     *  at the top of the walk. That failure ends the comparison's ability to
     *  compute anything, so it is recorded once and remembered: every later
     *  case settles as unavailable without retrying the constructor, while
     *  still reading its own cache entry first — a cached case is a real answer
     *  and must survive a broken worker. */
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

    /** Publish one case's outcome — but ONLY into the run state this walk
     *  started. A late completion from a superseded walk cannot overwrite the
     *  comparison a newer pair key is building. */
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
                      // Drop the bar with the row it belonged to: a settled case
                      // holding its last partial reading would leave a frozen
                      // bar beside a finished number.
                      progress: null,
                    }
                  : c,
              ),
            },
      );
    };

    /** Publish one case's path-level progress. Same pair-key guard as
     *  `publish`, plus a state guard so a straggler tick that arrives after the
     *  case settled cannot re-open a bar on a finished row. */
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
              // `null` here was already logged with its reply kind inside
              // `runStressCase`.
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
            // The pool is presumed wedged: stop the walk, settle the cases that
            // never got their turn, and let the button re-arm for a retry.
            for (const remaining of STRESS_CASE_IDS.slice(
              STRESS_CASE_IDS.indexOf(caseId) + 1,
            )) {
              publish(remaining, null);
            }
            return;
          }
        }
      } finally {
        // Whether THIS walk is still the one on screen. A superseded walk must
        // touch neither the guard nor the display state — and the pair key
        // cannot tell them apart, because a replacement walk can carry the SAME
        // key: React re-invokes the arming effect on a remount (StrictMode's
        // double-invoke, a Fast Refresh edit), which disposes walk A and starts
        // walk B under one unchanged key. Keyed on the pair alone, A's exit
        // published `walking: false` over B — dropping the progress bar and
        // reporting the comparison finished while B was still running it.
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

  // Drop a stale comparison the moment the base run it was paired to changes —
  // deltas against a superseded sample would be silently wrong — stop the walk
  // that was producing them (clearing display state alone left the obsolete
  // worker running all four cases against the old plan), and start the walk for
  // the new pair.
  //
  // Invalidation and the automatic start MUST share one effect. Split across
  // two, the arming order between them is what decides whether the fresh walk
  // survives or is disposed by an invalidation that runs after it — and React
  // re-invokes effects on a remount (StrictMode's double-invoke, a Fast Refresh
  // edit), so "it happened to be armed first" is not a property to rely on.
  // Here the sequence is fixed by the function body: dispose, then start.
  useEffect(() => {
    disposeActiveWalk();
    setRunState((prev) => {
      if (prev === null || prev.pairKey !== pairKey) return null;
      // Same pair, but the walk that was filling it has just been stood down
      // (the primary run started again underneath it). Leaving `walking` set
      // would hold a progress bar over a walk that no longer exists, with no
      // later effect obliged to clear it.
      return prev.walking ? { ...prev, walking: false } : prev;
    });
    // Four extra 10,000-path runs are real work, so this waits for the page's
    // PRIMARY run to settle for the plan on screen — `pairKey` covers an edit,
    // `baseRunInFlight` covers a Recalculate, which re-runs the same plan and
    // so leaves the pair key untouched. A cached comparison reaches no worker
    // at all: every case is cache-first and the pool is built lazily.
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
