// A worker that cannot be created or dispatched to must publish the failure through `error`/`status`, clear progress and
// terminate what was created; `run` resolves (it is resultless) and `runToCompletion` rejects.
import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonteCarloInput } from '../lib/monte-carlo';

const h = vi.hoisted(() => ({
  constructorThrows: false,
  postMessageThrows: false,
  workers: [] as Array<{ terminated: boolean }>,
}));

vi.mock('../db/monte-carlo-cache', () => ({
  mcCacheKey: async (input: MonteCarloInput) => `key-${input.seed}`,
  getCached: async () => null,
  putCached: async () => undefined,
}));

vi.mock('../workers/monte-carlo.worker?worker', () => {
  class FakeMcWorker {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: { message?: string }) => void) | null = null;
    terminated = false;
    constructor() {
      if (h.constructorThrows) throw new Error('Worker constructor blocked');
      h.workers.push(this);
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    postMessage(): void {
      if (h.postMessageThrows) throw new Error('could not be cloned');
    }
    terminate(): void {
      this.terminated = true;
    }
  }
  return { default: FakeMcWorker };
});

import { MonteCarloProvider, useMonteCarlo } from './MonteCarloProvider';
import { smallInput } from './fake-worker.test-harness';

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

beforeEach(() => {
  h.constructorThrows = false;
  h.postMessageThrows = false;
  h.workers.length = 0;
  hook = null;
  Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 1 });
});

describe('MonteCarloProvider — the Worker constructor throws', () => {
  it('runToCompletion publishes the error, clears progress and rejects instead of stranding "running"', async () => {
    h.constructorThrows = true;
    renderProvider();

    let rejection: unknown = null;
    await act(async () => {
      await hook!.runToCompletion(smallInput(111), { force: true }).catch((e: unknown) => {
        rejection = e;
      });
    });

    expect((rejection as Error | null)?.message).toBe('Worker constructor blocked');
    expect(hook!.status).toBe('error');
    expect(hook!.error).toBe('Worker constructor blocked');
    expect(hook!.progressDone).toBe(0);
    expect(hook!.progressTotal).toBe(0);
  });

  it('the resultless run() publishes the error and RESOLVES (never rejects)', async () => {
    h.constructorThrows = true;
    renderProvider();

    let resolved = false;
    let rejection: unknown = null;
    await act(async () => {
      await hook!
        .run(smallInput(111), { force: true })
        .then(() => {
          resolved = true;
        })
        .catch((e: unknown) => {
          rejection = e;
        });
    });

    expect(rejection).toBeNull();
    expect(resolved).toBe(true);
    expect(hook!.status).toBe('error');
    expect(hook!.error).toBe('Worker constructor blocked');
    expect(hook!.progressTotal).toBe(0);
  });

  it('a later successful run recovers — the failure is not sticky', async () => {
    h.constructorThrows = true;
    renderProvider();
    await act(async () => {
      await hook!.runToCompletion(smallInput(111), { force: true }).catch(() => null);
    });
    expect(hook!.status).toBe('error');

    h.constructorThrows = false;
    await act(async () => {
      void hook!.runToCompletion(smallInput(222), { force: true });
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    expect(h.workers).toHaveLength(1);
    expect(hook!.status).toBe('running');
    expect(hook!.error).toBeNull();
  });
});

describe('MonteCarloProvider — postMessage throws on dispatch', () => {
  it('runToCompletion terminates the worker it created, publishes the error and rejects', async () => {
    h.postMessageThrows = true;
    renderProvider();

    let rejection: unknown = null;
    await act(async () => {
      await hook!.runToCompletion(smallInput(111), { force: true }).catch((e: unknown) => {
        rejection = e;
      });
    });

    expect((rejection as Error | null)?.message).toBe('could not be cloned');
    expect(hook!.status).toBe('error');
    expect(hook!.error).toBe('could not be cloned');
    expect(hook!.progressTotal).toBe(0);
    expect(h.workers).toHaveLength(1);
    expect(h.workers[0].terminated).toBe(true);
  });

  it('the resultless run() terminates the worker, publishes the error and RESOLVES', async () => {
    h.postMessageThrows = true;
    renderProvider();

    let resolved = false;
    let rejection: unknown = null;
    await act(async () => {
      await hook!
        .run(smallInput(111), { force: true })
        .then(() => {
          resolved = true;
        })
        .catch((e: unknown) => {
          rejection = e;
        });
    });

    expect(rejection).toBeNull();
    expect(resolved).toBe(true);
    expect(hook!.status).toBe('error');
    expect(hook!.error).toBe('could not be cloned');
    expect(h.workers).toHaveLength(1);
    expect(h.workers[0].terminated).toBe(true);
  });
});
