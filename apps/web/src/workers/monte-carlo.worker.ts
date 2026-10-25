// Monte Carlo Web Worker (Vite `?worker`): handles `run`, `runShard` (one path range) and `assemble` (merged typed payload);
// replies are `result`, `shardResult` (transferable buffers) or `error`, with `progress` streamed. Cancel is `worker.terminate()`.
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

// `input` crosses `postMessage` by structured clone (closures do not survive; they are rebuilt engine-side). The
// market-stress levers (`annualInvestmentCostPct`, the plain `returnShock`, `inflationShockPct`) are plain values, so
// they are clone-safe and JSON-visible to the `mcCacheKey` hash (`monte-carlo-cache.ts`): a base and its stress run
// hash to distinct keys yet, sharing a seed, replay the same sampled paths.
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
      // `buildRunContext` is pure in `input`, so every shard and the serial path build the same context: sharded equals
      // serial bit-for-bit.
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
      // `runCtx` is rebuilt here independently (deterministic), not carried over from stage 2.
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
