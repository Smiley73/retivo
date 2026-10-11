/**
 * MonteCarloProvider — a preflight that REJECTS while an older run is in
 * flight.
 *
 * Both entry points claim their generation synchronously, before they hash the
 * cache key and read IndexedDB — which means the moment a new request is made
 * the OLDER run's terminal result is already suppressed as superseded, even
 * though the new request has not pre-empted it yet. If that new request's
 * preflight then rejects (no `crypto.subtle` in an insecure context, an
 * IndexedDB read failure) and the rejection just propagates, the shared
 * provider wedges: the older worker keeps computing into nothing, no run in
 * flight may publish, and every consumer of this context stays on `running`
 * with no error to retry from.
 *
 * The rule: a CURRENT preflight failure tears the older run down, clears
 * progress and publishes `error`; a SUPERSEDED one stays silent and reports
 * `null`. Both older-run shapes are covered — the single worker and the
 * sharded pool.
 */
import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonteCarloInput } from '../lib/monte-carlo';

interface Gate {
  resolve: () => void;
  reject: (e: unknown) => void;
}

const h = vi.hoisted(() => ({
  /** seed → gate for that request's still-pending cache-key hash. */
  keyGates: new Map<number, Gate>(),
  /** cache key → gate for that request's still-pending cache read. */
  readGates: new Map<string, Gate>(),
  /** Every fake worker built this test (single-worker AND pool shards). */
  workers: [] as Array<{ terminated: boolean }>,
  /** `kind` of every message posted to a fake worker. */
  posted: [] as string[],
}));

// The cache module is mocked so the TEST decides when — and how — each
// request's preflight settles. Nothing here touches IndexedDB.
vi.mock('../db/monte-carlo-cache', () => ({
  mcCacheKey: (input: MonteCarloInput) =>
    new Promise<string>((resolve, reject) => {
      h.keyGates.set(input.seed, {
        resolve: () => resolve(`key-${input.seed}`),
        reject,
      });
    }),
  getCached: (key: string) =>
    new Promise<null>((resolve, reject) => {
      h.readGates.set(key, { resolve: () => resolve(null), reject });
    }),
  putCached: async () => undefined,
}));

// Supports BOTH worker protocols (single-worker `onmessage`, pool
// `addEventListener`) and never replies: every run in this file settles only
// through the provider's own supersede / teardown paths.
vi.mock('../workers/monte-carlo.worker?worker', async () =>
  (await import('./fake-worker.test-harness')).neverRepliesWorkerModule(h),
);

import { MonteCarloProvider, useMonteCarlo } from './MonteCarloProvider';
import { smallInput, largeInput, setCores, settle } from './fake-worker.test-harness';

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

/** Poll until a gate for this seed/key exists, bounded so a missed preflight
 *  fails fast rather than hanging the suite. */
async function waitForKeyGate(seed: number): Promise<Gate> {
  for (let i = 0; i < 200 && !h.keyGates.has(seed); i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  const gate = h.keyGates.get(seed);
  if (!gate) throw new Error(`no cache-key gate for seed ${seed}`);
  return gate;
}
async function waitForReadGate(seed: number): Promise<Gate> {
  const key = `key-${seed}`;
  for (let i = 0; i < 200 && !h.readGates.has(key); i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  const gate = h.readGates.get(key);
  if (!gate) throw new Error(`no cache-read gate for ${key}`);
  return gate;
}

/** Kick a forced run and drive it past its preflight so its worker(s) exist. */
async function startInFlightRun(input: MonteCarloInput): Promise<{ pending: Promise<unknown> }> {
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = hook!.runToCompletion(input, { force: true });
    const gate = await waitForKeyGate(input.seed);
    gate.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  });
  return { pending };
}

beforeEach(() => {
  h.keyGates.clear();
  h.readGates.clear();
  h.workers.length = 0;
  h.posted.length = 0;
  hook = null;
});

