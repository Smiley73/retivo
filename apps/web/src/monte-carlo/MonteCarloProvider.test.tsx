/**
 * MonteCarloProvider — cache-first run, the forced-run (`{ force: true }`)
 * cache bypass + overwrite, and progress threading.
 *
 * The `?worker` import is mocked with a fake Worker-like class that, on
 * each `{ kind: 'run' }` message, posts a deterministic `result` back via
 * the provider's `onmessage` handler. A module-level run counter records
 * every worker spawn so the tests can assert the cache short-circuit
 * (no spawn on a hit) vs. the forced bypass (spawn even on a hit).
 */
import 'fake-indexeddb/auto';
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';
import { clearMonteCarloCache, monteCarloCacheCount } from '../db/monte-carlo-cache';
import { fakeSummary } from './fake-worker.test-harness';

// Records every worker spawn + the seed of each run so tests can assert
// the cache short-circuit vs. the forced bypass.
let workerRuns: Array<{ seed: number }> = [];
// Delivery mode for the fake worker. In the default (auto) mode each worker
// posts its result back on a microtask right after `run`, so the existing
// cache/progress tests need not orchestrate delivery. The pre-empt tests flip
// to MANUAL mode: a worker records its run but posts nothing until the test
// explicitly drives it via `flushWorkerDelivery`. Manual mode is what makes
// the pre-empt tests deterministic under parallel load — the first worker is
// simply never told to deliver, so the only way its `runToCompletion`
// settles is the provider's cancel-to-null path, with zero scheduling race.
let manualWorkerDelivery = false;
// Every fake worker spawned this test, keyed by the run's seed, with a bound
// deliver() closure so a manual-mode test can release a specific run's result.
// Keying by seed (not spawn index) is deliberate: two concurrent runs each
// `await` a genuinely-async cache-key hash before spawning, and those hashes
// can complete out of call order under load — so spawn order is NOT a reliable
// identifier, but the seed is.
let liveWorkers: Array<{ seed: number; deliver: () => void }> = [];

/** Manually post the recorded result for the run with the given seed. No-op
 *  if that worker was terminated (mirrors real `Worker.terminate()`). */
function flushWorkerDelivery(seed: number): void {
  liveWorkers.find((w) => w.seed === seed)?.deliver();
}

/** Resolve once the run with the given seed has spawned its worker. A run
 *  `await`s a genuinely-async cache-key hash before spawning, so we yield to
 *  the full event loop (macrotask) each iteration; bounded so a missed spawn
 *  fails fast rather than hanging the suite. */
