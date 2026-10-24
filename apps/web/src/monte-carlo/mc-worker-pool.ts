// Generic Monte Carlo worker pool: N stateless `monte-carlo.worker.ts` instances scheduled with bounded concurrency.
// A plain message-to-reply scheduler: `pool.run` for whole-run callers, `pool.dispatch` for the sharded coordinator.
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';

/**
 * Subset of `Worker` the pool uses, so tests can substitute a fake; the optional `transfer` and the `'error'` event
 * type are additive, so a one-arg-`postMessage`, message-only fake stays assignable.
 */
export interface MinimalMcWorker {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', fn: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message' | 'error', fn: (ev: MessageEvent) => void): void;
  terminate(): void;
}

export type McPoolReply =
  | { readonly kind: 'result'; readonly summary: MonteCarloSummary }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'aborted' };

// Whole-run callers use `pool.run`: batch sweeps on a multi-worker pool, single-counterfactual surfaces on a size-1
// pool. `run-monte-carlo-sharded.ts` uses `pool.dispatch` to spread ONE run's paths across cores; `MonteCarloProvider`
// uses neither below the shard threshold. Workers are stateless per message, so with a constant seed the result is the
// same however work is partitioned, and the whole `MonteCarloInput` is forwarded unmodified. Replies are matched by
// which worker fired the event (one message at a time, no request id); a hard crash fires no structured reply, so the
// `error` listener settles it as an error.
export interface McPool {
  /**
   * Queues one `{ kind: 'run' }` input and resolves with the worker's reply; a thin wrapper over {@link dispatch}.
   * `onProgress` forwards path-level progress. Never rejects: failures are `{ kind: 'error' }`, abort is `{ kind:
   * 'aborted' }`.
   */
  run(
    input: MonteCarloInput,
    onProgress?: (done: number, total: number) => void,
  ): Promise<McPoolReply>;
  /**
   * Queues a pre-built worker message (optional `transfer` list for zero-copy hand-off) and resolves with the raw
   * terminal reply (any `kind !== 'progress'`), so `shardResult` and `result` replies settle correctly. Never rejects:
   * abort or crash surface as `aborted` / `error`.
   */
  dispatch(
    message: unknown,
    opts?: {
      transfer?: Transferable[];
      onProgress?: (done: number, total: number) => void;
    },
  ): Promise<unknown>;
  /** Terminates every worker, drops listeners and settles pending and queued tasks as `aborted`. Idempotent. */
  dispose(): void;
  readonly size: number;
}

/**
 * Pool size: logical cores minus one (a product decision, leaving one for the UI thread, other tabs and the OS), at
 * least 1 (single core, jsdom) and no more than the work items (a 9-triple single-member sweep must not spin up 8
 * workers). A positive `requested` (the optimizer's `concurrency` knob) overrides the auto value; tests pin a size with
 * it.
 */
export function mcPoolSize(
  workItems: number,
  requested?: number,
): number {
  const cores =
    (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
  const auto = Math.max(1, cores - 1);
  const want = requested != null && requested > 0 ? Math.floor(requested) : auto;
  const cap = Math.max(1, workItems);
  return Math.max(1, Math.min(want, cap));
}

interface Slot {
  readonly worker: MinimalMcWorker;
  busy: boolean;
  resolve: ((r: unknown) => void) | null;
  onProgress: ((done: number, total: number) => void) | null;
  listener: (ev: MessageEvent) => void;
  errorListener: (ev: MessageEvent) => void;
}

interface Task {
  readonly message: unknown;
  readonly transfer?: Transferable[];
  readonly onProgress?: (done: number, total: number) => void;
  readonly resolve: (r: unknown) => void;
}

export function createMcPool(opts: {
  factory: () => MinimalMcWorker;
  size: number;
  signal?: AbortSignal;
}): McPool {
  const size = Math.max(1, Math.floor(opts.size));
  const slots: Slot[] = [];
  const queue: Task[] = [];
  let disposed = false;

  const pump = (): void => {
    if (disposed) return;
    for (const slot of slots) {
      if (slot.busy) continue;
      const task = queue.shift();
      if (!task) return; // nothing left to schedule this pass
      slot.busy = true;
      slot.resolve = task.resolve;
      slot.onProgress = task.onProgress ?? null;
      slot.worker.postMessage(task.message, task.transfer);
    }
  };

  // Shared terminal settle for a structured non-progress reply and a hard `error` event: free the slot, resolve with
  // the raw reply, pull the next task.
  const settleTerminal = (slot: Slot, reply: unknown): void => {
    const resolve = slot.resolve;
    slot.resolve = null;
    slot.onProgress = null;
    slot.busy = false;
    if (!resolve) return; // stray reply / crash with no in-flight task — ignore
    resolve(reply);
    pump(); // a slot freed → pull the next queued task
  };

  const makeSlot = (): Slot => {
    const worker = opts.factory();
    const slot: Slot = {
      worker,
      busy: false,
      resolve: null,
      onProgress: null,
      listener: () => {},
      errorListener: () => {},
    };
    slot.listener = (ev: MessageEvent): void => {
      const data = ev.data as { kind?: string; done?: number; total?: number };
      if (data && data.kind === 'progress') {
        slot.onProgress?.(data.done ?? 0, data.total ?? 0);
        return;
      }
      // Any non-progress message is terminal and resolved unchanged, so `result`, `shardResult`, `error` and the
      // `assemble` reply all settle.
      settleTerminal(slot, data);
    };
    slot.errorListener = (ev: MessageEvent): void => {
      // A hard crash fires an `error` event (an `ErrorEvent`, loosely typed) with no structured reply: settle it as one
      // rather than stall the slot.
      const message = (ev as unknown as { message?: string }).message ?? 'Worker crashed';
      settleTerminal(slot, { kind: 'error', message });
    };
    worker.addEventListener('message', slot.listener);
    worker.addEventListener('error', slot.errorListener);
    return slot;
  };

  for (let i = 0; i < size; i += 1) slots.push(makeSlot());

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    for (const slot of slots) {
      slot.worker.removeEventListener('message', slot.listener);
      slot.worker.removeEventListener('error', slot.errorListener);
      slot.worker.terminate();
      const resolve = slot.resolve;
      slot.resolve = null;
      slot.onProgress = null;
      slot.busy = false;
      resolve?.({ kind: 'aborted' });
    }
    while (queue.length > 0) {
      const task = queue.shift();
      task?.resolve({ kind: 'aborted' });
    }
  };

  function onAbort(): void {
    dispose();
  }
  if (opts.signal) opts.signal.addEventListener('abort', onAbort);

  const dispatch = (
    message: unknown,
    dispatchOpts?: {
      transfer?: Transferable[];
      onProgress?: (done: number, total: number) => void;
    },
  ): Promise<unknown> =>
    new Promise<unknown>((resolve) => {
      if (disposed || opts.signal?.aborted) {
        resolve({ kind: 'aborted' });
        return;
      }
      queue.push({
        message,
        transfer: dispatchOpts?.transfer,
        onProgress: dispatchOpts?.onProgress,
        resolve,
      });
      pump();
    });

  return {
    size,
    run(input, onProgress) {
      return dispatch({ kind: 'run', input }, { onProgress }) as Promise<McPoolReply>;
    },
    dispatch,
    dispose,
  };
}
