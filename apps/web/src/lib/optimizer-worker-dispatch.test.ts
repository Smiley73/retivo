/**
 * Regression tests for `dispatchToOptimizerWorker`. The helper has two
 * concerns:
 *
 * 1. Per-call correlation via `runId`. Two consecutive dispatches for
 *    the same `scenarioId` must NOT have the second resolve to the
 *    first dispatch's stale reply — that bug surfaced when the page
 *    effect re-ran mid-flight (aggregates change via
 *    WORKSPACE_CHANGED_EVENT or cross-tab sync) and a fresh listener
 *    was registered while the OLD reply was still in-flight.
 * 2. Worker error capture. When the underlying `Worker` emits an
 *    `error` event, the helper resolves with a `kind: 'error'` reply
 *    carrying the inbound `scenarioId` + `runId` so the page can
 *    render a row-level error instead of hanging.
 *
 * The tests use a hand-rolled fake `Worker` implementing the minimal
 * `addEventListener`/`removeEventListener`/`postMessage` surface
 * `dispatchToOptimizerWorker` calls. Each posted message is recorded
 * so a test can inspect the dispatched `runId` and play it back as a
 * reply.
 */
import { describe, expect, it } from 'vitest';
import { dispatchToOptimizerWorker } from './optimizer-worker-dispatch';
import type {
  OptimizerWorkerInbound,
  OptimizerWorkerInput,
  OptimizerWorkerOutbound,
} from '../workers/claim-age-optimizer.worker';

type MessageListener = (ev: MessageEvent<OptimizerWorkerOutbound>) => void;
type ErrorListener = (ev: ErrorEvent) => void;

interface FakeWorker {
  postMessage(msg: OptimizerWorkerInbound): void;
  addEventListener(type: 'message', listener: MessageListener): void;
  addEventListener(type: 'error', listener: ErrorListener): void;
  removeEventListener(type: 'message', listener: MessageListener): void;
  removeEventListener(type: 'error', listener: ErrorListener): void;
  readonly posted: ReadonlyArray<OptimizerWorkerInbound>;
  emitMessage(out: OptimizerWorkerOutbound): void;
  emitError(message: string): void;
}

function makeFakeWorker(): FakeWorker {
  const posted: OptimizerWorkerInbound[] = [];
  const messageListeners = new Set<MessageListener>();
  const errorListeners = new Set<ErrorListener>();
  return {
    postMessage(msg: OptimizerWorkerInbound): void {
      posted.push(msg);
    },
    addEventListener(type: 'message' | 'error', listener: unknown): void {
      if (type === 'message') {
        messageListeners.add(listener as MessageListener);
      } else {
        errorListeners.add(listener as ErrorListener);
      }
    },
    removeEventListener(type: 'message' | 'error', listener: unknown): void {
      if (type === 'message') {
        messageListeners.delete(listener as MessageListener);
      } else {
        errorListeners.delete(listener as ErrorListener);
      }
    },
    get posted(): ReadonlyArray<OptimizerWorkerInbound> {
      return posted;
    },
    emitMessage(out: OptimizerWorkerOutbound): void {
      for (const l of messageListeners) {
        l({ data: out } as MessageEvent<OptimizerWorkerOutbound>);
      }
    },
    emitError(message: string): void {
      for (const l of errorListeners) {
        l({ message } as ErrorEvent);
      }
    },
  };
}

function makeInput(scenarioId: string): OptimizerWorkerInput {
  // Minimal shape — the dispatch helper only reads `scenarioId`; the
  // rest is passed opaquely to the worker.
  return {
    scenarioId,
    scenarios: [],
    accounts: [],
    balances: [],
    members: [],
    ssBenefits: [],
    expenses: [],
    incomeStreams: [],
    todayIso: '2026-05-19T00:00:00Z',
  };
}

describe('dispatchToOptimizerWorker', () => {
  it('should_tag_each_dispatch_with_a_unique_runId', () => {
    const worker = makeFakeWorker();
    void dispatchToOptimizerWorker(worker as unknown as Worker, makeInput('s'));
    void dispatchToOptimizerWorker(worker as unknown as Worker, makeInput('s'));
    expect(worker.posted).toHaveLength(2);
    const firstRunId = worker.posted[0].runId;
    const secondRunId = worker.posted[1].runId;
    expect(firstRunId).toBeTruthy();
    expect(secondRunId).toBeTruthy();
    expect(firstRunId).not.toBe(secondRunId);
  });

  it('should_not_resolve_new_dispatch_with_stale_reply_for_same_scenarioId', async () => {
    // Concurrency regression — two consecutive dispatches for scenario
    // 's'. The OLD reply arrives AFTER the new listener is registered.
    // Without runId filtering, the new dispatch's promise resolves to
    // the OLD reply (both listeners match scenarioId='s').
    const worker = makeFakeWorker();
    const firstPromise = dispatchToOptimizerWorker(
      worker as unknown as Worker,
      makeInput('s'),
    );
    const oldRunId = worker.posted[0].runId;
    const secondPromise = dispatchToOptimizerWorker(
      worker as unknown as Worker,
      makeInput('s'),
    );
    const newRunId = worker.posted[1].runId;

    // Deliver the OLD reply first. The NEW promise must NOT resolve
    // from it; the OLD promise must.
    worker.emitMessage({
      kind: 'result',
      runId: oldRunId,
      scenarioId: 's',
      winner: null,
      partial: false,
      missingPiaMembers: [],
    });

    const oldOut = await firstPromise;
    expect(oldOut.kind).toBe('result');
    if (oldOut.kind === 'result') expect(oldOut.runId).toBe(oldRunId);

    // The NEW promise has not resolved yet — race it against a short
    // timer to assert pending.
    const sentinel = Symbol('pending');
    const raced = await Promise.race([
      secondPromise,
      new Promise<typeof sentinel>((r) => setTimeout(() => r(sentinel), 30)),
    ]);
    expect(raced).toBe(sentinel);

    // Now deliver the NEW reply; the NEW promise resolves to it.
    worker.emitMessage({
      kind: 'result',
      runId: newRunId,
      scenarioId: 's',
      winner: null,
      partial: true,
      missingPiaMembers: ['m1'],
    });
    const newOut = await secondPromise;
    expect(newOut.kind).toBe('result');
    if (newOut.kind === 'result') {
      expect(newOut.runId).toBe(newRunId);
      expect(newOut.partial).toBe(true);
      expect(newOut.missingPiaMembers).toEqual(['m1']);
    }
  });

  it('should_resolve_with_error_kind_when_worker_emits_error', async () => {
    // onError branch — when the underlying Worker emits an `error`
    // event the helper resolves (never rejects) with a kind:'error'
    // reply carrying the inbound scenarioId + runId so the page can
    // render a row-level error.
    const worker = makeFakeWorker();
    const promise = dispatchToOptimizerWorker(
      worker as unknown as Worker,
      makeInput('s'),
    );
    const runId = worker.posted[0].runId;
    worker.emitError('worker boom');
    const out = await promise;
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.scenarioId).toBe('s');
      expect(out.runId).toBe(runId);
      expect(out.message).toBe('worker boom');
    }
  });
});
