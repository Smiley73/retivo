// Cache-first run, the forced-run (`{ force: true }`) cache bypass and overwrite, and progress threading, against a fake Worker that posts a deterministic result per run.
import 'fake-indexeddb/auto';
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';
import { clearMonteCarloCache, monteCarloCacheCount } from '../db/monte-carlo-cache';
import { fakeSummary } from './fake-worker.test-harness';

let workerRuns: Array<{ seed: number }> = [];
// Auto mode posts each result on a microtask; manual mode records the run and stays silent until `flushWorkerDelivery`, so the pre-empt tests have no scheduling race.
let manualWorkerDelivery = false;
// Keyed by seed, not spawn index: concurrent runs await an async cache-key hash first and can spawn out of call order.
let liveWorkers: Array<{ seed: number; deliver: () => void }> = [];

function flushWorkerDelivery(seed: number): void {
  liveWorkers.find((w) => w.seed === seed)?.deliver();
}

// Yields a macrotask per iteration because the cache-key hash is genuinely async; bounded so a missed spawn fails fast.
async function waitForWorker(seed: number): Promise<void> {
  for (let i = 0; i < 1000 && !liveWorkers.some((w) => w.seed === seed); i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

vi.mock('../workers/monte-carlo.worker?worker', () => {
  class FakeMcWorker {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: { message?: string }) => void) | null = null;
    // A terminated worker delivers nothing, like a real `Worker.terminate()`.
    private terminated = false;
    postMessage(msg: unknown): void {
      const m = msg as { kind: string; input: MonteCarloInput };
      if (m.kind !== 'run') return;
      const seed = m.input.seed;
      workerRuns.push({ seed });
      const deliver = (): void => {
        if (this.terminated) return;
        this.onmessage?.(
          new MessageEvent('message', {
            data: { kind: 'progress', done: m.input.pathCount, total: m.input.pathCount },
          }),
        );
        if (this.terminated) return;
        this.onmessage?.(
          new MessageEvent('message', {
            data: { kind: 'result', summary: fakeSummary(seed) },
          }),
        );
      };
      liveWorkers.push({ seed, deliver });
      if (!manualWorkerDelivery) {
        queueMicrotask(deliver);
      }
    }
    terminate(): void {
      this.terminated = true;
    }
  }
  return { default: FakeMcWorker };
});

import { MonteCarloProvider, useMonteCarlo } from './MonteCarloProvider';

const INPUT: MonteCarloInput = {
  portfolioToday: 500_000,
  accountMcLedger: [],
  annualContribution: 0,
  firstYear: 2026,
  retirementYear: 2046,
  horizonYear: 2086,
  monthlyExpenseBase: [],
  ssByYear: [0],
  incomeByYear: [0],
  pathCount: 10,
  seed: 111,
  strategyKind: 'taxEfficient',
  events: [],
};

