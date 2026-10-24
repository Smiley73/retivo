// Scenarios "Recalculate all": the bulk Monte Carlo recompute runs concurrently across a {@link createMcPool}, not one
// at a time; each input comes from the page's `buildMcInput` seam (same deterministic seed as the serial path).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';
import { putCached, mcCacheKey } from '../db/monte-carlo-cache';
import {
  createMcPool,
  mcPoolSize,
  type McPool,
  type MinimalMcWorker,
} from './mc-worker-pool';
import MCWorker from '../workers/monte-carlo.worker.ts?worker';

type BulkProgressById = ReadonlyMap<string, { done: number; total: number }>;

interface BulkRecomputeState {
  /** Completed (result, error or aborted) of queued scenarios; null while idle. */
  readonly coarse: { done: number; total: number } | null;
  readonly progressById: BulkProgressById;
  readonly isRunning: boolean;
}

export interface UseScenarioBulkRecomputeArgs {
  /** The page's `buildMcInput` seam (same seed as the serial path). */
  readonly buildMcInput: (scenarioId: string) => MonteCarloInput | null;
  /** Patch the card DIRECTLY from the in-hand summary (no cache re-read). */
  readonly onResult: (scenarioId: string, summary: MonteCarloSummary) => void;
  /** Injected for tests to bypass the real `?worker` import. */
  readonly workerFactory?: () => MinimalMcWorker;
  /** Pool-size override (tests pin it). Defaults to {@link mcPoolSize}. */
  readonly concurrency?: number;
}

export interface UseScenarioBulkRecomputeResult extends BulkRecomputeState {
  /**
   * Starts a bulk recompute for the given ids; a no-op (no pool spin-up) when the list is empty or a run is already
   * active.
   */
  readonly recalcAll: (scenarioIds: ReadonlyArray<string>) => void;
  /** Disposes the pool, settling pending and queued runs as aborted. */
  readonly cancel: () => void;
}

function defaultWorker(): MinimalMcWorker {
  return new MCWorker() as unknown as MinimalMcWorker;
}

// A result patches the card from the in-hand summary (never a cache re-read, which a concurrent LRU eviction past the
// cap of 20 could blank) and is write-cached; an error leaves the card as it was but still advances the counter; an
// abort stops. The pool lives per press and is disposed on cancel, completion and unmount; a run token ignores stale
// replies (also StrictMode-safe). The provider's single-worker contract is untouched.
export function useScenarioBulkRecompute(
  args: UseScenarioBulkRecomputeArgs,
): UseScenarioBulkRecomputeResult {
  const [coarse, setCoarse] = useState<{ done: number; total: number } | null>(null);
  const [progressById, setProgressById] = useState<
    ReadonlyMap<string, { done: number; total: number }>
  >(new Map());

  const poolRef = useRef<McPool | null>(null);
  // Only replies from the current batch mutate state: any dispose bumps the token, so a late reply from a torn-down
  // pool is ignored.
  const runTokenRef = useRef(0);

  // Latest callbacks in a ref so the run closure stays fresh and `recalcAll` keeps a stable identity.
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
      // Resolve inputs up front; scenarios whose input can't build are dropped.
      const work = scenarioIds
        .map((id) => ({ id, input: argsRef.current.buildMcInput(id) }))
        .filter((w): w is { id: string; input: MonteCarloInput } => w.input != null);
      if (work.length === 0) return;

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
              // No patch or write: the card keeps its prior value, but the batch advances and siblings finish.
              onTerminal(id);
            }
            // `aborted`: the pool was disposed and the token guard above already suppressed it.
          })
          .catch((e) => {
            // A throw in `onResult` must not hang the batch: advance the counter so it can still complete.
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
