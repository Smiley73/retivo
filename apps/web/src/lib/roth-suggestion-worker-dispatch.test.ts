import { describe, expect, it, vi } from 'vitest';
import type {
  RothSuggestionWorkerInbound,
  RothSuggestionWorkerInput,
  RothSuggestionWorkerOutbound,
} from '../workers/roth-suggestion.worker';
import { dispatchToRothSuggestionWorker } from './roth-suggestion-worker-dispatch';

class FakeWorker {
  readonly listeners = new Map<string, Set<(ev: Event) => void>>();
  readonly sent: RothSuggestionWorkerInbound[] = [];
  addEventListener(type: string, fn: (ev: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (ev: Event) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  postMessage(msg: RothSuggestionWorkerInbound): void {
    this.sent.push(msg);
  }
  reply(msg: RothSuggestionWorkerOutbound): void {
    this.listeners.get('message')?.forEach((fn) => fn(new MessageEvent('message', { data: msg })));
  }
  crash(message: string): void {
    this.listeners.get('error')?.forEach((fn) => fn({ message } as ErrorEvent));
  }
  listenerCount(): number {
    return (this.listeners.get('message')?.size ?? 0) + (this.listeners.get('error')?.size ?? 0);
  }
}

const INPUT = { projection: { selectedScenarioId: 's1' } } as unknown as RothSuggestionWorkerInput;

function start(onProgress?: (tick: { done: number; total: number }) => void) {
  const worker = new FakeWorker();
  const promise = dispatchToRothSuggestionWorker(worker as unknown as Worker, INPUT, onProgress);
  const runId = worker.sent[0].runId;
  return { worker, promise, runId };
}

describe('dispatchToRothSuggestionWorker', () => {
  it('posts one run request and resolves only on the terminal reply of its own runId', async () => {
    const { worker, promise, runId } = start();
    expect(worker.sent).toEqual([{ kind: 'run', runId, input: INPUT }]);
    expect(runId).not.toBe('');
    const settled = vi.fn();
    void promise.then(settled);

    worker.reply({ kind: 'error', runId: 'someone-else', scenarioId: 's1', message: 'old run' });
    worker.reply({ kind: 'progress', runId, done: 1, total: 9 });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    worker.reply({ kind: 'empty', runId, scenarioId: 's1', reason: 'no-roth-ira' });
    await expect(promise).resolves.toEqual({
      kind: 'empty',
      runId,
      scenarioId: 's1',
      reason: 'no-roth-ira',
    });
  });

  it('forwards progress ticks of its own runId only', async () => {
    const onProgress = vi.fn();
    const { worker, promise, runId } = start(onProgress);

    worker.reply({ kind: 'progress', runId: 'cancelled-run', done: 5, total: 9 });
    worker.reply({ kind: 'progress', runId, done: 1, total: 9 });
    worker.reply({ kind: 'progress', runId, done: 2, total: 9 });
    worker.reply({ kind: 'error', runId, scenarioId: 's1', message: 'x' });
    await promise;

    expect(onProgress.mock.calls).toEqual([
      [{ done: 1, total: 9 }],
      [{ done: 2, total: 9 }],
    ]);
  });

  it('removes its listeners once the terminal reply lands', async () => {
    const { worker, promise, runId } = start();
    expect(worker.listenerCount()).toBe(2);
    worker.reply({ kind: 'error', runId, scenarioId: 's1', message: 'x' });
    await promise;
    expect(worker.listenerCount()).toBe(0);
  });

  it('resolves an error reply when the worker crashes, and removes its listeners', async () => {
    const { worker, promise, runId } = start();
    worker.crash('boom');
    await expect(promise).resolves.toEqual({
      kind: 'error',
      runId,
      scenarioId: 's1',
      message: 'boom',
    });
    expect(worker.listenerCount()).toBe(0);
  });
});
