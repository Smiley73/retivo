// A `?view=swr` deep link force-mounts the Safe withdrawal rate panel, which must start no Monte Carlo run of its own: `run` is never called and `runToCompletion` once, from the page's own stress-test auto-run.
import 'fake-indexeddb/auto';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { MC_PATH_COUNT } from '../lib/monte-carlo-scenario-input';
import type { MonteCarloInput } from '../lib/monte-carlo-types';

const { run, runToCompletion } = vi.hoisted(() => ({
  run: vi.fn(async () => undefined),
  // The input parameter types the recorded call arguments for the `pathCount` assertion (referenced via `void` for no-unused-vars). The never-settling promise keeps the run in flight.
  runToCompletion: vi.fn((input: MonteCarloInput) => {
    void input;
    return new Promise<null>(() => {});
  }),
}));

vi.mock('../monte-carlo/MonteCarloProvider', () => ({
  useMonteCarlo: () => ({
    status: 'idle' as const,
    progressDone: 0,
    progressTotal: 0,
    result: null,
    error: null,
    run,
    runToCompletion,
    cancel: vi.fn(),
    setResult: vi.fn(),
  }),
  MonteCarloProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { renderPage, resetWorkspace, seedDemo } from './balance-projection-page.test-harness';

describe('BalanceProjectionPage — the swr panel starts no Monte Carlo run of its own', () => {
  beforeEach(seedDemo);

  afterEach(resetWorkspace);

  it('deep-linking to ?view=swr selects and force-mounts the panel starting no MC run of its own', async () => {
    renderPage('/balance-projection?view=swr');

    const swrTab = await screen.findByRole(
      'tab',
      { name: 'Safe withdrawal rate' },
      { timeout: 5000 },
    );
    await screen.findByRole(
      'heading',
      { name: /Safe withdrawal rate comparison/ },
      { timeout: 5000 },
    );
    expect(swrTab).toHaveAttribute('aria-selected', 'true');

    // The page's own stress-test auto-run is the one expected call; it sits behind `usePlanStressTestVm`'s 800 ms debounce, so wait for the count rather than sampling when the panel renders. A second call would hold it above 1.
    await waitFor(() => expect(runToCompletion).toHaveBeenCalledTimes(1), {
      timeout: 5000,
    });

    // That call is the page's own, identified by its `pathCount: MC_PATH_COUNT` override.
    expect(runToCompletion.mock.calls[0][0]).toEqual(
      expect.objectContaining({ pathCount: MC_PATH_COUNT }),
    );

    expect(run).not.toHaveBeenCalled();
  });
});
