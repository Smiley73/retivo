/**
 * Shell invariants for the tabbed views + pinned controls strip.
 * `BalanceProjectionPage.test.tsx` is already over the 800-line shape cap, so
 * these assertions live here instead of growing that file.
 *
 * jsdom applies no stylesheet and `@testing-library/dom` ignores `inert`, so
 * a query can find content inside a hidden panel exactly as happily as
 * inside the selected one — the width/pinning guarantees are a browser-only
 * concern (see the new e2e spec). What jsdom CAN prove, and what this file
 * proves once rather than per content test: the URL/selection/keyboard
 * contract, the scroll-on-switch-only behavior, the controls group's
 * singularity, and the `[data-inert]` shell invariant (a selected view's
 * marker content has no `data-inert` ancestor; another view's does).
 */
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import React, { useEffect } from 'react';
import { clearAllStores } from '../db/store';
import { loadDemoData } from '../lib/demo-data-loader';
import { BalanceProjectionPage } from './BalanceProjectionPage';
import { MonteCarloProvider } from '../monte-carlo/MonteCarloProvider';
import { withTheme } from '../test/theme-render';
import { renderOnce } from '../test/render-once';
import {
  VIEW_LABELS,
  VIEW_ORDER,
  type BalanceProjectionViewId,
} from './balance-projection-page-constants';

interface ProbeEntry {
  search: string;
  navType: string;
}

/** Reads the router location through a component — `MemoryRouter` never
 *  touches `window.location`, so this is the only way to observe a URL
 *  rewrite or its navigation type (PUSH vs REPLACE) from a test. */
function LocationProbe({
  onEntry,
}: {
  onEntry: (entry: ProbeEntry) => void;
}): null {
  const location = useLocation();
  const navType = useNavigationType();
  useEffect(() => {
    onEntry({ search: location.search, navType });
  }, [location.search, navType, onEntry]);
  return null;
}

function pageAtPath(path: string, log: ProbeEntry[]): React.ReactElement {
  return withTheme(
    'light',
    <MemoryRouter initialEntries={[path]}>
      <MonteCarloProvider>
        <LocationProbe onEntry={(e) => log.push(e)} />
        <BalanceProjectionPage />
      </MonteCarloProvider>
    </MemoryRouter>,
  );
}

function renderAtPath(path: string): { log: ProbeEntry[] } {
  const log: ProbeEntry[] = [];
  render(pageAtPath(path, log));
  return { log };
}

/** One marker per view — content that only that view's panel renders,
 *  chosen so it settles without waiting on the Monte Carlo stress run. */
const VIEW_MARKERS: Readonly<
  Record<BalanceProjectionViewId, () => Promise<HTMLElement>>
> = {
  overview: () =>
    screen.findByText(/Planned · at retirement/, undefined, { timeout: 5000 }),
  cashflow: () =>
    screen.findByRole(
      'radiogroup',
      { name: 'Cashflow chart granularity' },
      { timeout: 5000 },
    ),
  accounts: () =>
    screen.findByRole(
      'button',
      { name: 'Show account-by-account projection' },
      { timeout: 5000 },
    ),
  taxes: () =>
    screen.findByRole(
      'heading',
      { name: /Tax & Health-Cost Burden/ },
      { timeout: 5000 },
    ),
  swr: () =>
    screen.findByRole(
      'heading',
      { name: /Safe withdrawal rate comparison/ },
      { timeout: 5000 },
    ),
  // The panel heading renders before, and without, the second projection.
  compare: () =>
    screen.findByRole(
      'heading',
      { name: 'Compare scenarios' },
      { timeout: 5000 },
    ),
};

/** True when `el` or an ancestor carries `data-inert` — the attribute React
 *  Aria's `Tabs` sets on exactly the non-selected force-mounted panels. Unit
 *  tests must assert on this, not on visibility (jsdom applies no CSS). */
function hasInertAncestor(el: HTMLElement): boolean {
  let node: HTMLElement | null = el;
  while (node) {
    if (node.hasAttribute('data-inert')) return true;
    node = node.parentElement;
  }
  return false;
}

async function seedDemo(): Promise<void> {
  await clearAllStores();
  window.localStorage.clear();
  await loadDemoData({
    householdId: 'hh-test',
    email: 'demo@example.test',
    displayName: 'Demo User',
  });
}

