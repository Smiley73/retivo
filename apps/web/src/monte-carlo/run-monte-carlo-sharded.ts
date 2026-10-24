// Shards ONE Monte Carlo run: path ranges fan across a `createMcPool` set, merge on the main thread, then one `assemble`
// dispatch builds the summary. Bit-for-bit identical to serial `runMonteCarlo` (index-derived seeds, merge by path index).
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

/** Runs at or above this path count, with a multi-worker pool, shard across it; smaller ones stay on one worker. */
export const SHARD_MIN_PATHS = 2000;

export interface RunMonteCarloShardedOptions {
  /** Builds one pool worker (the Provider passes `() => new MCWorker()`). */
  factory: () => MinimalMcWorker;
  /** Aborts every in-flight shard + disposes the pool when fired. */
  signal?: AbortSignal;
  /** Summed, monotonic progress across all shards (terminal `done` = `pathCount`). */
  onProgress?: (done: number, total: number) => void;
}

function replyKind(reply: unknown): string | undefined {
  return (reply as { kind?: string } | null)?.kind;
}

export async function runMonteCarloSharded(
  input: MonteCarloInput,
  opts: RunMonteCarloShardedOptions,
): Promise<McPoolReply> {
  // Validate on the main thread before building any worker, with the same throw and message as the serial
  // `runMonteCarlo`.
  validateMonteCarloInput(input);

  const pathCount = input.pathCount;
  const shardCount = mcPoolSize(pathCount);
  const bounds = shardBounds(pathCount, shardCount);
  const pool = createMcPool({ factory: opts.factory, size: shardCount, signal: opts.signal });

  try {
    const perShardDone = new Array<number>(bounds.length).fill(0);
    const emitProgress = (i: number, done: number): void => {
      perShardDone[i] = done;
      let sum = 0;
      for (const d of perShardDone) sum += d;
      opts.onProgress?.(Math.min(sum, pathCount), pathCount);
    };

    const shardReplies = await Promise.all(
      bounds.map((b, i) =>
        // No transfer list: `input` is the same object on every dispatch, so it is cloned, never detached.
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