async function waitForWorker(seed: number): Promise<void> {
  for (let i = 0; i < 1000 && !liveWorkers.some((w) => w.seed === seed); i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

vi.mock('../workers/monte-carlo.worker?worker', () => {
  class FakeMcWorker {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: { message?: string }) => void) | null = null;
    // Models real `Worker.terminate()` semantics: a terminated worker delivers
    // NO further messages. A pre-empted worker is terminated by the provider,
    // so even a queued/auto delivery is suppressed and nothing escapes the
    // test's act/cleanup boundary into a neighbour file under parallel runs.
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
      // Auto mode: post the result on a microtask (synchronously-ish), as
      // before. Manual mode: stay silent until the test calls
      // `flushWorkerDelivery`.
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

// Test harness: exposes the hook value to the enclosing test via a ref.
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
    // First run: cache miss → worker spawns once.
    await act(async () => {
      await hook!.run(INPUT);
    });
    await waitFor(() => expect(hook!.status).toBe('done'));
    expect(workerRuns).toHaveLength(1);
    expect(hook!.result?.seed).toBe(111);
    await waitFor(async () => expect(await monteCarloCacheCount()).toBe(1));

    // Second identical run: cache hit → NO new worker spawn.
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
    // Seed the cache with the deterministic auto-run.
    await act(async () => {
      await hook!.run(INPUT);
    });
    await waitFor(() => expect(hook!.status).toBe('done'));
    expect(workerRuns).toHaveLength(1);
    await waitFor(async () => expect(await monteCarloCacheCount()).toBe(1));

    // Forced run with a DIFFERENT seed: must spawn the worker again
    // (cache bypassed) and overwrite the canonical entry — the cache key
    // excludes the seed, so the count stays at 1.
    await act(async () => {
      await hook!.run({ ...INPUT, seed: 222 }, { force: true });
    });
    await waitFor(() => expect(hook!.result?.seed).toBe(222));
    expect(workerRuns).toHaveLength(2);
    expect(workerRuns[1].seed).toBe(222);
    // Overwrite (same key, seed excluded) → still a single cache entry.
    await waitFor(async () => expect(await monteCarloCacheCount()).toBe(1));
  });

  it('runToCompletion resolves with the summary only AFTER the worker finishes, and writes the cache', async () => {
    renderProvider();
    let resolved: { seed: number } | null = null;
    await act(async () => {
      const summary = await hook!.runToCompletion(INPUT, { force: true });
      resolved = summary;
    });
    // The promise resolves with the worker's summary (not before).
    expect(resolved).not.toBeNull();
    expect(resolved!.seed).toBe(INPUT.seed);
    expect(workerRuns).toHaveLength(1);
    // The summary was written through to the cache (a later non-forced run
    // serves it without a new spawn).
    await waitFor(async () => expect(await monteCarloCacheCount()).toBe(1));
    await act(async () => {
      await hook!.run(INPUT);
    });
    expect(workerRuns).toHaveLength(1);
  });

  it('runToCompletion serves a cached hit without spawning a worker', async () => {
    renderProvider();
    // Seed the cache via a completed run.
    await act(async () => {
      await hook!.runToCompletion(INPUT, { force: true });
    });
    expect(workerRuns).toHaveLength(1);
    // A non-forced runToCompletion now hits the cache → no new spawn.
    let hit: { seed: number } | null = null;
    await act(async () => {
      hit = await hook!.runToCompletion(INPUT);
    });
    expect(hit).not.toBeNull();
    expect(workerRuns).toHaveLength(1);
  });

  // The two pre-empt tests below run the fake worker in MANUAL-delivery mode
  // (set via `manualWorkerDelivery`): the pre-empted (first) worker is never
  // told to deliver, so the ONLY way its `runToCompletion` promise settles is
  // the provider's cancel-to-null path. This removes every scheduling race —
  // there is no auto-delivery to out-run, so the result is deterministic under
  // parallel load (a microtask/timer delivery could otherwise complete the
  // first run with a summary before the pre-empt sweep fired). We still assert
  // the FIRST promise resolves `null`; that behaviour comes from the provider
  // `pendingCancelRef` fix, independent of worker delivery.
  it('settles a pending runToCompletion to null when a new run() pre-empts it', async () => {
    manualWorkerDelivery = true;
    renderProvider();
    // Kick a forced runToCompletion (cache bypassed → worker spawns) but do
    // NOT await it; capture its promise so we can assert it settles. Its
    // worker is never released, so it can only settle via pre-emption.
    let pending: Promise<MonteCarloSummary | null> | null = null;
    let settled: MonteCarloSummary | null | 'pending' = 'pending';
    await act(async () => {
      pending = hook!.runToCompletion(INPUT, { force: true });
      void pending.then((v) => {
        settled = v;
      });
      // Wait until the first run is genuinely in-flight (its worker spawned →
      // its cancel-resolver installed) before pre-empting. This mirrors real
      // pre-emption (a new run arrives while one is running) and removes the
      // artifact where the two runs' async cache-key hashes complete out of
      // order, letting the pre-empt sweep run before the first resolver exists.
      await waitForWorker(INPUT.seed);
      // Pre-empt with a fresh run before the first worker posts its result.
      // The first awaiter must resolve `null` rather than hang forever.
      await hook!.run({ ...INPUT, seed: 222 }, { force: true });
    });
    // The pre-empted runToCompletion resolved `null` (did not hang, did not
    // resolve the first worker's summary).
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
      // Wait until the first run is genuinely in-flight (worker spawned →
      // cancel-resolver installed) before pre-empting, so the second call's
      // pre-empt sweep is guaranteed to find the first resolver (avoids the
      // out-of-order cache-key-hash artifact).
      await waitForWorker(INPUT.seed);
      // A second runToCompletion pre-empts the first before its worker posts a
      // result; the first awaiter must resolve `null`. Kick it without awaiting
      // (manual mode → it would otherwise hang), wait until its worker spawns
      // (by which point the pre-empt sweep has already settled the first
      // promise to null), then release the second run BY SEED so it completes
      // and act() settles. The first run's worker (seed 111) is never released.
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
    // A subsequent non-forced identical run now serves the OVERWRITTEN
    // (seed 999) result from cache — proving the forced run persisted.
    await act(async () => {
      await hook!.run(INPUT);
    });
    await waitFor(() => expect(hook!.status).toBe('done'));
    expect(hook!.result?.seed).toBe(999);
  });
});