describe('BalanceProjectionPage — tabbed views shell (02)', () => {
  beforeEach(seedDemo);

  afterEach(async () => {
    await clearAllStores();
    window.localStorage.clear();
  });

  it('defaults to Overview with an unrecognised param', async () => {
    renderAtPath('/balance-projection?view=bogus');
    const overviewTab = await screen.findByRole(
      'tab',
      { name: 'Overview' },
      { timeout: 5000 },
    );
    await waitFor(() =>
      expect(overviewTab).toHaveAttribute('aria-selected', 'true'),
    );
    expect(hasInertAncestor(await VIEW_MARKERS.overview())).toBe(false);
  });

  it.each(VIEW_ORDER)(
    'deep-links to %s selected, with no scroll on mount',
    async (id) => {
      const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView');
      renderAtPath(`/balance-projection?view=${id}`);
      const tab = await screen.findByRole(
        'tab',
        { name: VIEW_LABELS[id] },
        { timeout: 5000 },
      );
      await waitFor(() => expect(tab).toHaveAttribute('aria-selected', 'true'));
      await VIEW_MARKERS[id]();
      expect(scrollSpy).not.toHaveBeenCalled();
      scrollSpy.mockRestore();
    },
  );

  it.each(VIEW_ORDER)(
    "shows %s's marker with no data-inert ancestor, while another view's does",
    async (id) => {
      renderAtPath(`/balance-projection?view=${id}`);
      // The first render of the full page can outlast the default 1 s waits
      // on a loaded coverage runner, so both waits carry the same 5 s budget
      // the marker lookups below use.
      const tab = await screen.findByRole(
        'tab',
        { name: VIEW_LABELS[id] },
        { timeout: 5000 },
      );
      await waitFor(() => expect(tab).toHaveAttribute('aria-selected', 'true'), {
        timeout: 5000,
      });
      expect(hasInertAncestor(await VIEW_MARKERS[id]())).toBe(false);

      const other = VIEW_ORDER.find((v) => v !== id)!;
      expect(hasInertAncestor(await VIEW_MARKERS[other]())).toBe(true);
    },
  );

  it('clicking each tab selects it, rewrites ?view=, and replaces (not pushes) history', async () => {
    const user = userEvent.setup();
    const { log } = renderAtPath('/balance-projection');
    await screen.findByRole('tab', { name: 'Overview' }, { timeout: 5000 });
    // The switch scroll runs only when the strip has scrolled out of view
    // above; jsdom lays nothing out, so stand the anchor 120px above the
    // viewport for this test (the in-view case is covered below).
    const anchor = screen.getByRole('group', { name: 'Projection controls' })
      .parentElement!.parentElement!;
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
      top: -120,
    } as DOMRect);

    // Overview is already selected on load, so it is clicked last: a click
    // on the current tab is a no-op (see the re-select test below).
    for (const id of [...VIEW_ORDER.slice(1), VIEW_ORDER[0]]) {
      let selectedAtScroll: string | null = null;
      const scrollSpy = vi
        .spyOn(Element.prototype, 'scrollIntoView')
        .mockImplementation(() => {
          selectedAtScroll =
            document.querySelector('[role="tab"][aria-selected="true"]')
              ?.textContent ?? null;
        });
      await user.click(screen.getByRole('tab', { name: VIEW_LABELS[id] }));
      await waitFor(() =>
        expect(
          screen.getByRole('tab', { name: VIEW_LABELS[id] }),
        ).toHaveAttribute('aria-selected', 'true'),
      );
      // A click-driven switch scrolls the strip's non-sticky ancestor:
      // the one element wrapping both the controls strip and the panels.
      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(scrollSpy).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: 'instant', block: 'start' }),
      );
      const scrolled = scrollSpy.mock.contexts[0] as Element;
      const strip = screen.getByRole('group', { name: 'Projection controls' });
      expect(scrolled.contains(strip)).toBe(true);
      expect(scrolled.contains(await VIEW_MARKERS[id]())).toBe(true);
      // And only once the incoming view is selected — a scroll measured
      // against the outgoing view clamps short when that view is shorter,
      // and the new view then renders beneath a misplaced strip.
      expect(selectedAtScroll).toBe(VIEW_LABELS[id]);
      scrollSpy.mockRestore();
      const last = log.at(-1)!;
      // Always written explicitly, including Overview; REPLACE,
      // never PUSH — Back must leave the page, not step back through tabs.
      expect(last.search).toBe(`?view=${id}`);
      expect(last.navType).toBe('REPLACE');
      expect(log.some((e) => e.navType === 'PUSH')).toBe(false);
    }
  });

  it('switching with the strip already in view does not scroll the page', async () => {
    const user = userEvent.setup();
    renderAtPath('/balance-projection');
    await screen.findByRole('tab', { name: 'Overview' }, { timeout: 5000 });
    // jsdom's default rect (top 0) is the page-at-the-top case: the strip is
    // visible, the new view already starts beneath it, nothing to scroll.
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView');
    const cashflowTab = screen.getByRole('tab', { name: 'Cash flow' });
    await user.click(cashflowTab);
    await waitFor(() =>
      expect(cashflowTab).toHaveAttribute('aria-selected', 'true'),
    );
    expect(scrollSpy).not.toHaveBeenCalled();
    scrollSpy.mockRestore();
  });

  it('re-selecting the current tab neither scrolls nor rewrites history', async () => {
    const user = userEvent.setup();
    const { log } = renderAtPath('/balance-projection?view=cashflow');
    const cashflowTab = await screen.findByRole(
      'tab',
      { name: 'Cash flow' },
      { timeout: 5000 },
    );
    await waitFor(() =>
      expect(cashflowTab).toHaveAttribute('aria-selected', 'true'),
    );
    const entriesBefore = log.length;
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView');
    await user.click(cashflowTab);
    expect(cashflowTab).toHaveAttribute('aria-selected', 'true');
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(log).toHaveLength(entriesBefore);
    scrollSpy.mockRestore();
  });

  it('arrow keys move focus without switching; Enter and Space do switch', async () => {
    const user = userEvent.setup();
    renderAtPath('/balance-projection');
    const overviewTab = await screen.findByRole(
      'tab',
      { name: 'Overview' },
      { timeout: 5000 },
    );
    overviewTab.focus();
    expect(overviewTab).toHaveFocus();

    // Arrow-right moves DOM focus to the next tab, but keyboardActivation
    // "manual" means the selection — and the URL — do not change.
    await user.keyboard('{ArrowRight}');
    const cashflowTab = screen.getByRole('tab', { name: 'Cash flow' });
    expect(cashflowTab).toHaveFocus();
    expect(overviewTab).toHaveAttribute('aria-selected', 'true');
    expect(cashflowTab).toHaveAttribute('aria-selected', 'false');

    // Enter on the focused (not yet selected) tab switches it.
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(cashflowTab).toHaveAttribute('aria-selected', 'true'),
    );
    expect(overviewTab).toHaveAttribute('aria-selected', 'false');

    // Space behaves the same way, one tab further along the row.
    await user.keyboard('{ArrowRight}');
    const accountsTab = screen.getByRole('tab', { name: 'Accounts' });
    expect(accountsTab).toHaveFocus();
    expect(accountsTab).toHaveAttribute('aria-selected', 'false');
    await user.keyboard(' ');
    await waitFor(() =>
      expect(accountsTab).toHaveAttribute('aria-selected', 'true'),
    );
  });
});

