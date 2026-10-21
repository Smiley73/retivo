/**
 * The Compare tab on the Balance Projection page: which scenario it compares
 * with (URL, remembered choice, parent, none), when the second projection runs,
 * its states, and the headline block. Runs on the demo dataset, whose scenario
 * tree is Base > {Retire early at 62 > Funds Run Out, Delay — work to 70}.
 *
 * Force-mounting means every panel is in the DOM whether or not its tab is
 * selected, so "the projection did not run" is asserted on the calls to
 * `loadPageData` (spied below), never on what is rendered.
 */
import 'fake-indexeddb/auto';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { useEffect } from 'react';
import {
  clearAllStores,
  deleteAggregateLocally,
  listAggregates,
  putAggregate,
  writeSelectedScenario,
} from '../db/store';
import type { Aggregate, ScenarioPayload } from '../db/types';
import { loadDemoData } from '../lib/demo-data-loader';
import { SELECTED_SCENARIO_CHANGED_EVENT } from '../lib/scenario-mutations';
import { COMPARE_CHOICE_STORAGE_KEY } from '../lib/view-deflator';
import { TaxIntegrationInvalidInputError } from '../lib/balance-projection-runner-tax';
import { MonteCarloProvider } from '../monte-carlo/MonteCarloProvider';
import { expectNoA11yViolations } from '../test/a11y';
import { withTheme } from '../test/theme-render';
import { BalanceProjectionPage } from './BalanceProjectionPage';
import { loadPageData } from './balance-projection-page-data';

vi.mock('./balance-projection-page-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./balance-projection-page-data')>();
  return { ...actual, loadPageData: vi.fn(actual.loadPageData) };
});

const actualLoad = (
  await vi.importActual<typeof import('./balance-projection-page-data')>(
    './balance-projection-page-data',
  )
).loadPageData;
const loadSpy = vi.mocked(loadPageData);

const BASE = 'demo-scenario-base';
const EARLY = 'demo-scenario-early';
const DELAY = 'demo-scenario-delay';
const FUNDS_RUN_OUT = 'demo-scenario-early-no-contrib';
const WAIT = { timeout: 10_000 };

interface ProbeEntry {
  search: string;
  navType: string;
}

function LocationProbe({ onEntry }: { onEntry: (e: ProbeEntry) => void }): null {
  const location = useLocation();
  const navType = useNavigationType();
  useEffect(() => {
    onEntry({ search: location.search, navType });
  }, [location.search, navType, onEntry]);
  return null;
}

class Boundary extends React.Component<
  { children: React.ReactNode },
  { message: string | null }
> {
  override state = { message: null as string | null };
  static getDerivedStateFromError(e: Error): { message: string } {
    return { message: e.message };
  }
  override render(): React.ReactNode {
    return this.state.message === null ? this.props.children : `caught: ${this.state.message}`;
  }
}

function pageAt(
  path: string,
  log: ProbeEntry[] = [],
  theme: 'light' | 'dark' = 'light',
): React.ReactElement {
  return withTheme(
    theme,
    <MemoryRouter initialEntries={[path]}>
      <MonteCarloProvider>
        <LocationProbe onEntry={(e) => log.push(e)} />
        <BalanceProjectionPage />
      </MonteCarloProvider>
    </MemoryRouter>,
  );
}

async function view(scenarioId: string): Promise<void> {
  await writeSelectedScenario({ scenarioId, updatedAt: new Date().toISOString() });
}

/** The `selectedScenarioId` of every `loadPageData` call so far. */
function projectedIds(): string[] {
  return loadSpy.mock.calls.map(([opts]) => opts.selectedScenarioId);
}

async function findPanel(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'Compare scenarios' }, WAIT);
}

function selectorTrigger(panel: HTMLElement): HTMLElement {
  return within(panel).getByRole('button', { name: /Compare with/ });
}

async function renderCompare(
  path: string,
  viewed: string,
): Promise<{ panel: HTMLElement; log: ProbeEntry[] }> {
  await view(viewed);
  const log: ProbeEntry[] = [];
  render(pageAt(path, log));
  return { panel: await findPanel(), log };
}

function atHorizonStat(): string {
  return screen.getByText('Planned · at horizon').nextElementSibling!.textContent!;
}

function headlineCells(panel: HTMLElement, row: RegExp): string[] {
  return within(within(panel).getByRole('row', { name: row }))
    .getAllByRole('gridcell')
    .map((c) => c.textContent ?? '');
}

