/**
 * Sharding coordinator. Splits ONE Monte Carlo run
 * into contiguous path ranges, fans them across a `createMcPool` worker set as
 * `{ kind: 'runShard' }` dispatches, merges the returned typed ranges on the
 * main thread (`mergePathRanges`, Stage 1), then dispatches a single
 * `{ kind: 'assemble' }` message (Stage 2 + summary) to one pool worker and
 * resolves with its `result`.
 *
 * A sharded run is bit-for-bit identical to a serial `runMonteCarlo`: per-path
 * seeds are index-derived and the merge is by absolute path index. Malformed
 * input throws synchronously on the main thread before any worker is
 * built, matching the serial path's fail-fast behavior. The pool is disposed
 * unconditionally in a `finally` — success, error, and abort
 * all tear the workers down; `dispose()` is idempotent, so a `signal`-abort
 * double-dispose is harmless.
 */
import { validateMonteCarloInput, type MonteCarloInput } from '../lib/monte-carlo';
import {
  collectAccumulationTransferables,
  mergePathRanges,
  shardBounds,
  type PathRangeResult,
} from '../lib/monte-carlo-shard';
import {
  createMcPool,
  mcPoolSize,
  type McPoolReply,
  type MinimalMcWorker,
} from './mc-worker-pool';

/** Runs at or above this path count (AND with a multi-worker pool) shard across
 *  the pool; smaller runs stay on the single-worker path. */
export const SHARD_MIN_PATHS = 2000;

export interface RunMonteCarloShardedOptions {
  /** Builds one pool worker (the Provider passes `() => new MCWorker()`). */
  factory: () => MinimalMcWorker;
  /** Aborts every in-flight shard + disposes the pool when fired. */
  signal?: AbortSignal;
  /** Summed, monotonic progress across all shards (terminal `done` =
   *  `pathCount`). */
  onProgress?: (done: number, total: number) => void;
}

/** Type guard for a dispatch reply that carries a `kind`. */
function replyKind(reply: unknown): string | undefined {
  return (reply as { kind?: string } | null)?.kind;
}

export async function runMonteCarloSharded(
  input: MonteCarloInput,
  opts: RunMonteCarloShardedOptions,
): Promise<McPoolReply> {
  // Gate malformed input on the main thread BEFORE building any worker,
  // identically (same throw, same message) to the serial `runMonteCarlo`.
  validateMonteCarloInput(input);

  const pathCount = input.pathCount;
  const shardCount = mcPoolSize(pathCount);
  const bounds = shardBounds(pathCount, shardCount);
  const pool = createMcPool({ factory: opts.factory, size: shardCount, signal: opts.signal });

  try {
    // Summed progress: each shard reports range-relative `done`; the total is
    // the whole run's `pathCount`.
    const perShardDone = new Array<number>(bounds.length).fill(0);
    const emitProgress = (i: number, done: number): void => {
      perShardDone[i] = done;
      let sum = 0;
      for (const d of perShardDone) sum += d;
      opts.onProgress?.(Math.min(sum, pathCount), pathCount);
    };

    const shardReplies = await Promise.all(
      bounds.map((b, i) =>
        // No transfer list — `input` is the SAME object on every
        // dispatch, so it is structured-cloned, never detached.
        pool.dispatch(
          { kind: 'runShard', input, pathStart: b.start, pathEnd: b.end },
          { onProgress: (done) => emitProgress(i, done) },
        ),
      ),
    );

    // Any shard aborted or errored → surface it (pool disposed in `finally`).
    for (const reply of shardReplies) {
      const kind = replyKind(reply);
      if (kind === 'aborted') return { kind: 'aborted' };
      if (kind === 'error') return reply as McPoolReply;
    }

    const ranges = shardReplies.map(
      (reply) => (reply as { kind: 'shardResult'; result: PathRangeResult }).result,
    );

    // Stage 1 on the main thread: typed, transferable merge.
    const merged = mergePathRanges(ranges, input);

    // One `assemble` dispatch runs Stage 2 + summary in a pool worker.
    const assembleReply = await pool.dispatch(
      { kind: 'assemble', input, merged },
      { transfer: collectAccumulationTransferables(merged) },
    );
    const assembleKind = replyKind(assembleReply);
    if (assembleKind === 'aborted') return { kind: 'aborted' };
    if (assembleKind === 'error') return assembleReply as McPoolReply;
    return assembleReply as McPoolReply;
  } finally {
    pool.dispose();
  }
}
