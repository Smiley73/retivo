// Owns the Monte Carlo run lifecycle (progress, result, error via `useMonteCarlo()`): one fresh Web Worker per run below
// `SHARD_MIN_PATHS` (or on a single-worker pool), else a sharded pool (`runMonteCarloSharded`); results are cached via `putCached`.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';
import { getCached, mcCacheKey, putCached } from '../db/monte-carlo-cache';
import MCWorker from '../workers/monte-carlo.worker?worker';
import type { WorkerOutbound } from '../workers/monte-carlo.worker';
import { runMonteCarloSharded, SHARD_MIN_PATHS } from './run-monte-carlo-sharded';
import { mcPoolSize, type MinimalMcWorker } from './mc-worker-pool';

function shouldShard(input: MonteCarloInput): boolean {
  return input.pathCount >= SHARD_MIN_PATHS && mcPoolSize(input.pathCount) > 1;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export type RunStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

export interface MonteCarloContextValue {
  status: RunStatus;
  progressDone: number;
  progressTotal: number;
  result: MonteCarloSummary | null;
  error: string | null;
  /**
   * Kicks a run; resultless: it resolves with `void` and the outcome reaches callers only through
   * `result`/`status`/`error`. The cache is consulted first (a hit spawns no worker). Its settlement point is not
   * uniform (the single-worker branch resolves once dispatched, the sharded branch after its terminal reply), so use
   * `runToCompletion` when finishing matters. `{ force: true }` bypasses the cache and overwrites the entry; callers
   * wanting a new sample must vary `seed` themselves, since the key excludes it. No production caller (every consumer
   * uses `runToCompletion`); it stays as the resultless shape under the same newest-request-wins guard, for tests.
   */
  run(input: MonteCarloInput, opts?: { force?: boolean }): Promise<void>;
  /**
   * Runs one MC sweep and resolves only when it completes, for the Scenarios list's sequential recompute and the
   * per-card "Recalculate". Cache-first like `run`; `{ force: true }` bypasses it and overwrites the canonical entry.
   * The result is also threaded into `result`/`status`/progress for `McProgressBar`. Resolves with the summary, or
   * `null` if cancelled or superseded by a later request (only the newest publishes; see `runGenerationRef`). Rejects
   * on a worker error, or on a worker that could not be created or dispatched to, unless already superseded, in which
   * case it resolves `null`.
   */
  runToCompletion(
    input: MonteCarloInput,
    opts?: { force?: boolean },
  ): Promise<MonteCarloSummary | null>;
  /**
   * Terminates the worker and resets transient state; also retires the current generation so a request still in its
   * preflight cannot spawn the worker the user just stopped. The cached result stays in IDB.
   */
  cancel(): void;
  /** Replaces the current `result` (renders a cached entry on page mount). */
  setResult(summary: MonteCarloSummary | null): void;
}

const Ctx = createContext<MonteCarloContextValue | null>(null);

export function useMonteCarlo(): MonteCarloContextValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error('useMonteCarlo must be used inside <MonteCarloProvider>');
  }
  return v;
}

