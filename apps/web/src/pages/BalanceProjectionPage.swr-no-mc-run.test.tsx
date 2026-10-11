/**
 * The "Safe withdrawal rate" tab panel
 * force-mounts alongside its siblings and reads only the page's ALREADY-
 * resolved view model — its own module docblock states it "never flips
 * `runStressTest` or starts a Monte Carlo run of its own", i.e. it starts no
 * run ADDITIONAL to the page's own. This file pins that: deep-linking
 * straight to `?view=swr` (so the panel's resolver runs on initial mount,
 * the same way it would for a hidden force-mounted panel behind any other
 * selected tab) calls `run` zero times and `runToCompletion` exactly once —
 * the page's own `PlanStressTestSection` auto-run, identified by its
 * `pathCount: MC_PATH_COUNT` argument — never a second call from the panel
 * itself. The hazard this guards is a `shouldForceMount` panel that reads
 * `useMonteCarlo` itself instead of the page's shared vm.
 *
 * Mirrors `BalanceProjectionPage.stress-status.test.tsx`'s file-scoped
 * `MonteCarloProvider` mock (spies in place of a real run), single concern
 * only — the sibling `BalanceProjectionPage.test.tsx` / `.views.test.tsx`
 * use the real provider.
 */
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { clearAllStores } from '../db/store';
import { loadDemoData } from '../lib/demo-data-loader';
import { MC_PATH_COUNT } from '../lib/monte-carlo-scenario-input';
import type { MonteCarloInput } from '../lib/monte-carlo-types';

const { run, runToCompletion } = vi.hoisted(() => ({
  run: vi.fn(async () => undefined),
  // Declared with the provider's input parameter rather than a bare `() => …`,
  // so the recorded call ARGUMENTS are typed and the `pathCount` assertion
  // below compiles (the param is referenced via `void` to satisfy
  // no-unused-vars, which doesn't honour the `_` prefix here). Never-settling
  // promise: the mocked run stays perpetually in flight, as in the sibling
  // `BalanceProjectionPage.stress-status.test.tsx`.
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

import { BalanceProjectionPage } from './BalanceProjectionPage';
import { MonteCarloProvider } from '../monte-carlo/MonteCarloProvider';
import { withTheme } from '../test/theme-render';

function renderAtSwr(): ReturnType<typeof render> {
  return render(
    withTheme(
      'light',
      <MemoryRouter initialEntries={['/balance-projection?view=swr']}>
        <MonteCarloProvider>
          <BalanceProjectionPage />
        </MonteCarloProvider>
      </MemoryRouter>,
    ),
  );
}

describe('BalanceProjectionPage — the swr panel starts no Monte Carlo run of its own', () => {
  beforeEach(async () => {
    await clearAllStores();
    window.localStorage.clear();
    await loadDemoData({
      householdId: 'hh-test',
      email: 'demo@example.test',
      displayName: 'Demo User',
    });
  });

  afterEach(async () => {
    await clearAllStores();
    window.localStorage.clear();
  });

  it('deep-linking to ?view=swr selects and force-mounts the panel starting no MC run of its own', async () => {
    renderAtSwr();

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

    // The page's OWN `PlanStressTestSection` auto-runs on every view — that
    // single call is expected here too; what the swr panel must NOT do is add
    // a second, additional one. The auto-run sits behind `usePlanStressTestVm`'s
    // 800 ms debounce, which outlasts the panel's heading, so WAIT for the
    // count instead of sampling the spy the moment the panel renders. A second
    // call would hold the count above 1 and fail this wait.
    await waitFor(() => expect(runToCompletion).toHaveBeenCalledTimes(1), {
      timeout: 5000,
    });

    // …and that one call is the page's own, identified by the stress test's
    // `pathCount: MC_PATH_COUNT` override. By now the panel has been mounted
    // for longer than that debounce, so a run of its own would be recorded.
    expect(runToCompletion.mock.calls[0][0]).toEqual(
      expect.objectContaining({ pathCount: MC_PATH_COUNT }),
    );

    // `run` is never called by anything on this page — the plan stress test
    // always goes through `runToCompletion`.
    expect(run).not.toHaveBeenCalled();
  });
});