describe('BalanceProjectionPage — tabbed views shell (02), read-only checks', () => {
  let dispose: () => void;

  beforeAll(async () => {
    await seedDemo();
    ({ dispose } = renderOnce(pageAtPath('/balance-projection', [])));
  }, 30_000);

  afterAll(async () => {
    dispose();
    await clearAllStores();
    window.localStorage.clear();
  });

  it('defaults to Overview with no param', async () => {
    const overviewTab = await screen.findByRole(
      'tab',
      { name: 'Overview' },
      { timeout: 5000 },
    );
    await waitFor(() =>
      expect(overviewTab).toHaveAttribute('aria-selected', 'true'),
    );
    expect(hasInertAncestor(await VIEW_MARKERS.overview())).toBe(false);
  });

  it('renders the "Projection controls" group exactly once, outside every panel', async () => {
    await screen.findByRole('tab', { name: 'Overview' }, { timeout: 5000 });
    const groups = screen.getAllByRole('group', { name: 'Projection controls' });
    expect(groups).toHaveLength(1);
    let node: HTMLElement | null = groups[0];
    while (node) {
      expect(node.classList.contains('bp-view-panel')).toBe(false);
      node = node.parentElement;
    }
  });

  it('renders the `.bp-view-panel`s in VIEW_ORDER document order — the DOM/print order', async () => {
    await screen.findByRole('tab', { name: 'Overview' }, { timeout: 5000 });

    // Every view force-mounts, so every marker is findable without switching
    // tabs — the same guarantee the two `it.each(VIEW_ORDER)` suites above
    // rely on.
    const expectedPanels = await Promise.all(
      VIEW_ORDER.map(async (id) => {
        const marker = await VIEW_MARKERS[id]();
        const panel = marker.closest('.bp-view-panel');
        if (!panel) {
          throw new Error(`No .bp-view-panel ancestor for the ${id} marker`);
        }
        return panel;
      }),
    );
    const domPanels = Array.from(document.querySelectorAll('.bp-view-panel'));
    // Asserts document order matches VIEW_ORDER exactly — a JSX panel
    // reordered from VIEW_ORDER (the panels are hand-written, not mapped
    // from it) fails this even though the tab row and every other test
    // above stay green.
    expect(domPanels).toEqual(expectedPanels);
  });
});
