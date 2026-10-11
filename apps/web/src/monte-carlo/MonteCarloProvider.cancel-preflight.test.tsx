/**
 * MonteCarloProvider — Cancel and unmount must reach a request that is still
 * inside its PREFLIGHT.
 *
 * Both entry points hash a cache key and read IndexedDB before they create
 * anything. `cancel()` / the unmount cleanup tear down what EXISTS — a worker,
 * a sharded pool, an awaiting `runToCompletion` — and a request parked in that
 * preflight owns none of those. Without retiring the request generation it
 * therefore survives the teardown, wakes up still holding the newest
 * generation, and spawns its worker: the run the user just cancelled starts
 * AFTER the Cancel, or a run leaks past the provider's unmount.
 *
 * These tests hold each preflight stage open, fire the teardown, then release
 * the stage and assert that nothing was created (neither the single worker nor
 * a pool worker) and that the awaiter settled `null`.
 */
import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';

const h = vi.hoisted(() => ({
  /** seed → resolver for that request's still-pending cache-key hash. */
  keyGates: new Map<number, () => void>(),
  /** cache key → resolver for that request's still-pending cache read. */
  readGates: new Map<string, (v: unknown) => void>(),
  /** Entries the test stages for a cache HIT, keyed like the mocked key. */
  cached: new Map<string, unknown>(),
  /** EVERY worker built this test — the single-worker path and pool shards
   *  alike, counted at CONSTRUCTION so "no pool was created" is observable. */
  workers: [] as Array<{ terminated: boolean }>,
}));

// The cache module is mocked so the TEST decides when each preflight stage
// completes. Nothing here touches IndexedDB.
vi.mock('../db/monte-carlo-cache', () => ({
  mcCacheKey: (input: MonteCarloInput) =>
    new Promise<string>((resolve) => {
      h.keyGates.set(input.seed, () => resolve(`key-${input.seed}`));
    }),
  getCached: (key: string) =>
    new Promise<unknown>((resolve) => {
      h.readGates.set(key, () => resolve(h.cached.get(key) ?? null));
    }),
  putCached: async () => undefined,
}));

// Supports BOTH worker protocols (single-worker `onmessage`, pool
// `addEventListener`) and never replies: a run in this file settles only
// through the provider's own teardown paths.
vi.mock('../workers/monte-carlo.worker?worker', async () =>
  (await import('./fake-worker.test-harness')).neverRepliesWorkerModule(h),
);

import { MonteCarloProvider, useMonteCarlo } from './MonteCarloProvider';
import { smallInput, largeInput, setCores, fakeSummary, settle } from './fake-worker.test-harness';

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

/** Poll until the request's cache-key gate exists, bounded so a missed
 *  preflight fails fast rather than hanging the suite. */
