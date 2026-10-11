/**
 * Unit tests for the generic MC worker pool. The pool is driven through
 * a fake `MinimalMcWorker` whose reply timing the test controls, so we
 * can assert bounded concurrency, per-worker reply correlation,
 * progress forwarding, and abort/dispose semantics without a real
 * `Worker`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createMcPool,
  mcPoolSize,
  type MinimalMcWorker,
} from './mc-worker-pool';
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';

function fakeInput(seed: number): MonteCarloInput {
  // Only the fields the pool/tests read need to be real; the pool treats
  // the input as an opaque payload it forwards to the worker.
  return { seed, pathCount: 1000 } as unknown as MonteCarloInput;
}

function summary(successProbability: number): MonteCarloSummary {
  return { successProbability } as unknown as MonteCarloSummary;
}

interface ControlledWorker extends MinimalMcWorker {
  /** Deliver the terminal result for the input currently in flight. */
  resolveResult(successProbability: number): void;
  /** Deliver a terminal error for the input currently in flight. */
  emitError(message: string): void;
  /** Emit a non-terminal progress message for the in-flight input. */
  emitProgress(done: number, total: number): void;
  /** Deliver an arbitrary raw terminal reply (any non-progress kind). */
  emitReply(reply: unknown): void;
  /** Fire a hard `error` event — reaches ONLY `error`-type listeners,
   *  never the `message`-type ones, so a crash is distinct from a structured
   *  `{ kind: 'error' }` reply. */
  emitCrash(message: string): void;
  /** The `input` field of each `{ kind: 'run', input }` message posted. */
  readonly posted: ReadonlyArray<MonteCarloInput>;
  /** Every raw message posted (`run` / `runShard` / `assemble` / …). */
  readonly postedMessages: ReadonlyArray<unknown>;
  /** The `transfer` list argument of each `postMessage` call (may be
   *  `undefined` when none was supplied). */
  readonly postedTransfers: ReadonlyArray<Transferable[] | undefined>;
  readonly terminated: boolean;
}

/** A worker the test ticks by hand: it buffers nothing automatically —
 *  the test calls `resolveResult`/`emitProgress`/`emitCrash` to drive replies.
 *  Listeners are tracked PER EVENT TYPE so an `error`-event crash reaches only
 *  the pool's error listener, never its message listener. */
function controlledWorker(): ControlledWorker {
  const messageListeners = new Set<(ev: MessageEvent) => void>();
  const errorListeners = new Set<(ev: MessageEvent) => void>();
  const posted: MonteCarloInput[] = [];
  const postedMessages: unknown[] = [];
  const postedTransfers: Array<Transferable[] | undefined> = [];
  let terminated = false;
  const emit = (data: unknown): void => {
    const ev = { data } as MessageEvent;
    messageListeners.forEach((fn) => fn(ev));
  };
  return {
    posted,
    postedMessages,
    postedTransfers,
    get terminated() {
      return terminated;
    },
    addEventListener(type, fn) {
      (type === 'error' ? errorListeners : messageListeners).add(fn);
    },
    removeEventListener(type, fn) {
      (type === 'error' ? errorListeners : messageListeners).delete(fn);
    },
    postMessage(msg: unknown, transfer?: Transferable[]) {
      postedMessages.push(msg);
      postedTransfers.push(transfer);
      const m = msg as { kind: string; input?: MonteCarloInput };
      if (m.kind === 'run' && m.input) posted.push(m.input);
    },
    terminate() {
      terminated = true;
    },
    resolveResult(successProbability: number) {
      emit({ kind: 'result', summary: summary(successProbability) });
    },
    emitError(message: string) {
      emit({ kind: 'error', message });
    },
    emitProgress(done: number, total: number) {
      emit({ kind: 'progress', done, total });
    },
    emitReply(reply: unknown) {
      emit(reply);
    },
    emitCrash(message: string) {
      const ev = { message } as unknown as MessageEvent;
      errorListeners.forEach((fn) => fn(ev));
    },
  };
}

describe('mcPoolSize', () => {
  it('should_floor_at_one_and_cap_at_work_item_count', () => {
    // Never exceed the number of work items …
    expect(mcPoolSize(1, 8)).toBe(1);
    // … and never drop below one.
    expect(mcPoolSize(0, 8)).toBe(1);
    expect(mcPoolSize(50, 4)).toBe(4);
  });

  it('should_honour_a_positive_requested_override', () => {
    expect(mcPoolSize(100, 6)).toBe(6);
    // Non-positive request falls back to the auto (cores − 1) value, which
    // is environment-dependent but always ≥ 1 and ≤ workItems.
    const auto = mcPoolSize(100, 0);
    expect(auto).toBeGreaterThanOrEqual(1);
    expect(auto).toBeLessThanOrEqual(100);
  });
});

