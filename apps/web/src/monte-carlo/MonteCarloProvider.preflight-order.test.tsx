/**
 * MonteCarloProvider — preflight ordering: only the NEWEST request may pre-empt
 * a run or publish into the shared result / status.
 *
 * `run` and `runToCompletion` both hash a cache key and read IndexedDB BEFORE
 * they tear down the previous run, and nothing stops a second request being
 * kicked while the first is still in that preflight (the page's "Recalculate"
 * button stays enabled throughout). Two preflights can therefore finish out of
 * call order — the other provider suites note this as the reason they key their
 * fake workers by SEED rather than spawn order, but none of them exercises it.
 *
 * This file does: it holds the cache-key hash open per request and releases the
 * two in REVERSE order. Without the generation guard the older request wins the
 * race — it terminates the newer run's worker, spawns its own, and publishes its
 * summary as the shared `result`. A caller carrying its own request identity
 * (`usePlanStressTestVm`) then rejects that completion, so the page is left
 * holding a result nobody asked for with no run in flight to replace it.
 */
import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';

const h = vi.hoisted(() => ({
  /** seed → resolver for that request's still-pending cache-key hash. */
  keyGates: new Map<number, () => void>(),
  /** Cache entries staged by the test, keyed like the mocked `mcCacheKey`. */
  cached: new Map<string, unknown>(),
  /** Fake workers spawned this test, in spawn order, tagged with the run seed. */
  workers: [] as Array<{ seed: number; isTerminated: () => boolean; deliver: () => void }>,
}));

// The cache module is mocked so the test — not IndexedDB timing — decides when
// each request's preflight completes. `mcCacheKey` stays pending until the test
// releases it BY SEED, which is what makes the reversed ordering deterministic.
vi.mock('../db/monte-carlo-cache', () => ({
  mcCacheKey: (input: MonteCarloInput) =>
    new Promise<string>((resolve) => {
      h.keyGates.set(input.seed, () => resolve(`key-${input.seed}`));
    }),
  getCached: async (key: string) => h.cached.get(key) ?? null,
  putCached: async () => undefined,
}));

vi.mock('../workers/monte-carlo.worker?worker', () => {
  class FakeMcWorker {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: { message?: string }) => void) | null = null;
    // Models real `Worker.terminate()`: a terminated worker delivers nothing.
    terminated = false;
    postMessage(msg: unknown): void {
      const m = msg as { kind: string; input: MonteCarloInput };
      if (m.kind !== 'run') return;
      const seed = m.input.seed;
      h.workers.push({
        seed,
        isTerminated: () => this.terminated,
        // Manual delivery: a worker posts its result only when the test says so.
        deliver: () => {
          if (this.terminated) return;
          this.onmessage?.(
            new MessageEvent('message', {
              data: { kind: 'result', summary: fakeSummary(seed) },
            }),
          );
        },
      });
    }
    terminate(): void {
      this.terminated = true;
    }
  }
  return { default: FakeMcWorker };
});

import { MonteCarloProvider, useMonteCarlo } from './MonteCarloProvider';
import { fakeSummary } from './fake-worker.test-harness';

/** Well under `SHARD_MIN_PATHS`, so both requests take the single-worker path. */
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

const withSeed = (seed: number): MonteCarloInput => ({ ...INPUT, seed });

let hook: ReturnType<typeof useMonteCarlo> | null = null;
function Probe(): null {
  hook = useMonteCarlo();
  return null;
}

/** Release the request with this seed from its cache-key hash and let every
 *  follow-on microtask (cache read, worker spawn) run. */
async function releasePreflight(seed: number): Promise<void> {
  await act(async () => {
    h.keyGates.get(seed)?.();
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

const spawnedSeeds = (): number[] => h.workers.map((w) => w.seed);

beforeEach(() => {
  h.keyGates.clear();
  h.cached.clear();
  h.workers.length = 0;
  hook = null;
});

describe('MonteCarloProvider — reversed preflight completion order', () => {
  it('a request whose preflight finishes LAST neither pre-empts the newer run nor publishes its own result', async () => {
    render(
      <MonteCarloProvider>
        <Probe />
      </MonteCarloProvider>,
    );

    // Two forced requests in flight, both still hashing their cache key.
    let older!: Promise<MonteCarloSummary | null>;
    let newer!: Promise<MonteCarloSummary | null>;
    await act(async () => {
      older = hook!.runToCompletion(withSeed(111), { force: true });
      newer = hook!.runToCompletion(withSeed(222), { force: true });
    });
    expect(spawnedSeeds()).toEqual([]);

    // The NEWER request's preflight finishes first, so it owns the run.
    await releasePreflight(222);
    expect(spawnedSeeds()).toEqual([222]);
    expect(hook!.status).toBe('running');

    // The older request's preflight finishes second. It must bow out: no worker
    // of its own, and the newer run's worker left alive.
    await releasePreflight(111);
    expect(spawnedSeeds()).toEqual([222]);
    expect(h.workers[0].isTerminated()).toBe(false);
    await expect(older).resolves.toBeNull();

    // The newest run is still the one that publishes.
    await act(async () => {
      h.workers[0].deliver();
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    expect(hook!.result?.seed).toBe(222);
    expect(hook!.status).toBe('done');
    await expect(newer).resolves.toMatchObject({ seed: 222 });
  });

  it('a late preflight that ends in a cache HIT does not publish over the newer run', async () => {
    // The older request will hit the cache; the newer one misses and computes.
    h.cached.set('key-111', fakeSummary(111));
    render(
      <MonteCarloProvider>
        <Probe />
      </MonteCarloProvider>,
    );

    let older!: Promise<MonteCarloSummary | null>;
    let newer!: Promise<MonteCarloSummary | null>;
    await act(async () => {
      older = hook!.runToCompletion(withSeed(111));
      newer = hook!.runToCompletion(withSeed(222));
    });

    await releasePreflight(222);
    expect(spawnedSeeds()).toEqual([222]);

    // A cache hit is the cheapest way for a superseded request to publish: it
    // never even reaches the pre-empt sweep, it just writes `result` + 'done'
    // over a run that is still computing.
    await releasePreflight(111);
    expect(hook!.result).toBeNull();
    expect(hook!.status).toBe('running');
    await expect(older).resolves.toBeNull();

    await act(async () => {
      h.workers[0].deliver();
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    expect(hook!.result?.seed).toBe(222);
    await expect(newer).resolves.toMatchObject({ seed: 222 });
  });

  it('resultless run() follows the same rule — an older preflight cannot take over', async () => {
    render(
      <MonteCarloProvider>
        <Probe />
      </MonteCarloProvider>,
    );

    await act(async () => {
      void hook!.run(withSeed(111), { force: true });
      void hook!.run(withSeed(222), { force: true });
    });

    await releasePreflight(222);
    expect(spawnedSeeds()).toEqual([222]);

    await releasePreflight(111);
    expect(spawnedSeeds()).toEqual([222]);
    expect(h.workers[0].isTerminated()).toBe(false);

    await act(async () => {
      h.workers[0].deliver();
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    expect(hook!.result?.seed).toBe(222);
  });
});