let hook: ReturnType<typeof useMonteCarlo> | null = null;
function Probe() {
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

beforeEach(async () => {
  workerRuns = [];
  liveWorkers = [];
  manualWorkerDelivery = false;
  hook = null;
  await clearMonteCarloCache();
});
afterEach(async () => {
  await clearMonteCarloCache();
});

describe('MonteCarloProvider — cache-first run', () => {
  it('spawns the worker on a cache miss, then serves the cached result without re-spawning', async () => {
    renderProvider();
    await act(async () => {
      await hook!.run(INPUT);
    });
    await waitFor(() => expect(hook!.status).toBe('done'));
    expect(workerRuns).toHaveLength(1);
    expect(hook!.result?.seed).toBe(111);
    await waitFor(async () => expect(await monteCarloCacheCount()).toBe(1));

    await act(async () => {
      await hook!.run(INPUT);
    });
    await waitFor(() => expect(hook!.status).toBe('done'));
    expect(workerRuns).toHaveLength(1);
  });

  it('threads path progress through progressDone / progressTotal', async () => {
    renderProvider();
    await act(async () => {
      await hook!.run(INPUT);
    });
    await waitFor(() => expect(hook!.status).toBe('done'));
    expect(hook!.progressTotal).toBe(10);
    expect(hook!.progressDone).toBe(10);
  });
});

describe('MonteCarloProvider — forced run bypasses the cache', () => {
  it('force: true spawns the worker even on a cache hit and overwrites the entry with the fresh sample', async () => {
    renderProvider();
    await act(async () => {
      await hook!.run(INPUT);
    });
    await waitFor(() => expect(hook!.status).toBe('done'));
    expect(workerRuns).toHaveLength(1);
    await waitFor(async () => expect(await monteCarloCacheCount()).toBe(1));

    // The cache key excludes the seed, so the forced run overwrites the single canonical entry.
    await act(async () => {
      await hook!.run({ ...INPUT, seed: 222 }, { force: true });
    });
    await waitFor(() => expect(hook!.result?.seed).toBe(222));
    expect(workerRuns).toHaveLength(2);
    expect(workerRuns[1].seed).toBe(222);
    await waitFor(async () => expect(await monteCarloCacheCount()).toBe(1));
  });

  it('runToCompletion resolves with the summary only AFTER the worker finishes, and writes the cache', async () => {
    renderProvider();
    let resolved: { seed: number } | null = null;
    await act(async () => {
      const summary = await hook!.runToCompletion(INPUT, { force: true });
      resolved = summary;
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.seed).toBe(INPUT.seed);
    expect(workerRuns).toHaveLength(1);
    await waitFor(async () => expect(await monteCarloCacheCount()).toBe(1));
    await act(async () => {
      await hook!.run(INPUT);
    });
    expect(workerRuns).toHaveLength(1);
  });

  it('runToCompletion serves a cached hit without spawning a worker', async () => {
    renderProvider();
    await act(async () => {
      await hook!.runToCompletion(INPUT, { force: true });
    });
    expect(workerRuns).toHaveLength(1);
    let hit: { seed: number } | null = null;
    await act(async () => {
      hit = await hook!.runToCompletion(INPUT);
    });
    expect(hit).not.toBeNull();
    expect(workerRuns).toHaveLength(1);
  });

  // The pre-empt tests run in manual delivery mode: the first worker never delivers, so its `runToCompletion` can only settle through the provider's cancel-to-null path.
  it('settles a pending runToCompletion to null when a new run() pre-empts it', async () => {
    manualWorkerDelivery = true;
    renderProvider();
    let pending: Promise<MonteCarloSummary | null> | null = null;
    let settled: MonteCarloSummary | null | 'pending' = 'pending';
    await act(async () => {
      pending = hook!.runToCompletion(INPUT, { force: true });
      void pending.then((v) => {
        settled = v;
      });
      // Wait until the first run's worker has spawned so the pre-empt sweep finds its cancel-resolver; the cache-key hashes can otherwise complete out of order.
      await waitForWorker(INPUT.seed);
      await hook!.run({ ...INPUT, seed: 222 }, { force: true });
    });
    await expect(pending!).resolves.toBeNull();
    expect(settled).toBeNull();
  });

  it('settles a pending runToCompletion to null when a new runToCompletion pre-empts it', async () => {
    manualWorkerDelivery = true;
    renderProvider();
    let first: Promise<MonteCarloSummary | null> | null = null;
    let firstSettled: MonteCarloSummary | null | 'pending' = 'pending';
    let second: Promise<MonteCarloSummary | null> | null = null;
    await act(async () => {
      first = hook!.runToCompletion(INPUT, { force: true });
      void first.then((v) => {
        firstSettled = v;
      });
      await waitForWorker(INPUT.seed);
      second = hook!.runToCompletion({ ...INPUT, seed: 333 }, { force: true });
      const completed = second;
      await waitForWorker(333);
      flushWorkerDelivery(333);
      await completed;
    });
    await expect(first!).resolves.toBeNull();
    expect(firstSettled).toBeNull();
  });

  it('a forced run after a hit returns the freshly-sampled result, not the cached one', async () => {
    renderProvider();
    await act(async () => {
      await hook!.run(INPUT);
    });
    await waitFor(() => expect(hook!.result?.seed).toBe(111));

    await act(async () => {
      await hook!.run({ ...INPUT, seed: 999 }, { force: true });
    });
    await waitFor(() => expect(hook!.result?.seed).toBe(999));
    await act(async () => {
      await hook!.run(INPUT);
    });
    await waitFor(() => expect(hook!.status).toBe('done'));
    expect(hook!.result?.seed).toBe(999);
  });
});