describe('createMcPool', () => {
  it('should_construct_exactly_size_workers', () => {
    const built: ControlledWorker[] = [];
    const pool = createMcPool({
      size: 3,
      factory: () => {
        const w = controlledWorker();
        built.push(w);
        return w;
      },
    });
    expect(pool.size).toBe(3);
    expect(built.length).toBe(3);
    pool.dispose();
  });

  it('should_keep_at_most_size_runs_in_flight_and_drain_the_queue', async () => {
    const built: ControlledWorker[] = [];
    const pool = createMcPool({
      size: 2,
      factory: () => {
        const w = controlledWorker();
        built.push(w);
        return w;
      },
    });
    // Queue four runs against a 2-worker pool.
    const replies = [0, 1, 2, 3].map((i) => pool.run(fakeInput(i)));
    // Only the two workers should have a run posted; runs 3 + 4 wait.
    const postedNow = built.reduce((n, w) => n + w.posted.length, 0);
    expect(postedNow).toBe(2);
    // Resolve both in-flight runs → the queued pair dispatches.
    built[0].resolveResult(0.5);
    built[1].resolveResult(0.6);
    await Promise.resolve();
    const postedAfter = built.reduce((n, w) => n + w.posted.length, 0);
    expect(postedAfter).toBe(4);
    built[0].resolveResult(0.7);
    built[1].resolveResult(0.8);
    const results = await Promise.all(replies);
    expect(results.every((r) => r.kind === 'result')).toBe(true);
    pool.dispose();
  });

  it('should_correlate_each_reply_to_its_own_worker', async () => {
    const built: ControlledWorker[] = [];
    const pool = createMcPool({
      size: 2,
      factory: () => {
        const w = controlledWorker();
        built.push(w);
        return w;
      },
    });
    const a = pool.run(fakeInput(1));
    const b = pool.run(fakeInput(2));
    // Resolve worker 1 first with a distinct value, then worker 0.
    built[1].resolveResult(0.9);
    built[0].resolveResult(0.1);
    const [ra, rb] = await Promise.all([a, b]);
    // `a` ran on worker 0 (first idle slot), `b` on worker 1 — replies
    // must not cross even though worker 1 answered first.
    expect(ra.kind === 'result' && ra.summary.successProbability).toBe(0.1);
    expect(rb.kind === 'result' && rb.summary.successProbability).toBe(0.9);
    pool.dispose();
  });

  it('should_forward_progress_messages_to_the_in_flight_run', async () => {
    const built: ControlledWorker[] = [];
    const pool = createMcPool({
      size: 1,
      factory: () => {
        const w = controlledWorker();
        built.push(w);
        return w;
      },
    });
    const onProgress = vi.fn();
    const reply = pool.run(fakeInput(1), onProgress);
    built[0].emitProgress(250, 1000);
    built[0].emitProgress(750, 1000);
    expect(onProgress.mock.calls).toEqual([
      [250, 1000],
      [750, 1000],
    ]);
    built[0].resolveResult(0.5);
    await reply;
    pool.dispose();
  });

  it('should_surface_worker_errors_without_rejecting', async () => {
    const built: ControlledWorker[] = [];
    const pool = createMcPool({
      size: 1,
      factory: () => {
        const w = controlledWorker();
        built.push(w);
        return w;
      },
    });
    const reply = pool.run(fakeInput(1));
    built[0].emitError('boom');
    const r = await reply;
    expect(r).toEqual({ kind: 'error', message: 'boom' });
    pool.dispose();
  });

  it('should_free_the_slot_after_an_error_so_the_next_run_dispatches', async () => {
    const built: ControlledWorker[] = [];
    const pool = createMcPool({
      size: 1,
      factory: () => {
        const w = controlledWorker();
        built.push(w);
        return w;
      },
    });
    const first = pool.run(fakeInput(1));
    const second = pool.run(fakeInput(2)); // queued behind the one worker
    built[0].emitError('boom');
    expect((await first).kind).toBe('error');
    await Promise.resolve();
    // The errored slot freed → the queued run was posted.
    expect(built[0].posted.length).toBe(2);
    built[0].resolveResult(0.5);
    expect((await second).kind).toBe('result');
    pool.dispose();
  });

  it('should_resolve_pending_and_queued_runs_as_aborted_on_dispose', async () => {
    const built: ControlledWorker[] = [];
    const pool = createMcPool({
      size: 1,
      factory: () => {
        const w = controlledWorker();
        built.push(w);
        return w;
      },
    });
    const inflight = pool.run(fakeInput(1)); // dispatched to the one worker
    const queued = pool.run(fakeInput(2)); // waits in the queue
    pool.dispose();
    expect(built[0].terminated).toBe(true);
    expect((await inflight).kind).toBe('aborted');
    expect((await queued).kind).toBe('aborted');
    // Runs requested after dispose resolve aborted immediately.
    expect((await pool.run(fakeInput(3))).kind).toBe('aborted');
  });

  it('should_settle_a_hard_worker_crash_as_error_and_free_the_slot', async () => {
    // A hard crash fires the `error` event (no structured `{kind:'error'}`
    // reply). Without the error listener the slot would stall forever.
    const built: ControlledWorker[] = [];
    const pool = createMcPool({
      size: 1,
      factory: () => {
        const w = controlledWorker();
        built.push(w);
        return w;
      },
    });
    const first = pool.run(fakeInput(1));
    const second = pool.run(fakeInput(2)); // queued behind the one worker
    built[0].emitCrash('segfault');
    expect(await first).toEqual({ kind: 'error', message: 'segfault' });
    await Promise.resolve();
    // The crashed slot freed → the queued run dispatched via pump().
    expect(built[0].posted.length).toBe(2);
    built[0].resolveResult(0.5);
    expect((await second).kind).toBe('result');
    pool.dispose();
  });

  it('should_ignore_a_crash_with_no_in_flight_task', async () => {
    // Edge: a crash while the slot is idle (`slot.resolve === null`) is a
    // silent no-op — the next run still dispatches and settles normally.
    const built: ControlledWorker[] = [];
    const pool = createMcPool({
      size: 1,
      factory: () => {
        const w = controlledWorker();
        built.push(w);
        return w;
      },
    });
    built[0].emitCrash('stray'); // nothing in flight — no-op
    const reply = pool.run(fakeInput(1));
    built[0].resolveResult(0.7);
    expect((await reply).kind).toBe('result');
    pool.dispose();
  });

  it('should_not_reach_a_listener_after_dispose', () => {
    const built: ControlledWorker[] = [];
    const pool = createMcPool({
      size: 1,
      factory: () => {
        const w = controlledWorker();
        built.push(w);
        return w;
      },
    });
    void pool.run(fakeInput(1));
    pool.dispose();
    // Listeners were removed on dispose — a late crash reaches nothing and
    // cannot throw (the slot's resolve is already null anyway).
    expect(() => built[0].emitCrash('late')).not.toThrow();
  });

  it('should_dispatch_an_arbitrary_message_and_settle_on_any_non_progress_reply', async () => {
    // Generalization: `dispatch()` carries a pre-built message + transfer
    // list and resolves with the RAW terminal reply, kind-agnostic.
    const built: ControlledWorker[] = [];
    const pool = createMcPool({
      size: 1,
      factory: () => {
        const w = controlledWorker();
        built.push(w);
        return w;
      },
    });
    const buf = new Float64Array([1, 2, 3]).buffer;
    const onProgress = vi.fn();
    const reply = pool.dispatch(
      { kind: 'runShard', input: fakeInput(1), pathStart: 0, pathEnd: 500 },
      { transfer: [buf], onProgress },
    );
    // The message + its transfer list were forwarded unchanged.
    expect(built[0].postedMessages[0]).toEqual({
      kind: 'runShard',
      input: fakeInput(1),
      pathStart: 0,
      pathEnd: 500,
    });
    expect(built[0].postedTransfers[0]).toEqual([buf]);
    // Progress still forwards.
    built[0].emitProgress(100, 500);
    expect(onProgress.mock.calls).toEqual([[100, 500]]);
    // A `shardResult` reply (not `result`/`error`) settles the promise as-is.
    const shardReply = { kind: 'shardResult', result: { pathStart: 0, pathEnd: 500 } };
    built[0].emitReply(shardReply);
    expect(await reply).toBe(shardReply);
    pool.dispose();
  });

  it('should_resolve_a_dispatch_as_aborted_after_dispose', async () => {
    const pool = createMcPool({ size: 1, factory: () => controlledWorker() });
    pool.dispose();
    expect(await pool.dispatch({ kind: 'assemble' })).toEqual({ kind: 'aborted' });
  });

  it('should_dispose_when_its_signal_aborts', async () => {
    const controller = new AbortController();
    const built: ControlledWorker[] = [];
    const pool = createMcPool({
      size: 1,
      signal: controller.signal,
      factory: () => {
        const w = controlledWorker();
        built.push(w);
        return w;
      },
    });
    const reply = pool.run(fakeInput(1));
    controller.abort();
    expect(built[0].terminated).toBe(true);
    expect((await reply).kind).toBe('aborted');
  });
});
