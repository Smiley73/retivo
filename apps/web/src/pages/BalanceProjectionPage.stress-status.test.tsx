/**
 * Running-status placement on the balance-projection page.
 *
 * The running stress-test progress bar lives in the "Projection controls"
 * `role="group"` between the CBP banner and the tabbed views — outside every
 * panel, since a live region inside a non-selected force-mounted panel is
 * not announced — rather than inside the "Stress-test outcomes" card header
 * or the page `<header>`. This file mocks the MonteCarloProvider into a forced
 * `running` state so the status row is deterministically present, then
 * asserts the progressbar renders inside that controls group and NOT inside
 * the stress-test card region.
 *
 * The MonteCarloProvider is mocked file-wide here (the sibling
 * BalanceProjectionPage.test.tsx uses the real provider) so this file's
 * single concern is the status placement.
 */
import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { clearAllStores } from '../db/store';
import { loadDemoData } from '../lib/demo-data-loader';

// The SVG chart engine sizes itself via a ResizeObserver
// with an 800px fallback — no recharts stub needed (recharts is gone).

// Force a perpetually-running MC with mid-flight path progress so the
// determinate McProgressBar renders deterministically (no worker, no
// debounce race).
vi.mock('../monte-carlo/MonteCarloProvider', () => ({
  useMonteCarlo: () => ({
    status: 'running' as const,
    progressDone: 6200,
    progressTotal: 10000,
    result: null,
    error: null,
    run: vi.fn(async () => undefined),
    // The stress-test hook kicks its run through `runToCompletion` (the
    // completion-carrying API); a never-settling promise keeps the mocked run
    // perpetually in flight, which is exactly the state this suite renders.
    runToCompletion: vi.fn(() => new Promise<null>(() => {})),
    cancel: vi.fn(),
    setResult: vi.fn(),
  }),
  MonteCarloProvider: ({ children }: { children: React.ReactNode }) => children,
}));



import { BalanceProjectionPage } from './BalanceProjectionPage';
import { MonteCarloProvider } from '../monte-carlo/MonteCarloProvider';
import { withTheme } from '../test/theme-render';

function renderPage(): ReturnType<typeof render> {
  return render(
    withTheme(
      'light',
      <MemoryRouter initialEntries={['/balance-projection']}>
        <MonteCarloProvider>
          <BalanceProjectionPage />
        </MonteCarloProvider>
      </MemoryRouter>,
    ),
  );
}

describe('BalanceProjectionPage — running progress bar lives in the page header', () => {
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

  it('renders the running progress bar inside the page header, not the Stress-test outcomes card', async () => {
    renderPage();

    // The MC progress bar appears once the page resolves the demo
    // workspace (the forced-running provider keeps it visible). The
    // determinate label reflects the mocked 6,200 / 10,000 path progress.
    const progressbar = await screen.findByRole(
      'progressbar',
      { name: /Simulating market histories: 6,200 of 10,000 paths/i },
      { timeout: 5000 },
    );

    // It lives in the "Projection controls" group (the calc-state
    // slot that replaces the Recalculate button while a run is in flight),
    // not the page <header>.
    const controls = screen.getByRole('group', { name: 'Projection controls' });
    expect(controls.contains(progressbar)).toBe(true);

    // And NOT inside the "Stress-test outcomes" card region (its prior home —
    // the card's status slot was removed).
    const stressRegion = screen.getByRole('region', {
      name: 'Stress-test outcomes',
    });
    expect(stressRegion).not.toContainElement(progressbar);

    // While running, the header shows the progress bar in place of the
    // Recalculate button.
    expect(
      screen.queryByRole('button', {
        name: 'Recalculate the example projection',
      }),
    ).not.toBeInTheDocument();
  });
});
