/**
 * Shared harness for the Compare tab page tests, on the demo dataset (Base >
 * {Retire early at 62 > Funds Run Out, Delay — work to 70}). TEST-ONLY.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import React from 'react';
import {
  clearAllStores,
  listAggregates,
  putAggregate,
  writeSelectedScenario,
} from '../../db/store';
import type { Aggregate, ScenarioOverrides, ScenarioPayload } from '../../db/types';
import { loadDemoData } from '../../lib/demo-data-loader';
import { MonteCarloProvider } from '../../monte-carlo/MonteCarloProvider';
import { withTheme } from '../../test/theme-render';
import { BalanceProjectionPage } from '../BalanceProjectionPage';

export const BASE = 'demo-scenario-base';
export const EARLY = 'demo-scenario-early';
export const DELAY = 'demo-scenario-delay';
export const FUNDS_RUN_OUT = 'demo-scenario-early-no-contrib';
export const WAIT = { timeout: 10_000 };

/** Empty stores and localStorage, then the demo household. */
export async function resetDemo(): Promise<void> {
  await clearAllStores();
  window.localStorage.clear();
  await loadDemoData({ householdId: 'hh-test', email: 'demo@example.test', displayName: 'Demo User' });
}

/** A child of `parentId` named `id` with exactly these overrides. */
export async function seedChild(
  id: string,
  parentId: string,
  overrides: ScenarioOverrides,
): Promise<void> {
  const parent = (await listAggregates('scenario')).find((s) => s.id === parentId)!;
  await putAggregate('scenario', {
    ...parent,
    id,
    payload: {
      ...(parent.payload as ScenarioPayload),
      name: id,
      parentScenarioId: parentId,
      isPrimary: false,
      overrides,
    },
  } as Aggregate<ScenarioPayload>);
}

export async function viewScenario(id: string): Promise<void> {
  await writeSelectedScenario({ scenarioId: id, updatedAt: new Date().toISOString() });
}

export const comparePath = (withId?: string): string =>
  `/balance-projection?view=compare${withId ? `&with=${withId}` : ''}`;

export function comparePage(args: {
  readonly path?: string;
  readonly theme?: 'light' | 'dark';
  readonly probe?: React.ReactNode;
} = {}): React.ReactElement {
  return withTheme(
    args.theme ?? 'light',
    <MemoryRouter initialEntries={[args.path ?? comparePath()]}>
      <MonteCarloProvider>
        {args.probe}
        <BalanceProjectionPage />
      </MonteCarloProvider>
    </MemoryRouter>,
  );
}

export const findComparePanel = (): Promise<HTMLElement> =>
  screen.findByRole('region', { name: 'Compare scenarios' }, WAIT);

/** View `viewed`, mount the page at `path` and wait for the Compare panel. */
export async function renderComparePage(
  viewed: string,
  args: Parameters<typeof comparePage>[0] = {},
): Promise<{ panel: HTMLElement; rerender: () => void }> {
  await viewScenario(viewed);
  const view = render(comparePage(args));
  return { panel: await findComparePanel(), rerender: () => view.rerender(comparePage(args)) };
}
