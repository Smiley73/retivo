/**
 * Scenarios-scoped hook that runs the "Recalculate all" bulk Monte Carlo
 * recompute CONCURRENTLY across a {@link createMcPool} worker pool, instead
 * of the provider's one-worker-at-a-time `runToCompletion` loop. Each
 * scenario's `MonteCarloInput` (built by the page via the shared
 * `buildMcInput` seam — same deterministic seed the serial path used) runs
 * on the pool; every reply is handled as it lands:
 *
 *  - `{ kind: 'result' }` → the card is patched DIRECTLY from the in-hand
 *    summary (via `onResult`, which calls the page's `applyPlanSuccess`) AND
 *    the summary is write-cached via `putCached` (warm-cache for the next
 *    page visit / the BPP page). Patching from the returned summary — not a
 *    cache re-read — means a freshly-computed card can never be blanked by a
 *    concurrent IDB-cache eviction (the LRU cap is 20; >20 in-flight writes
 *    can evict a sibling's just-written entry before a re-read).
 *  - `{ kind: 'error' }` → no patch, no write (the card keeps its prior
 *    value), but the coarse done counter still advances and siblings finish.
 *  - `{ kind: 'aborted' }` → stop (Cancel / dispose). The card keeps its
 *    prior value.
 *
 * Progress: a coarse `done / total` counter (incremented on each terminal
 * reply) plus a per-card `scenarioId → { done, total }` fine progress map
 * fed by each `pool.run(..., onProgress)` and CLEARED per scenario on its
 * terminal reply (so a cancelled card doesn't keep a frozen partial bar).
 *
 * Pool lifecycle: the pool is created per "Recalculate all" press, held by a
 * ref, and disposed on (a) Cancel, (b) natural batch completion (don't hold
 * idle workers), and (c) hook unmount. A run-token guards against a stale
 * batch's replies landing after a newer start / dispose, which also makes
 * the create/dispose StrictMode double-mount safe.
 *
 * The provider's single-worker contract (Plan Stress Test, per-card recalc,
 * Report) is 100% untouched.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';
import { putCached, mcCacheKey } from '../db/monte-carlo-cache';
import {
  createMcPool,
  mcPoolSize,
  type McPool,
  type MinimalMcWorker,
} from './mc-worker-pool';
// Vite `?worker` import — same pattern as `MonteCarloProvider.tsx` /
// `optimizer-mc-runner.ts`.
import MCWorker from '../workers/monte-carlo.worker.ts?worker';

/** Per-card fine progress (path units), keyed by scenario id. An entry is
 *  present only while that scenario's run is in flight. */
type BulkProgressById = ReadonlyMap<string, { done: number; total: number }>;

interface BulkRecomputeState {
  /** Coarse "X of N scenarios" — completed (result/error/aborted) / queued.
   *  `null` while no bulk run is active. */
  readonly coarse: { done: number; total: number } | null;
  /** Per-card fine path-progress for in-flight scenarios. Empty when idle. */
  readonly progressById: BulkProgressById;
  /** True while a bulk run is in flight. */
  readonly isRunning: boolean;
}

export interface UseScenarioBulkRecomputeArgs {
  /** Build the deterministic `MonteCarloInput` for a scenario (the page's
   *  `buildMcInput` seam — same seed the serial path used). */
  readonly buildMcInput: (scenarioId: string) => MonteCarloInput | null;
  /** Patch the card DIRECTLY from the in-hand summary (no cache re-read). */
  readonly onResult: (scenarioId: string, summary: MonteCarloSummary) => void;
  /** Injected for tests to bypass the real `?worker` import. */
  readonly workerFactory?: () => MinimalMcWorker;
  /** Pool-size override (tests pin it). Defaults to {@link mcPoolSize}. */
  readonly concurrency?: number;
}

export interface UseScenarioBulkRecomputeResult extends BulkRecomputeState {
  /** Start a bulk recompute for the given scenario ids. No-op (and no pool
   *  spin-up) when the list is empty or a run is already active. */
  readonly recalcAll: (scenarioIds: ReadonlyArray<string>) => void;
  /** Cancel the active bulk run: dispose the pool, settling pending +
   *  queued runs as aborted. */
  readonly cancel: () => void;
}

