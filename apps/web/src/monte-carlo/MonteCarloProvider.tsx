/**
 * Owns the Monte Carlo run lifecycle. A run below `SHARD_MIN_PATHS` (or on a
 * single-worker pool) computes in ONE fresh Web Worker spawned per run and
 * terminated on completion (one-at-a-time via `workerRef`). A larger run on a
 * multi-worker machine shards across the pool via `runMonteCarloSharded`,
 * whose lifecycle is tracked by `poolAbortRef`. On result, the summary
 * is written to the IndexedDB LRU cache via `putCached`. Provides progress +
 * result + error state to any descendant via the `useMonteCarlo()` hook.
 *
 * Cancel = terminate the single worker OR abort the pool (whichever is active),
 * discard in-flight state, AND invalidate the current generation so a request
 * still inside its preflight cannot spawn a worker afterwards; the next run
 * starts fresh. Unmount does the same.
 *
 * Newest request wins. Both entry points (`run` and `runToCompletion`; only
 * `runToCompletion` has a production caller) do preflight work (cache key, cache
 * read) before they pre-empt the previous run, so two rapid requests can finish
 * that preflight out of call order. Each therefore claims a generation
 * synchronously at invocation, and only the newest generation may pre-empt a
 * run or write the shared result/status/error/progress; a superseded request
 * bows out and reports `null`. A preflight that REJECTS obeys the same rule:
 * silent when superseded, and when current it tears the older run down before
 * publishing the failure (`failPreflight`), so a failed preflight can never
 * leave a suppressed run computing behind a frozen `running` status. A worker
 * that cannot be CREATED or dispatched to follows the same rule
 * (`failDispatch`), so neither end of the run's lifecycle can strand `running`.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';
import { getCached, mcCacheKey, putCached } from '../db/monte-carlo-cache';
// Worker imported via Vite's `?worker` ESM transform — produces a
// separate JS chunk lazy-loaded on first run.
import MCWorker from '../workers/monte-carlo.worker?worker';
import type { WorkerOutbound } from '../workers/monte-carlo.worker';
import { runMonteCarloSharded, SHARD_MIN_PATHS } from './run-monte-carlo-sharded';
import { mcPoolSize, type MinimalMcWorker } from './mc-worker-pool';

/** A run shards across the pool only when it is large enough AND the machine
 *  offers more than one pool worker; otherwise the single-worker path runs. */
function shouldShard(input: MonteCarloInput): boolean {
  return input.pathCount >= SHARD_MIN_PATHS && mcPoolSize(input.pathCount) > 1;
}

