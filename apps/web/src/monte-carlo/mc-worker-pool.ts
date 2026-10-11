/**
 * Generic Monte Carlo worker pool. Owns N stateless
 * `monte-carlo.worker.ts` instances and schedules messages across them
 * with bounded concurrency. There are two usage shapes, deliberately
 * described by category rather than by count — an exact tally goes stale
 * every time a surface adds an on-demand run:
 *
 *  - **Whole-run callers** (`pool.run`), each dispatching independent
 *    `{ kind: 'run' }` runs: batch sweeps over a candidate grid or a
 *    scenario list (`optimizer-mc-runner.ts`,
 *    `use-scenario-bulk-recompute.ts`) on a multi-worker pool, and
 *    single-counterfactual surfaces on a size-1 pool — the Plan Stress
 *    Test's guardrail-sibling run (`PlanStressTestSection.tsx`), the
 *    Balance Projection page's market-stress comparison walking the
 *    named stress cases sequentially (`plan-market-stress-comparison.ts`),
 *    and the Guardrails page's bounded "Check now" run
 *    (`pages/use-guardrails-vm.ts`).
 *  - **Dispatch-shaped caller** (`pool.dispatch`):
 *    `run-monte-carlo-sharded.ts` fans `{ kind: 'runShard' }` /
 *    `{ kind: 'assemble' }` messages over the pool to spread ONE run's
 *    paths across cores.
 *
 * `MonteCarloProvider` uses neither directly below the shard threshold:
 * it spawns a fresh single worker per run (not a persistent instance)
 * and routes larger runs through the sharded coordinator.
 *
 * The pool knows nothing about scenarios or triples — it is a plain
 * message→reply scheduler. Each worker is stateless per message, so
 * spreading messages across N fresh instances does not change any
 * result; with a constant seed the outcome is identical regardless of
 * how work is partitioned across workers. It forwards the whole
 * `MonteCarloInput` unmodified, so the market-stress levers
 * (`annualInvestmentCostPct`, `returnShock`, `inflationShockPct`) and a
 * longevity-extended horizon ride through to the worker as-is — a base and its
 * same-seed stress run schedule independently yet reuse identical paths.
 *
 * Reply correlation: each worker handles at most one message at a time,
 * so a reply is matched to its request by *which worker* fired the
 * event — no request id. One persistent `message` listener AND one
 * `error` listener are installed per worker at construction. The `error`
 * listener settles a hard worker crash (which fires no structured
 * `{ kind: 'error' }` reply) as an error instead of stalling the slot
 * forever.
 */
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';

/** Subset of `Worker` the pool uses. Lets tests substitute a fake
 *  without implementing the entire `Worker` interface. `postMessage`'s
 *  optional `transfer` param and the `'error'` event type are additive —
 *  a 1-arg-`postMessage` / message-only fake stays structurally
 *  assignable. */
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

export interface McPool {
  /** Queue one `{ kind: 'run' }` input; resolves with the worker's reply.
   *  A thin wrapper over {@link dispatch}. The optional `onProgress`
   *  forwards that input's path-level `{ kind: 'progress' }` messages so a
   *  caller can drive a smooth bar. Never rejects — failures surface as
   *  `{ kind: 'error' }`, abort as `{ kind: 'aborted' }`. */
  run(
    input: MonteCarloInput,
    onProgress?: (done: number, total: number) => void,
  ): Promise<McPoolReply>;
  /** Queue an arbitrary pre-built worker `message` (with an optional
   *  `transfer` list for zero-copy `ArrayBuffer` hand-off); resolves with
   *  the RAW terminal reply (any `kind !== 'progress'` message) so callers
   *  reading `{ kind: 'shardResult' }` / `{ kind: 'result' }` settle
   *  correctly. `onProgress` forwards `{ kind: 'progress' }` messages.
   *  Never rejects — abort / crash surface as `{ kind: 'aborted' }` /
   *  `{ kind: 'error' }`. */
  dispatch(
    message: unknown,
    opts?: {
      transfer?: Transferable[];
      onProgress?: (done: number, total: number) => void;
    },
  ): Promise<unknown>;
  /** Terminate every worker, drop listeners, and settle every pending +
   *  queued task as `aborted`. Idempotent. */
  dispose(): void;
  readonly size: number;
}

/**
 * Pool size = the available logical cores minus one (per product
 * decision), leaving a single core for the UI thread, other tabs, and
 * the OS. Floored at 1 (single-core / jsdom) and never larger than the
 * number of work items — a 9-triple single-member sweep must not spin
 * up 8 workers. `requested` (the optimizer's `concurrency` knob)
 * overrides the auto value when positive; tests pass it to pin a
 * deterministic size.
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
  /** The fully-formed worker message (`{ kind: 'run', input }`,
   *  `{ kind: 'runShard', … }`, `{ kind: 'assemble', … }`, …). */
  readonly message: unknown;
  /** Optional zero-copy `ArrayBuffer` transfer list for `postMessage`. */
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

  // Shared terminal-settle path for both a structured non-progress reply
  // and a hard `error` event: free the slot, resolve the pending
  // promise with the raw reply (kind-agnostic), pull the next task.
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
        // Non-terminal: forward to the in-flight run's progress sink.
        slot.onProgress?.(data.done ?? 0, data.total ?? 0);
        return;
      }
      // Any non-progress message is terminal — resolve with it unchanged so
      // `result` / `shardResult` / `error` / the `assemble` reply all settle.
      settleTerminal(slot, data);
    };
    slot.errorListener = (ev: MessageEvent): void => {
      // A hard worker crash fires the `error` event (an `ErrorEvent` with a
      // `message`, typed loosely here) with no structured `{ kind: 'error' }`
      // reply — settle it as one instead of stalling the slot forever.
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
      // Thin wrapper — byte-identical behavior for every existing caller.
      return dispatch({ kind: 'run', input }, { onProgress }) as Promise<McPoolReply>;
    },
    dispatch,
    dispose,
  };
}
