/**
 * Monte Carlo Web Worker. Handles four message kinds on the main thread and
 * replies with the summary, a shard result, or an error, streaming progress.
 *
 * Loaded by `MonteCarloProvider` / the sharding coordinator via Vite's
 * `?worker` import:
 *
 *     import MCWorker from '../workers/monte-carlo.worker.ts?worker';
 *     const worker = new MCWorker();
 *
 * Protocol:
 *   main → worker: { kind: 'run', input }
 *                | { kind: 'runShard', input, pathStart, pathEnd }
 *                | { kind: 'assemble', input, merged }
 *   worker → main: { kind: 'progress', done, total }
 *                | { kind: 'result',      summary }
 *                | { kind: 'shardResult', result }   (transferable buffers)
 *                | { kind: 'error',       message, stack? }
 *
 * `run` computes a whole run (optimizer / bulk recompute / small-run
 * fallback). `runShard` simulates one contiguous path range and replies with
 * transferable typed arrays. `assemble` reconstructs the plain-array
 * accumulator from an already-merged typed payload and assembles the summary
 * A hard crash fires the `error` event, which the
 * pool settles.
 *
 * Cancel: terminate the worker (`worker.terminate()`). The next run
 * spawns a fresh instance.
 *
 * The `input` payload crosses `postMessage` via structured clone (closures do
 * NOT survive it — those are rebuilt engine-side). The market-stress
 * levers — `annualInvestmentCostPct`, the plain `returnShock` object, and
 * `inflationShockPct` — are plain scalars / a plain nested object, so they are
 * both structured-clone-safe here AND JSON-visible for the `mcCacheKey`
 * cache-key computation (`monte-carlo-cache.ts`), so a base and its stress run
 * hash to distinct keys and, sharing a seed, replay the SAME sampled paths
 * in-worker.
 */
import {
  buildRunContext,
  runMonteCarlo,
  type MonteCarloInput,
  type MonteCarloSummary,
} from '../lib/monte-carlo';
import { assembleMonteCarloSummary } from '../lib/monte-carlo-summary';
import {
  assembleAccumulationFromTyped,
  collectAccumulationTransferables,
  runPathRange,
  type MergedAccumulationTransfer,
  type PathRangeResult,
} from '../lib/monte-carlo-shard';

export type WorkerInbound =
  | { kind: 'run'; input: MonteCarloInput }
  | { kind: 'runShard'; input: MonteCarloInput; pathStart: number; pathEnd: number }
  | { kind: 'assemble'; input: MonteCarloInput; merged: MergedAccumulationTransfer };

export type WorkerOutbound =
  | { kind: 'progress'; done: number; total: number }
  | { kind: 'result'; summary: MonteCarloSummary }
  | { kind: 'shardResult'; result: PathRangeResult }
  | { kind: 'error'; message: string; stack?: string };

const post = (msg: WorkerOutbound, transfer?: Transferable[]): void => {
  const target = self as unknown as Worker;
  if (transfer) target.postMessage(msg, transfer);
  else target.postMessage(msg);
};

const postError = (e: unknown): void => {
  const err = e as Error;
  post({ kind: 'error', message: err.message ?? String(err), stack: err.stack });
};

self.addEventListener('message', (ev: MessageEvent<WorkerInbound>) => {
  const msg = ev.data;
  if (!msg) return;

  if (msg.kind === 'run') {
    try {
      const summary = runMonteCarlo({
        ...msg.input,
        onProgress(done, total) {
          post({ kind: 'progress', done, total });
        },
      });
      post({ kind: 'result', summary });
    } catch (e) {
      postError(e);
    }
    return;
  }

  if (msg.kind === 'runShard') {
    try {
      // `buildRunContext` is a pure function of `input`, so a shard worker
      // builds the SAME per-run context the serial path and every other shard
      // does — sharded ≡ serial bit-for-bit.
      const runCtx = buildRunContext(msg.input);
      const result = runPathRange(msg.input, runCtx, msg.pathStart, msg.pathEnd, (done, total) => {
        post({ kind: 'progress', done, total });
      });
      // Zero-copy hand-off of the ~single-recipient accumulators.
      post({ kind: 'shardResult', result }, collectAccumulationTransferables(result));
    } catch (e) {
      postError(e);
    }
    return;
  }

  if (msg.kind === 'assemble') {
    try {
      // `runCtx` is rebuilt here independently (deterministic) — it is
      // NOT a by-product of Stage 2. Stage 2 reconstructs the plain-array
      // accumulator from the merged typed payload, then the summary assembles.
      const runCtx = buildRunContext(msg.input);
      const acc = assembleAccumulationFromTyped(msg.merged, msg.input);
      const summary = assembleMonteCarloSummary(msg.input, runCtx, acc);
      post({ kind: 'result', summary });
    } catch (e) {
      postError(e);
    }
    return;
  }
});
