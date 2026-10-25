// `run` and `runToCompletion` hash a cache key and read IndexedDB before they tear down the previous run, and a second
// request can start while the first is still in that preflight; the mocks hold each stage open until a test settles it.
import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';

const h = vi.hoisted(() => ({
  keyGates: new Map<number, { resolve: () => void; reject: (e: unknown) => void }>(),
  readGates: new Map<string, { resolve: () => void; reject: (e: unknown) => void }>(),
  cached: new Map<string, unknown>(),
  workers: [] as Array<{ terminated: boolean; seed?: number; deliver(): void }>,
  posted: [] as string[],
}));

vi.mock('../db/monte-carlo-cache', async () =>
  (await import('./fake-worker.test-harness')).gatedCacheModule(h),
);
vi.mock('../workers/monte-carlo.worker?worker', async () =>
  (await import('./fake-worker.test-harness')).neverRepliesWorkerModule(h),
);

import { MonteCarloProvider, useMonteCarlo } from './MonteCarloProvider';
import {
  fakeSummary,
  largeInput,
  setCores,
  settle,
  smallInput,
  waitForKeyGate,
  waitForReadGate,
} from './fake-worker.test-harness';

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

const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));
const spawnedSeeds = (): Array<number | undefined> => h.workers.map((w) => w.seed);

/** Releases the request's cache-key hash and, when it reaches one, its cache read. */
async function releasePreflight(seed: number): Promise<void> {
  await act(async () => {
    h.keyGates.get(seed)?.resolve();
    await tick();
    h.readGates.get(`key-${seed}`)?.resolve();
    await tick();
  });
}

/** Kicks a forced run and drives it past its preflight so its worker(s) exist. */
async function startInFlightRun(input: MonteCarloInput): Promise<{ pending: Promise<unknown> }> {
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = hook!.runToCompletion(input, { force: true });
    (await waitForKeyGate(h, input.seed)).resolve();
    await tick();
  });
  return { pending };
}

beforeEach(() => {
  h.keyGates.clear();
  h.readGates.clear();
  h.cached.clear();
  h.workers.length = 0;
  h.posted.length = 0;
  hook = null;
});

// Only the newest request may pre-empt a run or publish into the shared result and status.
describe('MonteCarloProvider — preflight ordering', () => {
  it('a request whose preflight finishes LAST neither pre-empts the newer run nor publishes its own result', async () => {
    renderProvider();

    let older!: Promise<MonteCarloSummary | null>;
    let newer!: Promise<MonteCarloSummary | null>;
    await act(async () => {
      older = hook!.runToCompletion(smallInput(111), { force: true });
      newer = hook!.runToCompletion(smallInput(222), { force: true });
    });
    expect(spawnedSeeds()).toEqual([]);

    await releasePreflight(222);
    expect(spawnedSeeds()).toEqual([222]);
    expect(hook!.status).toBe('running');

    await releasePreflight(111);
    expect(spawnedSeeds()).toEqual([222]);
    expect(h.workers[0].terminated).toBe(false);
    await expect(older).resolves.toBeNull();

    await act(async () => {
      h.workers[0].deliver();
      await tick();
    });
    expect(hook!.result?.seed).toBe(222);
    expect(hook!.status).toBe('done');
    await expect(newer).resolves.toMatchObject({ seed: 222 });
  });

  it('a late preflight that ends in a cache HIT does not publish over the newer run', async () => {
    h.cached.set('key-111', fakeSummary(111));
    renderProvider();

    let older!: Promise<MonteCarloSummary | null>;
    let newer!: Promise<MonteCarloSummary | null>;
    await act(async () => {
      older = hook!.runToCompletion(smallInput(111));
      newer = hook!.runToCompletion(smallInput(222));
    });

    await releasePreflight(222);
    expect(spawnedSeeds()).toEqual([222]);

    // A cache hit skips the pre-empt sweep and writes `result` + 'done' straight over the newer run.
    await releasePreflight(111);
    expect(hook!.result).toBeNull();
    expect(hook!.status).toBe('running');
    await expect(older).resolves.toBeNull();

    await act(async () => {
      h.workers[0].deliver();
      await tick();
    });
    expect(hook!.result?.seed).toBe(222);
    await expect(newer).resolves.toMatchObject({ seed: 222 });
  });

  it('resultless run() follows the same rule — an older preflight cannot take over', async () => {
    renderProvider();

    await act(async () => {
      void hook!.run(smallInput(111), { force: true });
      void hook!.run(smallInput(222), { force: true });
    });

    await releasePreflight(222);
    expect(spawnedSeeds()).toEqual([222]);

    await releasePreflight(111);
    expect(spawnedSeeds()).toEqual([222]);
    expect(h.workers[0].terminated).toBe(false);

    await act(async () => {
      h.workers[0].deliver();
      await tick();
    });
    expect(hook!.result?.seed).toBe(222);
  });
});

