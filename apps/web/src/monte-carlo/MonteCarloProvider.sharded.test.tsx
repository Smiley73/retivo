// Sharded routing and cancel/abort wiring. The `?worker` mock never auto-replies, records the `kind` of every posted message
// and supports both worker protocols, so a run settles only through the provider's cancel or supersede path.
import 'fake-indexeddb/auto';
import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMonteCarloCache } from '../db/monte-carlo-cache';

const h = vi.hoisted(() => ({
  posted: [] as Array<{ kind: string }>,
  workers: [] as Array<{ terminated: boolean }>,
}));

vi.mock('../workers/monte-carlo.worker?worker', () => {
  class FakeMcWorker {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: { message?: string }) => void) | null = null;
    private msgListeners = new Set<(ev: MessageEvent) => void>();
    private errListeners = new Set<(ev: MessageEvent) => void>();
    terminated = false;
    constructor() {
      h.workers.push(this);
    }
    addEventListener(t: string, fn: (ev: MessageEvent) => void): void {
      (t === 'error' ? this.errListeners : this.msgListeners).add(fn);
    }
    removeEventListener(t: string, fn: (ev: MessageEvent) => void): void {
      (t === 'error' ? this.errListeners : this.msgListeners).delete(fn);
    }
    postMessage(msg: unknown): void {
      h.posted.push({ kind: (msg as { kind?: string })?.kind ?? 'unknown' });
    }
    terminate(): void {
      this.terminated = true;
    }
  }
  return { default: FakeMcWorker };
});

import { MonteCarloProvider, useMonteCarlo } from './MonteCarloProvider';
import { buildInput, setCores } from './fake-worker.test-harness';

let hook: ReturnType<typeof useMonteCarlo> | null = null;
function Probe(): null {
  hook = useMonteCarlo();
  return null;
}
function renderProvider() {
  return render(
    <MonteCarloProvider>
      <Probe />
    </MonteCarloProvider>,
  );
}

/** Poll until a message of `kind` was posted (the run `await`s an async cache
 *  key hash before dispatching), bounded so a missed dispatch fails fast. */
async function waitForKind(kind: string): Promise<void> {
  for (let i = 0; i < 200 && !h.posted.some((p) => p.kind === kind); i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

beforeEach(async () => {
  h.posted.length = 0;
  h.workers.length = 0;
  hook = null;
  await clearMonteCarloCache();
});
afterEach(async () => {
  await clearMonteCarloCache();
});

describe('MonteCarloProvider — sharding routing', () => {
  it('routes a run below SHARD_MIN_PATHS through the single worker', async () => {
    setCores(8);
    renderProvider();
    await act(async () => {
      void hook!.run(buildInput(1999));
      await waitForKind('run');
    });
    expect(h.posted.map((p) => p.kind)).toContain('run');
    expect(h.posted.some((p) => p.kind === 'runShard')).toBe(false);
    act(() => hook!.cancel());
  });

  it('shards a run at/above SHARD_MIN_PATHS on a multi-worker machine', async () => {
    setCores(4); // mcPoolSize(2000) = 3 > 1 → shard
    renderProvider();
    await act(async () => {
      void hook!.run(buildInput(2000));
      await waitForKind('runShard');
    });
    expect(h.posted.some((p) => p.kind === 'runShard')).toBe(true);
    expect(h.posted.some((p) => p.kind === 'run')).toBe(false);
    act(() => hook!.cancel());
  });

  it('keeps a large run on the single worker when the pool is size 1', async () => {
    setCores(1); // mcPoolSize(10000) = 1 → not > 1 → single worker
    renderProvider();
    await act(async () => {
      void hook!.run(buildInput(10_000));
      await waitForKind('run');
    });
    expect(h.posted.some((p) => p.kind === 'run')).toBe(true);
    expect(h.posted.some((p) => p.kind === 'runShard')).toBe(false);
    act(() => hook!.cancel());
  });
});

describe('MonteCarloProvider — sharded cancel/abort', () => {
  it('cancel() aborts an in-flight sharded run and settles runToCompletion to null', async () => {
    setCores(4);
    renderProvider();
    let settled: unknown = 'pending';
    let pending: Promise<unknown> | null = null;
    await act(async () => {
      pending = hook!.runToCompletion(buildInput(2000), { force: true });
      void pending.then((v) => {
        settled = v;
      });
      await waitForKind('runShard');
    });
    const shardWorkers = [...h.workers];
    expect(shardWorkers.length).toBeGreaterThan(0);
    await act(async () => {
      hook!.cancel();
      await pending;
    });
    expect(settled).toBeNull();
    expect(hook!.status).toBe('cancelled');
    // The pool was disposed → every shard worker terminated.
    expect(shardWorkers.every((w) => w.terminated)).toBe(true);
  });

  it('starting a new run aborts an in-flight sharded pool first', async () => {
    setCores(4);
    renderProvider();
    await act(async () => {
      void hook!.run(buildInput(2000));
      await waitForKind('runShard');
    });
    const firstShardWorkers = [...h.workers];
    expect(firstShardWorkers.length).toBeGreaterThan(0);
    await act(async () => {
      // A small superseding run takes the single-worker path; the supersede
      // guard must abort + dispose the prior pool first (no leaked workers).
      void hook!.run(buildInput(10));
      await waitForKind('run');
    });
    expect(firstShardWorkers.every((w) => w.terminated)).toBe(true);
    act(() => hook!.cancel());
  });
});