export function MonteCarloProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<RunStatus>('idle');
  const [progressDone, setProgressDone] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [result, setResult] = useState<MonteCarloSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  // AbortController of an in-flight sharded run (exclusive with `workerRef`); cancel, supersede and unmount abort it,
  // which the pool turns into `aborted` plus dispose.
  const poolAbortRef = useRef<AbortController | null>(null);
  // Resolver of an in-flight `runToCompletion` so `cancel()` can settle it with `null` (no result arrives once the
  // worker is terminated or the pool aborted).
  const pendingCancelRef = useRef<(() => void) | null>(null);
  // Monotonic generation of run requests, shared by `run` and `runToCompletion` and taken synchronously at invocation.
  // Both do preflight (hash the cache key, read IndexedDB) before pre-empting the previous run, and two preflights can
  // finish out of call order. Without a generation the older one would tear down the newer run's worker, spawn its own
  // and publish into the shared `result`/`status`, leaving the UI holding a result nobody wants with no run in flight
  // to replace it (a permanent wedge), or publish a late cache hit over a newer computing run. So only the newest
  // generation may touch shared state; a superseded request never pre-empts or mutates
  // `result`/`status`/`error`/progress and resolves `null` like a cancelled run. Its cache write still happens: the
  // summary is valid for its own key and makes a later identical run a hit. `cancel()` and unmount retire the
  // generation too (see `retireGeneration`).
  const runGenerationRef = useRef(0);

  // Tears down whatever is in flight (terminate the worker or abort the pool, null both refs, settle any awaiting
  // `runToCompletion` with `null` so a sequential driver unblocks); callers set status separately. Idempotent and
  // null-safe.
  const resetInFlight = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    poolAbortRef.current?.abort();
    poolAbortRef.current = null;
    pendingCancelRef.current?.();
    pendingCancelRef.current = null;
  }, []);

  // Retires the current generation so every request in flight, including ones parked in a preflight await, reads as
  // superseded. `resetInFlight` reaches only work that exists (a worker, a pool, an awaiter); a request still hashing
  // or reading IndexedDB would wake holding the newest generation, pre-empt, spawn and publish, silently undoing a
  // Cancel or leaking a run past unmount.
  const retireGeneration = useCallback(() => {
    runGenerationRef.current += 1;
  }, []);

  useEffect(() => {
    return () => {
      // Retire first: teardown cannot reach a request that has created nothing yet, so the bump is the only thing
      // stopping it.
      retireGeneration();
      resetInFlight();
    };
  }, [retireGeneration, resetInFlight]);

  // A preflight rejected on the request that owns the shared state. It never reached its pre-empt sweep, so an older
  // run may still be computing with its result suppressed as superseded: a worker computing into nothing and `status`
  // frozen. Tear it down (settling its awaiter with `null`), clear progress and publish the failure. Callers must check
  // `superseded()` first; a superseded failure reached nobody.
  const failPreflight = useCallback(
    (e: unknown): void => {
      resetInFlight();
      setError((e as Error)?.message ?? 'Monte Carlo failed');
      setStatus('error');
      setProgressDone(0);
      setProgressTotal(0);
    },
    [resetInFlight],
  );

  // A dispatch stage failed for the owning request: the Worker constructor threw (CSP, out of memory, a chunk that
  // won't load) or `postMessage` threw (input failing structured clone). `status` is already 'running' with nothing
  // computing, the wedge `failPreflight` prevents, so publish the failure and clear progress. Callers must check
  // `superseded()` first.
  const failDispatch = useCallback((err: Error): void => {
    setError(err.message);
    setStatus('error');
    setProgressDone(0);
    setProgressTotal(0);
  }, []);

  const cancel = useCallback(() => {
    // Retire the generation before tearing down: a request in its preflight owns no worker to terminate and would
    // otherwise spawn one after Cancel. otherwise spawn one after the user asked to stop.
    retireGeneration();
    // `resetInFlight` also settles any awaiting `runToCompletion`, unblocking a sequential driver.
    resetInFlight();
    setStatus('cancelled');
    setProgressDone(0);
    setProgressTotal(0);
  }, [retireGeneration, resetInFlight]);

  const run = useCallback(async (input: MonteCarloInput, opts?: { force?: boolean }) => {
    // Claim the generation before the first await, so a request that loses the preflight race can tell it was
    // superseded.
    const generation = runGenerationRef.current + 1;
    runGenerationRef.current = generation;
    const superseded = (): boolean => runGenerationRef.current !== generation;

    // Cache-first, with the shared `mcCacheKey` so the key can't drift from the metrics read key. Either preflight
    // stage can reject (no `crypto.subtle`, an IndexedDB failure); `run` is resultless, so it publishes through
    // `error`/`status` and resolves (see `failPreflight`).
    let key: string;
    try {
      key = await mcCacheKey(input);
    } catch (e) {
      if (!superseded()) failPreflight(e);
      return;
    }
    if (superseded()) return;
    // A forced run (manual "Recalculate") skips the cache hit so a new sample is computed; the result still overwrites
    // the canonical entry via `putCached(key, …)`.
    if (!opts?.force) {
      let cached: MonteCarloSummary | null;
      try {
        cached = await getCached(key);
      } catch (e) {
        if (!superseded()) failPreflight(e);
        return;
      }
      if (superseded()) return;
      if (cached) {
        setResult(cached);
        setStatus('done');
        setProgressDone(input.pathCount);
        setProgressTotal(input.pathCount);
        return;
      }
    }

    // Kill any previous worker or sharded pool first, settling a pending `runToCompletion` awaiter with `null` (a
    // terminated worker never posts a result); mirrors `cancel()` and unmount.
    resetInFlight();
    setStatus('running');
    setError(null);
    setProgressDone(0);
    setProgressTotal(input.pathCount);

    // Large runs on a multi-worker machine shard across the pool.
    if (shouldShard(input)) {
      const controller = new AbortController();
      poolAbortRef.current = controller;
      let reply;
      try {
        reply = await runMonteCarloSharded(input, {
          factory: () => new MCWorker() as unknown as MinimalMcWorker,
          signal: controller.signal,
          onProgress: (done, total) => {
            if (superseded()) return;
            setProgressDone(done);
            setProgressTotal(total);
          },
        });
      } catch (e) {
        if (poolAbortRef.current === controller) poolAbortRef.current = null;
        if (superseded()) return;
        setError((e as Error).message ?? 'Monte Carlo failed');
        setStatus('error');
        return;
      }
      if (poolAbortRef.current === controller) poolAbortRef.current = null;
      if (reply.kind === 'result') {
        if (!superseded()) {
          setResult(reply.summary);
          setStatus('done');
        }
        void putCached(key, reply.summary).catch((e) => {
          console.warn('[monte-carlo] cache write failed', e);
        });
      } else if (reply.kind === 'error') {
        if (superseded()) return;
        setError(reply.message);
        setStatus('error');
      }
      // 'aborted' → `cancel()` already moved status to 'cancelled'.
      return;
    }

    // Construction, handler installation and dispatch sit under one guard: any can throw, and `status` is already
    // 'running', so an escaping throw would strand every consumer on a run that does not exist. `run` is resultless, so
    // it publishes through `error`/`status` and resolves. (Nothing awaits before `postMessage`, so `superseded()` can't
    // be true today; the check keeps publish-only-if-current if an await is added.)
    let worker: Worker;
    try {
      worker = new MCWorker();
    } catch (e) {
      if (!superseded()) failDispatch(toError(e));
      return;
    }
    workerRef.current = worker;

    const onWorkerMessage = (ev: MessageEvent<WorkerOutbound>) => {
      const msg = ev.data;
      if (msg.kind === 'progress') {
        if (superseded()) return;
        setProgressDone(msg.done);
        setProgressTotal(msg.total);
      } else if (msg.kind === 'result') {
        if (!superseded()) {
          setResult(msg.summary);
          setStatus('done');
        }
        // Fire-and-forget cache write — failures are non-fatal.
        void putCached(key, msg.summary).catch((e) => {
          console.warn('[monte-carlo] cache write failed', e);
        });
        worker.terminate();
        // Clear the ref only while it still points at this worker; a newer request may have swapped in its own.
        if (workerRef.current === worker) workerRef.current = null;
      } else if (msg.kind === 'error') {
        if (!superseded()) {
          setError(msg.message);
          setStatus('error');
        }
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
      }
    };
    const onWorkerError = (e: ErrorEvent) => {
      if (!superseded()) {
        setError(e.message ?? 'Worker crashed');
        setStatus('error');
      }
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };

    try {
      worker.onmessage = onWorkerMessage;
      worker.onerror = onWorkerError;
      worker.postMessage({ kind: 'run', input });
    } catch (e) {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
      if (!superseded()) failDispatch(toError(e));
    }
  }, [resetInFlight, failPreflight, failDispatch]);

  const runToCompletion = useCallback(
    async (
      input: MonteCarloInput,
      opts?: { force?: boolean },
    ): Promise<MonteCarloSummary | null> => {
      // Claim the generation before the first await (see `runGenerationRef`); a superseded request resolves `null`,
      // which every caller reads as "produced nothing".
      const generation = runGenerationRef.current + 1;
      runGenerationRef.current = generation;
      const superseded = (): boolean => runGenerationRef.current !== generation;

      // Either preflight stage can reject: a superseded failure resolves `null`; a current one resets the older run and
      // publishes `error` before rejecting, like this entry point's worker-error path.
      let key: string;
      try {
        key = await mcCacheKey(input);
      } catch (e) {
        if (superseded()) return null;
        failPreflight(e);
        throw e instanceof Error ? e : new Error(String(e));
      }
      if (superseded()) return null;
      if (!opts?.force) {
        let cached: MonteCarloSummary | null;
        try {
          cached = await getCached(key);
        } catch (e) {
          if (superseded()) return null;
          failPreflight(e);
          throw e instanceof Error ? e : new Error(String(e));
        }
        if (superseded()) return null;
        if (cached) {
          setResult(cached);
          setStatus('done');
          setProgressDone(input.pathCount);
          setProgressTotal(input.pathCount);
          return cached;
        }
      }

      // Kill any previous worker or sharded pool first, settling a pending `runToCompletion` awaiter with `null` before
      // `pendingCancelRef.current` is overwritten below; mirrors `cancel()` and unmount.
      resetInFlight();
      setStatus('running');
      setError(null);
      setProgressDone(0);
      setProgressTotal(input.pathCount);

      if (shouldShard(input)) {
        const controller = new AbortController();
        poolAbortRef.current = controller;
        return new Promise<MonteCarloSummary | null>((resolve, reject) => {
          let settled = false;
          const clearCancel = (): void => {
            if (pendingCancelRef.current === onCancel) pendingCancelRef.current = null;
          };
          // `cancel()` aborts the pool, so runMonteCarloSharded resolves 'aborted'; this settles the awaiter with
          // `null` first.
          const onCancel = (): void => {
            if (settled) return;
            settled = true;
            clearCancel();
            resolve(null);
          };
          pendingCancelRef.current = onCancel;
          void runMonteCarloSharded(input, {
            factory: () => new MCWorker() as unknown as MinimalMcWorker,
            signal: controller.signal,
            onProgress: (done, total) => {
              if (superseded()) return;
              setProgressDone(done);
              setProgressTotal(total);
            },
          })
            .then((reply) => {
              if (poolAbortRef.current === controller) poolAbortRef.current = null;
              if (settled) return;
              if (reply.kind === 'result') {
                const stale = superseded();
                if (!stale) {
                  setResult(reply.summary);
                  setStatus('done');
                }
                settled = true;
                clearCancel();
                void putCached(key, reply.summary)
                  .catch((e) => {
                    console.warn('[monte-carlo] cache write failed', e);
                  })
                  .finally(() => resolve(stale ? null : reply.summary));
              } else if (reply.kind === 'aborted') {
                settled = true;
                clearCancel();
                resolve(null);
              } else {
                settled = true;
                clearCancel();
                if (superseded()) {
                  resolve(null);
                  return;
                }
                setError(reply.message);
                setStatus('error');
                reject(new Error(reply.message));
              }
            })
            .catch((e) => {
              if (poolAbortRef.current === controller) poolAbortRef.current = null;
              if (settled) return;
              settled = true;
              clearCancel();
              if (superseded()) {
                resolve(null);
                return;
              }
              setError((e as Error).message ?? 'Monte Carlo failed');
              setStatus('error');
              reject(e instanceof Error ? e : new Error(String(e)));
            });
        });
      }

      // Guarded like `run`: a Worker the browser refuses to spawn would reject with `status` frozen at 'running' and no
      // `error` to retry from. This entry point reports the failure, so it publishes then rejects, unless superseded
      // (then it resolves `null`).
      let worker: Worker;
      try {
        worker = new MCWorker();
      } catch (e) {
        if (superseded()) return null;
        const err = toError(e);
        failDispatch(err);
        throw err;
      }
      workerRef.current = worker;

      return new Promise<MonteCarloSummary | null>((resolve, reject) => {
        let settled = false;
        const finish = (value: MonteCarloSummary | null): void => {
          if (settled) return;
          settled = true;
          if (pendingCancelRef.current === onCancel) pendingCancelRef.current = null;
          resolve(value);
        };
        const fail = (err: Error): void => {
          if (settled) return;
          settled = true;
          if (pendingCancelRef.current === onCancel) pendingCancelRef.current = null;
          reject(err);
        };
        // `cancel()` terminates the worker → no message arrives; resolve null.
        const onCancel = (): void => finish(null);
        pendingCancelRef.current = onCancel;

        const onWorkerMessage = (ev: MessageEvent<WorkerOutbound>) => {
          const msg = ev.data;
          if (msg.kind === 'progress') {
            if (superseded()) return;
            setProgressDone(msg.done);
            setProgressTotal(msg.total);
          } else if (msg.kind === 'result') {
            const stale = superseded();
            if (!stale) {
              setResult(msg.summary);
              setStatus('done');
            }
            worker.terminate();
            // Clear the ref only while it still points at this worker; a cancel() may have swapped it out.
            if (workerRef.current === worker) workerRef.current = null;
            // Await the cache write so a subsequent sequential read sees it.
            void putCached(key, msg.summary)
              .catch((e) => {
                console.warn('[monte-carlo] cache write failed', e);
              })
              .finally(() => finish(stale ? null : msg.summary));
          } else if (msg.kind === 'error') {
            const stale = superseded();
            if (!stale) {
              setError(msg.message);
              setStatus('error');
            }
            worker.terminate();
            if (workerRef.current === worker) workerRef.current = null;
            if (stale) finish(null);
            else fail(new Error(msg.message));
          }
        };
        const onWorkerError = (e: ErrorEvent) => {
          const stale = superseded();
          if (!stale) {
            setError(e.message ?? 'Worker crashed');
            setStatus('error');
          }
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
          if (stale) finish(null);
          else fail(new Error(e.message ?? 'Worker crashed'));
        };

        // Same guard as construction: a throwing `postMessage` in this executor rejects the promise without terminating
        // the worker, clearing `workerRef`/`pendingCancelRef` or moving `status` off 'running', so settle it
        // explicitly.
        try {
          worker.onmessage = onWorkerMessage;
          worker.onerror = onWorkerError;
          worker.postMessage({ kind: 'run', input });
        } catch (e) {
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
          if (superseded()) {
            finish(null);
            return;
          }
          const err = toError(e);
          failDispatch(err);
          fail(err);
        }
      });
    },
    [resetInFlight, failPreflight, failDispatch],
  );

  return (
    <Ctx.Provider
      value={{
        status,
        progressDone,
        progressTotal,
        result,
        error,
        run,
        runToCompletion,
        cancel,
        setResult,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