describe('BalanceProjectionPage — Compare tab', () => {
  beforeEach(async () => {
    await clearAllStores();
    window.localStorage.clear();
    await loadDemoData({
      householdId: 'hh-test',
      email: 'demo@example.test',
      displayName: 'Demo User',
    });
    loadSpy.mockClear();
    loadSpy.mockImplementation(actualLoad);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearAllStores();
    window.localStorage.clear();
  });

  describe('which scenario it compares with', () => {
    it('defaults to the viewed scenario’s parent', async () => {
      const { panel } = await renderCompare('/balance-projection?view=compare', EARLY);
      expect(selectorTrigger(panel)).toHaveTextContent('Base (Base)');
      await within(panel).findByRole('row', { name: /Ending balance/ }, WAIT);
      expect(projectedIds()).toContain(BASE);
    });

    it('asks to pick one on Base and projects nothing for a comparison', async () => {
      const { panel } = await renderCompare('/balance-projection?view=compare', BASE);
      expect(within(panel).getByText(/Choose a scenario above/)).toBeInTheDocument();
      expect(selectorTrigger(panel)).toHaveTextContent('Choose a scenario');
      expect(within(panel).queryByRole('row')).not.toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 300));
      expect(new Set(projectedIds())).toEqual(new Set([BASE]));
    });

    it('lists every other scenario in the sidebar’s tree order and labels', async () => {
      const user = userEvent.setup();
      const { panel } = await renderCompare('/balance-projection?view=compare', EARLY);
      await user.click(selectorTrigger(panel));
      const labels = screen.getAllByRole('option').map((o) => o.textContent);
      expect(labels).toEqual(['Base (Base)', 'Delay — work to 70', 'Funds Run Out']);
    });

    it('selects the scenario named by ?with=, without remembering a deep link', async () => {
      const { panel } = await renderCompare(
        `/balance-projection?view=compare&with=${DELAY}`,
        EARLY,
      );
      expect(selectorTrigger(panel)).toHaveTextContent('Delay — work to 70');
      expect(window.localStorage.getItem(COMPARE_CHOICE_STORAGE_KEY)).toBeNull();
    });

    it('stops applying ?with= once another scenario is picked in the sidebar', async () => {
      window.localStorage.setItem(
        COMPARE_CHOICE_STORAGE_KEY,
        JSON.stringify({ [BASE]: FUNDS_RUN_OUT }),
      );
      const { panel, log } = await renderCompare(
        `/balance-projection?view=compare&with=${DELAY}`,
        EARLY,
      );
      expect(selectorTrigger(panel)).toHaveTextContent('Delay — work to 70');

      await view(BASE);
      act(() => {
        window.dispatchEvent(new Event(SELECTED_SCENARIO_CHANGED_EVENT));
      });
      await waitFor(() => expect(selectorTrigger(panel)).toHaveTextContent('Funds Run Out'), WAIT);
      await waitFor(() => expect(log.at(-1)!.search).toBe('?view=compare'), WAIT);
    });

    it('stops applying ?with= after a sidebar switch through a scenario that shows no panel', async () => {
      window.localStorage.setItem(
        COMPARE_CHOICE_STORAGE_KEY,
        JSON.stringify({ [BASE]: FUNDS_RUN_OUT }),
      );
      loadSpy.mockImplementation((opts) => {
        if (opts.selectedScenarioId === FUNDS_RUN_OUT) {
          throw new TaxIntegrationInvalidInputError('bad config');
        }
        return actualLoad(opts);
      });
      const { panel, log } = await renderCompare(
        `/balance-projection?view=compare&with=${DELAY}`,
        EARLY,
      );
      expect(selectorTrigger(panel)).toHaveTextContent('Delay — work to 70');

      await view(FUNDS_RUN_OUT);
      act(() => {
        window.dispatchEvent(new Event(SELECTED_SCENARIO_CHANGED_EVENT));
      });
      await waitFor(
        () => expect(screen.queryByRole('region', { name: 'Compare scenarios' })).toBeNull(),
        WAIT,
      );
      await view(BASE);
      act(() => {
        window.dispatchEvent(new Event(SELECTED_SCENARIO_CHANGED_EVENT));
      });
      const back = await findPanel();
      await waitFor(() => expect(selectorTrigger(back)).toHaveTextContent('Funds Run Out'), WAIT);
      await waitFor(() => expect(log.at(-1)!.search).toBe('?view=compare'), WAIT);
    });

    it('falls back to the default, not ?with=, after a sidebar switch with nothing remembered', async () => {
      const { panel } = await renderCompare(
        `/balance-projection?view=compare&with=${BASE}`,
        EARLY,
      );
      expect(selectorTrigger(panel)).toHaveTextContent('Base (Base)');

      await view(DELAY);
      act(() => {
        window.dispatchEvent(new Event(SELECTED_SCENARIO_CHANGED_EVENT));
      });
      await waitFor(() => expect(selectorTrigger(panel)).toHaveTextContent('Base (Base)'), WAIT);
      await view(BASE);
      act(() => {
        window.dispatchEvent(new Event(SELECTED_SCENARIO_CHANGED_EVENT));
      });
      await waitFor(
        () => expect(selectorTrigger(panel)).toHaveTextContent('Choose a scenario'),
        WAIT,
      );
    });

    it.each([
      ['the viewed scenario', EARLY],
      ['an unknown id', 'no-such-scenario'],
    ])('falls back to the parent when ?with= names %s', async (_label, bad) => {
      const { panel } = await renderCompare(
        `/balance-projection?view=compare&with=${bad}`,
        EARLY,
      );
      expect(selectorTrigger(panel)).toHaveTextContent('Base (Base)');
    });

    it('writes ?with= with REPLACE (never PUSH) and remembers the choice', async () => {
      const user = userEvent.setup();
      const { panel, log } = await renderCompare('/balance-projection?view=compare', EARLY);
      await user.click(selectorTrigger(panel));
      await user.click(screen.getByRole('option', { name: 'Delay — work to 70' }));
      await waitFor(() => expect(selectorTrigger(panel)).toHaveTextContent('Delay — work to 70'));
      const last = log.at(-1)!;
      expect(last.search).toBe(`?view=compare&with=${DELAY}`);
      expect(last.navType).toBe('REPLACE');
      expect(log.some((e) => e.navType === 'PUSH')).toBe(false);
      expect(JSON.parse(window.localStorage.getItem(COMPARE_CHOICE_STORAGE_KEY)!)).toEqual({
        [EARLY]: DELAY,
      });
    });

    it('re-projects the newly chosen scenario when the selector changes in-session', async () => {
      const user = userEvent.setup();
      const { panel } = await renderCompare('/balance-projection?view=compare', EARLY);
      await within(panel).findByRole('row', { name: /Ending balance/ }, WAIT);
      const [, before] = headlineCells(panel, /Ending balance/);
      expect(projectedIds()).not.toContain(DELAY);

      await user.click(selectorTrigger(panel));
      await user.click(screen.getByRole('option', { name: 'Delay — work to 70' }));
      await waitFor(() => expect(projectedIds().filter((id) => id === DELAY)).toHaveLength(1), WAIT);
      await waitFor(() => {
        const [, after] = headlineCells(panel, /Ending balance/);
        expect(after).not.toBe(before);
      }, WAIT);
      expect(within(panel).getAllByRole('columnheader')[2]).toHaveTextContent('Delay — work to 70');
      await new Promise((r) => setTimeout(r, 300));
      expect(projectedIds().filter((id) => id === DELAY)).toHaveLength(1);
    });

    it('reopens on the remembered choice for that viewed scenario when there is no ?with=', async () => {
      window.localStorage.setItem(
        COMPARE_CHOICE_STORAGE_KEY,
        JSON.stringify({ [EARLY]: DELAY, [BASE]: FUNDS_RUN_OUT }),
      );
      const { panel } = await renderCompare('/balance-projection?view=compare', EARLY);
      expect(selectorTrigger(panel)).toHaveTextContent('Delay — work to 70');
    });

    it('remembers a choice made in the selector across a fresh mount', async () => {
      const user = userEvent.setup();
      const first = await renderCompare('/balance-projection?view=compare', EARLY);
      await user.click(selectorTrigger(first.panel));
      await user.click(screen.getByRole('option', { name: 'Funds Run Out' }));
      await waitFor(() =>
        expect(selectorTrigger(first.panel)).toHaveTextContent('Funds Run Out'),
      );
      cleanup();
      const { panel } = await renderCompare('/balance-projection?view=compare', EARLY);
      expect(selectorTrigger(panel)).toHaveTextContent('Funds Run Out');
    });

    it('falls back to the parent when the remembered scenario no longer exists', async () => {
      window.localStorage.setItem(
        COMPARE_CHOICE_STORAGE_KEY,
        JSON.stringify({ [EARLY]: 'deleted-scenario' }),
      );
      const { panel } = await renderCompare('/balance-projection?view=compare', EARLY);
      expect(selectorTrigger(panel)).toHaveTextContent('Base (Base)');
    });

    it.each(['{not json', '[1,2]', '"text"', '{"demo-scenario-early":7}'])(
      'reads a malformed stored value (%s) as no remembered choice, without throwing',
      async (stored) => {
        window.localStorage.setItem(COMPARE_CHOICE_STORAGE_KEY, stored);
        const { panel } = await renderCompare('/balance-projection?view=compare', EARLY);
        expect(selectorTrigger(panel)).toHaveTextContent('Base (Base)');
      },
    );

    it('says there is nothing to compare with when it is the only scenario, and links to Scenarios', async () => {
      for (const id of [EARLY, DELAY, FUNDS_RUN_OUT]) {
        await deleteAggregateLocally('scenario', id);
      }
      const { panel } = await renderCompare('/balance-projection?view=compare', BASE);
      expect(within(panel).getByText(/nothing to compare with/)).toBeInTheDocument();
      expect(within(panel).queryByRole('button', { name: /Compare with/ })).toBeNull();
      expect(within(panel).getByRole('link', { name: 'Go to Scenarios' })).toHaveAttribute(
        'href',
        '/scenarios',
      );
    });
  });

  describe('the second projection', () => {
    it('runs only while the tab is selected, once, and not again on a tab round trip', async () => {
      const user = userEvent.setup();
      await view(EARLY);
      render(pageAt('/balance-projection'));
      await screen.findByText('Planned · at horizon', undefined, WAIT);
      await new Promise((r) => setTimeout(r, 300));
      expect(projectedIds()).not.toContain(BASE);

      await user.click(screen.getByRole('tab', { name: 'Compare' }));
      const panel = await findPanel();
      await within(panel).findByRole('row', { name: /Ending balance/ }, WAIT);
      expect(projectedIds().filter((id) => id === BASE)).toHaveLength(1);

      await user.click(screen.getByRole('tab', { name: 'Overview' }));
      await user.click(screen.getByRole('tab', { name: 'Compare' }));
      await new Promise((r) => setTimeout(r, 300));
      expect(projectedIds().filter((id) => id === BASE)).toHaveLength(1);
      expect(within(panel).getByRole('row', { name: /Ending balance/ })).toBeInTheDocument();
    });

    it('defers the run to an idle slice, showing a projecting state while the viewed figures stay up', async () => {
      const queued: Array<() => void> = [];
      vi.stubGlobal('requestIdleCallback', (cb: () => void) => queued.push(cb));
      vi.stubGlobal('cancelIdleCallback', () => undefined);
      const { panel } = await renderCompare(
        `/balance-projection?view=compare&with=${DELAY}`,
        EARLY,
      );
      const status = await within(panel).findByRole('status');
      expect(status).toHaveTextContent('Projecting Delay — work to 70');
      expect(status.parentElement).toHaveAttribute('aria-busy', 'true');
      expect(projectedIds()).not.toContain(DELAY);
      expect(screen.getByText('Planned · at horizon')).toBeInTheDocument();

      act(() => queued.splice(0).forEach((run) => run()));
      await within(panel).findByRole('row', { name: /Ending balance/ }, WAIT);
      // The Plan success row owns a status region of its own once the tab is
      // ready; the projecting message is the one that must be gone.
      expect(within(panel).queryByText(/^Projecting/)).not.toBeInTheDocument();
    });
  });

  describe('states', () => {
    it('shows an in-panel error naming the scenario when it cannot be projected, leaving the viewed figures alone', async () => {
      loadSpy.mockImplementation((opts) => {
        if (opts.selectedScenarioId === DELAY) {
          throw new TaxIntegrationInvalidInputError('bad config');
        }
        return actualLoad(opts);
      });
      const { panel } = await renderCompare(
        `/balance-projection?view=compare&with=${DELAY}`,
        EARLY,
      );
      const alert = await within(panel).findByRole('alert', undefined, WAIT);
      expect(alert).toHaveTextContent('Delay — work to 70');
      expect(alert).toHaveTextContent("can't be projected with its current settings");
      expect(within(panel).queryByRole('row')).not.toBeInTheDocument();
      expect(screen.getByText('Planned · at horizon')).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { level: 1, name: /Scenario: Retire early at 62/ }),
      ).toBeInTheDocument();
    });

    it('rethrows an error that is not a configuration clash, to the error boundary', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      loadSpy.mockImplementation((opts) => {
        if (opts.selectedScenarioId === DELAY) throw new Error('engine bug');
        return actualLoad(opts);
      });
      await view(EARLY);
      render(
        <Boundary>{pageAt(`/balance-projection?view=compare&with=${DELAY}`)}</Boundary>,
      );
      expect(await screen.findByText('caught: engine bug', undefined, WAIT)).toBeInTheDocument();
      spy.mockRestore();
    });

    it('does not read a missing Planned projection as "Never runs out"', async () => {
      loadSpy.mockImplementation((opts) => {
        const data = actualLoad(opts);
        return opts.selectedScenarioId === DELAY && data.pageResult
          ? { ...data, pageResult: { ...data.pageResult, planned: null } }
          : data;
      });
      const { panel } = await renderCompare(
        `/balance-projection?view=compare&with=${DELAY}`,
        EARLY,
      );
      await within(panel).findByText(/no Planned projection to compare/, undefined, WAIT);
      expect(within(panel).queryByRole('row')).not.toBeInTheDocument();
      expect(within(panel).queryByText(/Never|Neither runs out/)).not.toBeInTheDocument();
      expect(within(panel).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('offers a configure link when the comparison has no projection', async () => {
      loadSpy.mockImplementation((opts) => {
        const data = actualLoad(opts);
        return opts.selectedScenarioId === DELAY ? { ...data, pageResult: null } : data;
      });
      const { panel } = await renderCompare(
        `/balance-projection?view=compare&with=${DELAY}`,
        EARLY,
      );
      const link = await within(panel).findByRole('link', { name: /Configure Delay/ }, WAIT);
      expect(link).toHaveAttribute('href', `/scenarios/${DELAY}`);
      expect(within(panel).queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('basis and headline', () => {
    it('states the basis in a sentence, and the heading carries no basis suffix', async () => {
      const { panel } = await renderCompare('/balance-projection?view=compare', EARLY);
      expect(
        within(panel).getByRole('heading', { level: 2, name: 'Compare scenarios' }),
      ).toBeInTheDocument();
      expect(
        within(panel).getByText(/Compare always uses the Planned projection .* in today's dollars/),
      ).toHaveTextContent(/Basis and Today's\/Future dollars controls above do not apply here\.$/);
    });

    it('shows the viewed ending balance the Overview shows, each column headed by name and its own horizon year', async () => {
      // The demo scenarios all share one horizon, so add a child of Base that
      // lives five years longer.
      const base = (await listAggregates('scenario')).find((s) => s.id === BASE)!;
      const basePayload = base.payload as ScenarioPayload;
      await putAggregate('scenario', {
        ...base,
        id: 'long-life',
        payload: {
          ...basePayload,
          name: 'Long life',
          parentScenarioId: BASE,
          isPrimary: false,
          overrides: { lifeExpectancy: { primary: 100 } },
        },
      } as Aggregate<ScenarioPayload>);
      const { panel } = await renderCompare('/balance-projection?view=compare', 'long-life');
      await within(panel).findByRole('row', { name: /Ending balance/ }, WAIT);
      const [viewedBalance, comparisonBalance, difference] = headlineCells(
        panel,
        /Ending balance/,
      );
      expect(viewedBalance).toBe(atHorizonStat());
      expect(comparisonBalance).toMatch(/^\$/);
      expect(difference).toMatch(/^[+−]\$.+ (more|less)$/);

      const headers = within(panel).getAllByRole('columnheader');
      expect(headers[1]).toHaveTextContent('Long life');
      expect(headers[2]).toHaveTextContent('Base');
      const years = [headers[1], headers[2]].map(
        (h) => /Horizon (\d{4})/.exec(h.textContent ?? '')?.[1],
      );
      expect(years[0]).toBeDefined();
      expect(years[1]).toBeDefined();
      expect(Number(years[0])).toBe(Number(years[1]) + 5);
    });

    it('shows a run-out year on the depleting side and Never on the other', async () => {
      const { panel } = await renderCompare(
        `/balance-projection?view=compare&with=${FUNDS_RUN_OUT}`,
        EARLY,
      );
      await within(panel).findByRole('row', { name: /Year money runs out/ }, WAIT);
      const [viewed, comparison, difference] = headlineCells(panel, /Year money runs out/);
      expect(viewed).toBe('Never');
      expect(comparison).toMatch(/^\d{4}$/);
      expect(difference).toBe('Only the comparison scenario runs out');
    });

    it('has no accessibility violations with the selector closed, in light and dark', async () => {
      for (const theme of ['light', 'dark'] as const) {
        await view(EARLY);
        const { unmount } = render(
          pageAt('/balance-projection?view=compare', [], theme),
        );
        const panel = await findPanel();
        await within(panel).findByRole('row', { name: /Ending balance/ }, WAIT);
        await expectNoA11yViolations(panel);
        unmount();
      }
    });
  });
});