async function waitForKeyGate(seed: number): Promise<() => void> {
  for (let i = 0; i < 200 && !h.keyGates.has(seed); i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  const gate = h.keyGates.get(seed);
  if (!gate) throw new Error(`no cache-key gate for seed ${seed}`);
  return gate;
}
async function waitForReadGate(seed: number): Promise<(v: unknown) => void> {
  const key = `key-${seed}`;
  for (let i = 0; i < 200 && !h.readGates.has(key); i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  const gate = h.readGates.get(key);
  if (!gate) throw new Error(`no cache-read gate for ${key}`);
  return gate;
}

beforeEach(() => {
  h.keyGates.clear();
  h.readGates.clear();
  h.cached.clear();
  h.workers.length = 0;
  hook = null;
});

describe.each([
  { branch: 'single-worker', cores: 1, input: smallInput },
  { branch: 'sharded', cores: 4, input: largeInput },
])('MonteCarloProvider — cancel() during the preflight of a $branch run', (c) => {
  it('a request parked in its cache-key hash spawns nothing after Cancel and settles null', async () => {
    setCores(c.cores);
    renderProvider();

    let pending!: Promise<MonteCarloSummary | null>;
    await act(async () => {
      pending = hook!.runToCompletion(c.input(111), { force: true });
      await waitForKeyGate(111);
    });
    expect(h.workers).toHaveLength(0);

    act(() => hook!.cancel());
    expect(hook!.status).toBe('cancelled');

    // The hash completes AFTER the Cancel. It must bow out, not start the run
    // the user just stopped.
    await act(async () => {
      h.keyGates.get(111)!();
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    await settle();

    expect(h.workers).toHaveLength(0);
    expect(hook!.status).toBe('cancelled');
    expect(hook!.result).toBeNull();
    await expect(pending).resolves.toBeNull();
  });

  it('a request parked in its cache read spawns nothing after Cancel and settles null', async () => {
    setCores(c.cores);
    renderProvider();

    // NOT forced, so the request reaches the cache read and parks there.
    let pending!: Promise<MonteCarloSummary | null>;
    await act(async () => {
      pending = hook!.runToCompletion(c.input(111));
      (await waitForKeyGate(111))();
      await waitForReadGate(111);
    });
    expect(h.workers).toHaveLength(0);

    act(() => hook!.cancel());

    await act(async () => {
      h.readGates.get('key-111')!(null);
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    await settle();

    expect(h.workers).toHaveLength(0);
    expect(hook!.status).toBe('cancelled');
    await expect(pending).resolves.toBeNull();
  });
});

describe('MonteCarloProvider — unmount during a preflight', () => {
  it('a request parked in its cache-key hash spawns no worker after teardown', async () => {
    setCores(1);
    const view = renderProvider();

    let pending!: Promise<MonteCarloSummary | null>;
    await act(async () => {
      pending = hook!.runToCompletion(smallInput(111), { force: true });
      await waitForKeyGate(111);
    });

    view.unmount();

    await act(async () => {
      h.keyGates.get(111)!();
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    await settle();

    expect(h.workers).toHaveLength(0);
    await expect(pending).resolves.toBeNull();
  });

  it('a request parked in its cache read spawns no pool worker after teardown', async () => {
    setCores(4);
    const view = renderProvider();

    let pending!: Promise<MonteCarloSummary | null>;
    await act(async () => {
      pending = hook!.runToCompletion(largeInput(111));
      (await waitForKeyGate(111))();
      await waitForReadGate(111);
    });

    view.unmount();

    await act(async () => {
      h.readGates.get('key-111')!(null);
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    await settle();

    expect(h.workers).toHaveLength(0);
    await expect(pending).resolves.toBeNull();
  });
});

describe('MonteCarloProvider — a late preflight cannot undo a Cancel', () => {
  it('a cache HIT that lands after Cancel does not publish "done" over "cancelled"', async () => {
    // The cheapest way for a cancelled request to come back to life: it never
    // reaches the pre-empt sweep, it just writes `result` + 'done'.
    setCores(1);
    h.cached.set('key-111', fakeSummary(111));
    renderProvider();

    let pending!: Promise<MonteCarloSummary | null>;
    await act(async () => {
      pending = hook!.runToCompletion(smallInput(111));
      (await waitForKeyGate(111))();
      await waitForReadGate(111);
    });

    act(() => hook!.cancel());

    await act(async () => {
      h.readGates.get('key-111')!(fakeSummary(111));
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    await settle();

    expect(hook!.status).toBe('cancelled');
    expect(hook!.result).toBeNull();
    await expect(pending).resolves.toBeNull();
  });

  it('the resultless run() follows the same rule', async () => {
    setCores(1);
    renderProvider();

    let resolved = false;
    await act(async () => {
      void hook!.run(smallInput(111), { force: true }).then(() => {
        resolved = true;
      });
      await waitForKeyGate(111);
    });

    act(() => hook!.cancel());

    await act(async () => {
      h.keyGates.get(111)!();
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    await settle();

    expect(resolved).toBe(true);
    expect(h.workers).toHaveLength(0);
    expect(hook!.status).toBe('cancelled');
  });

  it('a run kicked AFTER the Cancel still starts normally', async () => {
    // The generation bump must invalidate the requests in flight, not wedge the
    // provider against every future one.
    setCores(1);
    renderProvider();

    act(() => hook!.cancel());

    await act(async () => {
      void hook!.runToCompletion(smallInput(222), { force: true });
      (await waitForKeyGate(222))();
      await new Promise<void>((r) => setTimeout(r, 0));
    });

    expect(h.workers).toHaveLength(1);
    expect(hook!.status).toBe('running');
  });
});