describe.each([
  {
    branch: 'single-worker',
    cores: 1,
    older: smallInput,
    postedKind: 'run',
  },
  {
    branch: 'sharded',
    cores: 4,
    older: largeInput,
    postedKind: 'runShard',
  },
])('MonteCarloProvider — preflight rejection over an older $branch run', (c) => {
  it('a rejected cache-key hash resets the older run and publishes the error', async () => {
    setCores(c.cores);
    renderProvider();

    const { pending: older } = await startInFlightRun(c.older(111));
    expect(h.posted).toContain(c.postedKind);
    const olderWorkers = [...h.workers];
    expect(olderWorkers.length).toBeGreaterThan(0);
    expect(hook!.status).toBe('running');

    // A newer request arrives (its generation now suppresses the older run's
    // result) and its cache-key hash fails.
    let newer!: Promise<unknown>;
    let rejection: unknown = null;
    await act(async () => {
      newer = hook!.runToCompletion(smallInput(222), { force: true });
      void newer.catch((e: unknown) => {
        rejection = e;
      });
      const gate = await waitForKeyGate(222);
      gate.reject(new Error('cache key unavailable'));
      await new Promise<void>((r) => setTimeout(r, 0));
    });

    expect(hook!.status).toBe('error');
    expect(hook!.error).toBe('cache key unavailable');
    expect(hook!.progressDone).toBe(0);
    expect(hook!.progressTotal).toBe(0);
    // The suppressed older run was torn down, not left computing.
    expect(olderWorkers.every((w) => w.terminated)).toBe(true);
    await expect(older).resolves.toBeNull();
    expect((rejection as Error | null)?.message).toBe('cache key unavailable');
  });

  it('a rejected cache read resets the older run and publishes the error', async () => {
    setCores(c.cores);
    renderProvider();

    const { pending: older } = await startInFlightRun(c.older(111));
    const olderWorkers = [...h.workers];
    expect(olderWorkers.length).toBeGreaterThan(0);
    expect(hook!.status).toBe('running');

    // Newer request, NOT forced — so it reaches the cache read, which fails.
    let newer!: Promise<unknown>;
    let rejection: unknown = null;
    await act(async () => {
      newer = hook!.runToCompletion(smallInput(222));
      void newer.catch((e: unknown) => {
        rejection = e;
      });
      (await waitForKeyGate(222)).resolve();
      const read = await waitForReadGate(222);
      read.reject(new Error('cache read failed'));
      await new Promise<void>((r) => setTimeout(r, 0));
    });

    expect(hook!.status).toBe('error');
    expect(hook!.error).toBe('cache read failed');
    expect(hook!.progressDone).toBe(0);
    expect(hook!.progressTotal).toBe(0);
    expect(olderWorkers.every((w) => w.terminated)).toBe(true);
    await expect(older).resolves.toBeNull();
    expect((rejection as Error | null)?.message).toBe('cache read failed');
  });
});

describe('MonteCarloProvider — preflight rejection on a SUPERSEDED request', () => {
  it('stays silent and resolves null rather than killing the newer run', async () => {
    setCores(1);
    renderProvider();

    // Older request parked in its cache-key hash; a newer one overtakes it and
    // reaches its worker. The older preflight then fails.
    let older!: Promise<unknown>;
    await act(async () => {
      older = hook!.runToCompletion(smallInput(111), { force: true });
      await waitForKeyGate(111);
    });
    const { pending: newer } = await startInFlightRun(smallInput(222));
    const newerWorkers = [...h.workers];
    expect(newerWorkers).toHaveLength(1);

    await act(async () => {
      h.keyGates.get(111)!.reject(new Error('cache key unavailable'));
      await new Promise<void>((r) => setTimeout(r, 0));
    });

    // Nobody was waiting on that failure: the newer run keeps the shared state.
    expect(hook!.status).toBe('running');
    expect(hook!.error).toBeNull();
    expect(newerWorkers[0].terminated).toBe(false);
    await expect(older).resolves.toBeNull();

    act(() => hook!.cancel());
    await expect(newer).resolves.toBeNull();
  });
});

describe('MonteCarloProvider — resultless run() preflight rejection', () => {
  it('publishes the error and resolves (never rejects) when it is current', async () => {
    setCores(1);
    renderProvider();

    const { pending: older } = await startInFlightRun(smallInput(111));
    const olderWorkers = [...h.workers];

    let resolved = false;
    await act(async () => {
      void hook!.run(smallInput(222), { force: true }).then(() => {
        resolved = true;
      });
      (await waitForKeyGate(222)).reject(new Error('cache key unavailable'));
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    await settle();

    expect(resolved).toBe(true);
    expect(hook!.status).toBe('error');
    expect(hook!.error).toBe('cache key unavailable');
    expect(hook!.progressTotal).toBe(0);
    expect(olderWorkers.every((w) => w.terminated)).toBe(true);
    await expect(older).resolves.toBeNull();
  });
});