function defaultWorker(): MinimalMcWorker {
  return new MCWorker() as unknown as MinimalMcWorker;
}

export function useScenarioBulkRecompute(
  args: UseScenarioBulkRecomputeArgs,
): UseScenarioBulkRecomputeResult {
  const [coarse, setCoarse] = useState<{ done: number; total: number } | null>(null);
  const [progressById, setProgressById] = useState<
    ReadonlyMap<string, { done: number; total: number }>
  >(new Map());

  const poolRef = useRef<McPool | null>(null);
  // Monotonic token: only replies from the current batch mutate state. A
  // dispose (cancel / completion / unmount / a fresh start) bumps it so a
  // late reply from a torn-down pool is ignored — also StrictMode-safe.
  const runTokenRef = useRef(0);

  // Keep the latest callbacks in a ref so the run closure never goes stale
  // and `recalcAll` keeps a stable identity.
  const argsRef = useRef(args);
  argsRef.current = args;

  const disposePool = useCallback((): void => {
    runTokenRef.current += 1;
    poolRef.current?.dispose();
    poolRef.current = null;
  }, []);

  const clearProgress = useCallback((scenarioId: string): void => {
    setProgressById((prev) => {
      if (!prev.has(scenarioId)) return prev;
      const next = new Map(prev);
      next.delete(scenarioId);
      return next;
    });
  }, []);

  const recalcAll = useCallback(
    (scenarioIds: ReadonlyArray<string>): void => {
      if (poolRef.current) return; // a run is already active
      // Resolve every runnable input up front; scenarios whose input can't
      // build are dropped (nothing to run).
      const work = scenarioIds
        .map((id) => ({ id, input: argsRef.current.buildMcInput(id) }))
        .filter((w): w is { id: string; input: MonteCarloInput } => w.input != null);
      if (work.length === 0) return;

      // Dispose any prior pool + bump the token before creating the new one.
      disposePool();
      const token = runTokenRef.current;
      const pool = createMcPool({
        factory: argsRef.current.workerFactory ?? defaultWorker,
        size: mcPoolSize(work.length, argsRef.current.concurrency),
      });
      poolRef.current = pool;

      const total = work.length;
      let done = 0;
      setCoarse({ done: 0, total });
      setProgressById(new Map());

      const onTerminal = (scenarioId: string): void => {
        if (runTokenRef.current !== token) return;
        clearProgress(scenarioId);
        done += 1;
        setCoarse({ done, total });
        if (done >= total) {
          // Natural completion — don't hold idle workers.
          disposePool();
          setCoarse(null);
        }
      };

      for (const { id, input } of work) {
        void pool
          .run(input, (pDone, pTotal) => {
            if (runTokenRef.current !== token) return;
            setProgressById((prev) => {
              const next = new Map(prev);
              next.set(id, { done: pDone, total: pTotal });
              return next;
            });
          })
          .then((reply) => {
            if (runTokenRef.current !== token) return;
            if (reply.kind === 'result') {
              argsRef.current.onResult(id, reply.summary);
              void mcCacheKey(input)
                .then((key) => putCached(key, reply.summary))
                .catch((e) => {
                  console.warn('[scenarios-bulk] cache write failed', e);
                });
              onTerminal(id);
            } else if (reply.kind === 'error') {
              // No patch / no write — the card keeps its prior value, but
              // the batch still advances and siblings finish.
              onTerminal(id);
            }
            // `aborted` → the pool was disposed; the token guard above
            // already suppressed it, so nothing to do.
          })
          .catch((e) => {
            // A throw in `onResult` (or anywhere in the .then) must not leave
            // the batch hung: advance the terminal counter so it can still
            // reach natural completion.
            if (runTokenRef.current !== token) return;
            console.warn('[scenarios-bulk] reply handler failed', e);
            onTerminal(id);
          });
      }
    },
    [disposePool, clearProgress],
  );

  const cancel = useCallback((): void => {
    disposePool();
    setCoarse(null);
    setProgressById(new Map());
  }, [disposePool]);

  // Dispose on unmount (no leaked workers); StrictMode-safe via the token.
  useEffect(() => {
    return () => {
      disposePool();
    };
  }, [disposePool]);

  return {
    coarse,
    progressById,
    isRunning: coarse !== null,
    recalcAll,
    cancel,
  };
}