/** Normalize an unknown throw into an `Error` without losing its message. */
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
  /** Kick a run. RESULTLESS: it resolves with `void`, and the outcome reaches
   *  callers only through `result` / `status` / `error`, never through the
   *  returned promise. Cache is consulted first; on a hit the worker is not
   *  spawned.
   *
   *  Its settlement POINT is not uniform and must not be relied on: the
   *  single-worker branch resolves once the worker has been dispatched, while
   *  the sharded branch awaits `runMonteCarloSharded` through its terminal
   *  reply. Awaiting `run` therefore tells you nothing consistent about
   *  whether a run finished — use `runToCompletion` when that matters.
   *
   *  Pass `{ force: true }` to bypass the cache short-circuit and always
   *  spawn the worker even on a cache hit — the fresh result overwrites
   *  the cached entry. Callers that want a genuinely new sample on a
   *  forced run must vary the input `seed` themselves (the cache key
   *  excludes the seed, so the overwrite lands on the same key).
   *
   *  NOTE: this entry point has NO production caller — every consumer awaits
   *  `runToCompletion` instead; only tests call `run`. It is kept as the
   *  provider's resultless shape (and stays under the same newest-request-wins
   *  generation guard), not because a live path uses it. */
  run(input: MonteCarloInput, opts?: { force?: boolean }): Promise<void>;
  /** Run a SINGLE MC sweep and resolve only when it COMPLETES (the worker
   *  posts its result), unlike `run`, which resolves with nothing at a point
   *  that depends on which branch it took. Used by the Scenarios list to
   *  recompute scenarios sequentially (await one before kicking the next) and
   *  by the per-card "Recalculate" affordance.
   *
   *  Cache-first like `run`; `{ force: true }` bypasses the short-circuit
   *  and overwrites the canonical entry (seed excluded from the key). The
   *  result is also threaded into `result` / `status` / progress so a
   *  caller can render the shared `McProgressBar`. Resolves with the
   *  summary, or `null` if the run was cancelled mid-flight OR superseded
   *  by a later request (only the newest request publishes; see
   *  `runGenerationRef`). Rejects on a worker error — or on a worker that
   *  could not be created or dispatched to at all — unless the request was
   *  already superseded, then it resolves `null` like any other outcome
   *  that reached nobody. */
  runToCompletion(
    input: MonteCarloInput,
    opts?: { force?: boolean },
  ): Promise<MonteCarloSummary | null>;
  /** Terminate the worker and reset transient state. Also retires the current
   *  request generation, so a request still inside its preflight cannot wake
   *  up afterwards and spawn the worker the user just asked to stop. The
   *  previously-cached result stays in IDB (only in-memory state is cleared). */
  cancel(): void;
  /** Replace the current `result` (used to render a cached entry on
   *  page mount). */
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
  // The AbortController for an in-flight SHARDED run (mutually exclusive
  // with `workerRef` — a run uses exactly one path). `cancel()`/supersede/
  // unmount abort it, which the pool turns into `{kind:'aborted'}` + dispose.
  const poolAbortRef = useRef<AbortController | null>(null);
  // Resolver for an in-flight `runToCompletion` promise so `cancel()` can
  // settle it with `null` (the worker is terminated / pool aborted → no
  // result arrives).
  const pendingCancelRef = useRef<(() => void) | null>(null);
  // Monotonic generation of run REQUESTS, shared by `run` and
  // `runToCompletion` and taken SYNCHRONOUSLY at invocation — before either
  // entry point awaits anything.
  //
  // Both do preflight work (hash the cache key, then read IndexedDB) BEFORE
  // they pre-empt the previous run, and nothing stops a caller kicking a second
  // request while the first is still in that preflight. Two preflights can
  // finish out of call order, and without a generation the OLDER one then wins:
  // it tears down the NEWER run's worker, spawns its own, and publishes its
  // summary into the shared `result` / `status` that every consumer reads. A
  // caller carrying its own request identity rejects that completion, so the UI
  // is left holding a result nobody currently wants with no run in flight to
  // replace it — a permanent wedge, not a transient flicker. Same for a late
  // preflight that ends in a cache HIT: it would publish a cached summary over
  // a newer run that is already computing.
  //
  // The rule this enforces: ONLY the newest generation may touch shared state.
  // A superseded request bows out — it never pre-empts, never mutates
  // `result` / `status` / `error` / progress, and resolves `null` so its caller
  // treats it exactly like a cancelled run. Its cache write still happens: the
  // summary is valid for its own key, and the entry is what makes a later
  // identical run a hit.
  //
  // `cancel()` and unmount RETIRE the generation for the same reason — see
  // `retireGeneration`. A newer request is not the only thing that can make an
  // in-flight request obsolete.
  const runGenerationRef = useRef(0);

  // Tear down whatever is in flight: terminate the single worker OR abort the
  // sharded pool (mutually exclusive), null both refs, and settle any awaiting
  // `runToCompletion` with `null` so a sequential driver unblocks. Callers set
  // their own status/state separately. Every op is idempotent / null-safe.
  const resetInFlight = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    poolAbortRef.current?.abort();
    poolAbortRef.current = null;
    pendingCancelRef.current?.();
    pendingCancelRef.current = null;
  }, []);

  // Retire the current generation, which makes EVERY request in flight —
  // including ones still parked in a preflight await — read as superseded.
  //
  // `resetInFlight` alone only reaches work that already EXISTS: a worker, a
  // pool, an awaiter. A request still hashing its cache key or reading
  // IndexedDB owns none of those, so tearing down is a no-op for it and it
  // wakes up still holding the newest generation — then pre-empts, spawns a
  // worker, and publishes. After a Cancel that silently undoes the Cancel;
  // after unmount it leaks a run (and a React state write) past teardown.
  // Bumping the generation is what makes those requests bow out: they take the
  // same path a newer request would have given them — publish nothing, spawn
  // nothing, report `null`.
  const retireGeneration = useCallback(() => {
    runGenerationRef.current += 1;
  }, []);

  useEffect(() => {
    return () => {
      // Retire FIRST: teardown cannot reach a request that has not created
      // anything yet, so the generation bump is the only thing stopping it.
      retireGeneration();
      resetInFlight();
    };
  }, [retireGeneration, resetInFlight]);

  // A preflight (cache key hash, cache read) rejected on the request that
  // currently owns the shared state. That request never reached its pre-empt
  // sweep, so an OLDER run may still be in flight — and its terminal result is
  // already suppressed as superseded, because this request claimed the newer
  // generation before the first await. Left alone that is a wedge: a worker
  // computing into nothing, nothing in flight that may publish, and `status`
  // frozen wherever the older run left it. So tear the older run down (which
  // also settles its `runToCompletion` awaiter with `null`), clear progress,
  // and publish the failure. Callers MUST check `superseded()` first — a
  // superseded preflight failure reached nobody and stays silent.
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

  // A dispatch stage FAILED for the request that currently owns the shared
  // state: the Worker constructor threw (blocked by CSP, out of memory, a
  // worker chunk that will not load) or `postMessage` threw (an input that
  // fails structured clone). `status` is already 'running' by then with nothing
  // computing behind it — the same wedge `failPreflight` exists to prevent — so
  // publish the failure and clear progress. Callers MUST check `superseded()`
  // first; a superseded dispatch failure reached nobody and stays silent.
  const failDispatch = useCallback((err: Error): void => {
    setError(err.message);
    setStatus('error');
    setProgressDone(0);
    setProgressTotal(0);
  }, []);

  const cancel = useCallback(() => {
    // Retire the generation BEFORE tearing down: a request still in its
    // preflight owns no worker for `resetInFlight` to terminate and would
    // otherwise spawn one after the user asked to stop.
    retireGeneration();
    // Terminate/abort the in-flight run and settle any awaiting
    // `runToCompletion` so a sequential driver unblocks.
    resetInFlight();
    setStatus('cancelled');
    setProgressDone(0);
    setProgressTotal(0);
  }, [retireGeneration, resetInFlight]);

  const run = useCallback(async (input: MonteCarloInput, opts?: { force?: boolean }) => {
    // Claim this request's generation BEFORE the first await, so a request that
    // loses the preflight race can tell it has been superseded.
    const generation = runGenerationRef.current + 1;
    runGenerationRef.current = generation;
    const superseded = (): boolean => runGenerationRef.current !== generation;

    // Cache-first. Key derivation (full input, seed + progress callback
    // excluded) is the shared `mcCacheKey` helper so it can't drift from the
    // metrics read key. Either preflight stage can REJECT (no `crypto.subtle`,
    // an IndexedDB failure) — see `failPreflight` for why a rejection here
    // cannot simply propagate. `run` is resultless, so it publishes the
    // failure through `error` / `status` and resolves, exactly as it does for
    // a worker error.
    let key: string;
    try {
      key = await mcCacheKey(input);
    } catch (e) {
      if (!superseded()) failPreflight(e);
      return;
    }
    if (superseded()) return;
    // Forced run (manual "Recalculate"): skip the cache short-circuit so
    // a genuinely new sample is computed even when the content signature
    // is unchanged. The result still writes through `putCached(key, …)`
    // below, overwriting the canonical entry.
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

    // Kill any previous worker / abort any previous sharded pool before
    // starting a fresh one. Settle any pending `runToCompletion` awaiter first
    // so its promise resolves `null` instead of hanging forever (the
    // terminated worker / aborted pool never posts a result). Mirrors
    // `cancel()` / the unmount cleanup.
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

    // Construction, handler installation and dispatch all sit under a guard:
    // any of the three can throw, and `status` is already 'running' by now, so
    // an escaping throw strands every consumer of this context on a run that
    // does not exist. `run` is resultless, so it publishes the failure through
    // `error` / `status` and resolves, exactly as it does for a worker error.
    // (Nothing awaits between the pre-empt sweep above and `postMessage` below,
    // so `superseded()` cannot be true here today; the check keeps the
    // publish-only-if-current rule intact if an await is ever introduced.)
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
        // Only clear the ref while it still points at THIS worker — a newer
        // request may already have swapped its own in.
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
      // Claim this request's generation BEFORE the first await (see
      // `runGenerationRef`). A superseded request resolves `null`, which every
      // caller already handles as "this request produced nothing".
      const generation = runGenerationRef.current + 1;
      runGenerationRef.current = generation;
      const superseded = (): boolean => runGenerationRef.current !== generation;

      // Either preflight stage can reject; a superseded failure reached nobody
      // and resolves `null` like every other outcome that did, while a current
      // failure resets the older run and publishes `error` before rejecting —
      // the same shape as this entry point's worker-error path.
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

      // Kill any previous worker / abort any previous sharded pool before
      // starting a fresh one. Settle any pending `runToCompletion` awaiter
      // first so its promise resolves `null` instead of hanging forever — a
      // second run here would otherwise overwrite `pendingCancelRef.current`
      // below before the prior `onCancel` could fire. Mirrors `cancel()` /
      // unmount cleanup.
      resetInFlight();
      setStatus('running');
      setError(null);
      setProgressDone(0);
      setProgressTotal(input.pathCount);

      // Large runs on a multi-worker machine shard across the pool.
      if (shouldShard(input)) {
        const controller = new AbortController();
        poolAbortRef.current = controller;
        return new Promise<MonteCarloSummary | null>((resolve, reject) => {
          let settled = false;
          const clearCancel = (): void => {
            if (pendingCancelRef.current === onCancel) pendingCancelRef.current = null;
          };
          // `cancel()` aborts the pool → runMonteCarloSharded resolves
          // 'aborted'; this resolver settles the awaiter with `null` first.
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

      // Construction is guarded for the same reason as in `run`: a Worker the
      // browser refuses to spawn would otherwise reject this promise with
      // `status` frozen at 'running' and no `error` for the page to retry from.
      // This entry point REPORTS the failure, so it publishes and then rejects
      // — the same shape as its worker-error path — unless it was superseded,
      // in which case the failure reached nobody and it resolves `null`.
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
            // Only clear the ref if it still points at THIS worker — a
            // cancel() may have already swapped it out.
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

        // Handler installation + dispatch under the same guard as construction.
        // A `postMessage` that throws inside this executor rejects the promise
        // on its own, but it does so WITHOUT terminating the worker it just
        // created, clearing `workerRef` / `pendingCancelRef`, or moving `status`
        // off 'running' — so the failure must be settled explicitly here.
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
