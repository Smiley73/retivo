/** Page mount and demo-workspace seeding shared by the `BalanceProjectionPage.*.test.tsx` suites. TEST-ONLY. */
import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { clearAllStores, clearSelectedScenario } from '../db/store';
import { loadDemoData } from '../lib/demo-data-loader';
import { MonteCarloProvider } from '../monte-carlo/MonteCarloProvider';
import { renderOnce } from '../test/render-once';
import { withTheme } from '../test/theme-render';
import { BalanceProjectionPage } from './BalanceProjectionPage';

/** The page's charts read `useChartColors()`, so it needs a ThemeProvider ancestor as in the app shell. */
export function pageElement(path = '/balance-projection', probe?: ReactNode): ReactElement {
  return withTheme(
    'light',
    <MemoryRouter initialEntries={[path]}>
      <MonteCarloProvider>
        {probe}
        <BalanceProjectionPage />
      </MonteCarloProvider>
    </MemoryRouter>,
  );
}

export function renderPage(path?: string): ReturnType<typeof render> {
  return render(pageElement(path));
}

export function loadDemo(): Promise<unknown> {
  return loadDemoData({
    householdId: 'hh-test',
    email: 'demo@example.test',
    displayName: 'Demo User',
  });
}

/** `clearAllStores` leaves the `selectedScenario` singleton, which would carry one test's selection into the next. */
export async function resetWorkspace(): Promise<void> {
  await clearAllStores();
  await clearSelectedScenario();
  window.localStorage.clear();
}

export async function seedDemo(): Promise<void> {
  await resetWorkspace();
  await loadDemo();
}

/** Seeds the demo workspace and mounts the page once for a describe of read-only cases; `dispose` goes in `afterAll`. */
export async function mountSharedPage(): Promise<{
  container: HTMLElement;
  dispose: () => Promise<void>;
}> {
  await seedDemo();
  const mounted = renderOnce(pageElement());
  return {
    container: mounted.container,
    dispose: async () => {
      mounted.dispose();
      await resetWorkspace();
    },
  };
}