// A current preflight failure tears the older run down and publishes `error`; a superseded one stays silent.
describe.each([
  { branch: 'single-worker', cores: 1, older: smallInput, postedKind: 'run' },
  { branch: 'sharded', cores: 4, older: largeInput, postedKind: 'runShard' },
])('MonteCarloProvider — preflight rejection over an older $branch run', (c) => {
  it('a rejected cache-key hash resets the older run and publishes the error', async () => {
    setCores(c.cores);
    renderProvider();

    const { pending: older } = await startInFlightRun(c.older(111));
    expect(h.posted).toContain(c.postedKind);
    const olderWorkers = [...h.workers];
    expect(olderWorkers.length).toBeGreaterThan(0);
    expect(hook!.status).toBe('running');

    let rejection: unknown = null;
    await act(async () => {
      void hook!.runToCompletion(smallInput(222), { force: true }).catch((e: unknown) => {
        rejection = e;
      });
      (await waitForKeyGate(h, 222)).reject(new Error('cache key unavailable'));
      await tick();
    });

    expect(hook!.status).toBe('error');
    expect(hook!.error).toBe('cache key unavailable');
    expect(hook!.progressDone).toBe(0);
    expect(hook!.progressTotal).toBe(0);
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

    // Not forced, so the newer request reaches the cache read, which fails.
    let rejection: unknown = null;
    await act(async () => {
      void hook!.runToCompletion(smallInput(222)).catch((e: unknown) => {
        rejection = e;
      });
      (await waitForKeyGate(h, 222)).resolve();
      (await waitForReadGate(h, 222)).reject(new Error('cache read failed'));
      await tick();
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

    let older!: Promise<unknown>;
    await act(async () => {
      older = hook!.runToCompletion(smallInput(111), { force: true });
      await waitForKeyGate(h, 111);
    });
    const { pending: newer } = await startInFlightRun(smallInput(222));
    const newerWorkers = [...h.workers];
    expect(newerWorkers).toHaveLength(1);

    await act(async () => {
      h.keyGates.get(111)!.reject(new Error('cache key unavailable'));
      await tick();
    });

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
      (await waitForKeyGate(h, 222)).reject(new Error('cache key unavailable'));
      await tick();
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

// Cancel and unmount retire the request generation, so a request parked in its preflight spawns nothing afterwards.
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
      await waitForKeyGate(h, 111);
    });
    expect(h.workers).toHaveLength(0);

    act(() => hook!.cancel());
    expect(hook!.status).toBe('cancelled');

    await act(async () => {
      h.keyGates.get(111)!.resolve();
      await tick();
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

    // Not forced, so the request reaches the cache read and parks there.
    let pending!: Promise<MonteCarloSummary | null>;
    await act(async () => {
      pending = hook!.runToCompletion(c.input(111));
      (await waitForKeyGate(h, 111)).resolve();
      await waitForReadGate(h, 111);
    });
    expect(h.workers).toHaveLength(0);

    act(() => hook!.cancel());

    await act(async () => {
      h.readGates.get('key-111')!.resolve();
      await tick();
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
      await waitForKeyGate(h, 111);
    });

    view.unmount();

    await act(async () => {
      h.keyGates.get(111)!.resolve();
      await tick();
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
      (await waitForKeyGate(h, 111)).resolve();
      await waitForReadGate(h, 111);
    });

    view.unmount();

    await act(async () => {
      h.readGates.get('key-111')!.resolve();
      await tick();
    });
    await settle();

    expect(h.workers).toHaveLength(0);
    await expect(pending).resolves.toBeNull();
  });
});

describe('MonteCarloProvider — a late preflight cannot undo a Cancel', () => {
  it('a cache HIT that lands after Cancel does not publish "done" over "cancelled"', async () => {
    setCores(1);
    h.cached.set('key-111', fakeSummary(111));
    renderProvider();

    let pending!: Promise<MonteCarloSummary | null>;
    await act(async () => {
      pending = hook!.runToCompletion(smallInput(111));
      (await waitForKeyGate(h, 111)).resolve();
      await waitForReadGate(h, 111);
    });

    act(() => hook!.cancel());

    await act(async () => {
      h.readGates.get('key-111')!.resolve();
      await tick();
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
      await waitForKeyGate(h, 111);
    });

    act(() => hook!.cancel());

    await act(async () => {
      h.keyGates.get(111)!.resolve();
      await tick();
    });
    await settle();

    expect(resolved).toBe(true);
    expect(h.workers).toHaveLength(0);
    expect(hook!.status).toBe('cancelled');
  });

  it('a run kicked AFTER the Cancel still starts normally', async () => {
    setCores(1);
    renderProvider();

    act(() => hook!.cancel());

    await act(async () => {
      void hook!.runToCompletion(smallInput(222), { force: true });
      (await waitForKeyGate(h, 222)).resolve();
      await tick();
    });

    expect(h.workers).toHaveLength(1);
    expect(hook!.status).toBe('running');
  });
});
