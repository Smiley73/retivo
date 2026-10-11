/**
 * Light render test for the cashflow/income chart-granularity toggle.
 *
 * The bulk of correctness lives in the pure `cashflow-series` +
 * `view-deflator` unit tests; this only asserts the page-level wiring:
 * the segmented control renders as a `role="radiogroup"` with two
 * `role="radio"` options, defaults to Yearly, and the choice survives
 * a remount via localStorage.
 *
 * The SVG chart engine sizes itself with an 800px fallback under
 * jsdom; the toggle itself renders outside the lazy chart Suspense
 * boundary, so we only wait for the demo workspace to drive
 * `incomeView` to a non-null state.
 */
import 'fake-indexeddb/auto';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  clearSelectedScenario,
  deleteAggregateLocally,
  listAggregates,
  putAggregate,
  writeSelectedScenario,
} from '../db/store';
import { loadDemoData } from '../lib/demo-data-loader';
import { SELECTED_SCENARIO_CHANGED_EVENT } from '../lib/scenario-mutations';
import { notifyWorkspaceChanged } from '../lib/workspace-events';
import type {
  AccountBalancePayload,
  Aggregate,
  ScenarioPayload,
} from '../db/types';

// The SVG chart engine sizes itself via a ResizeObserver
// with an 800px fallback, so no recharts ResponsiveContainer stub is
// needed (recharts is gone).

// Hoisted listAggregates-fault toggle, flipped by the
// error-after-prior-success test to force the next page reload to
// throw. All other tests pass through to the real implementation.
const storeOverrides = vi.hoisted<{ listAggregatesShouldThrow: boolean }>(
  () => ({ listAggregatesShouldThrow: false }),
);
vi.mock('../db/store', async () => {
  const actual = await vi.importActual<typeof import('../db/store')>('../db/store');
  return {
    ...actual,
    listAggregates: (...args: Parameters<typeof actual.listAggregates>) => {
      if (storeOverrides.listAggregatesShouldThrow) {
        return Promise.reject(new Error('forced-test-failure'));
      }
      return actual.listAggregates(...args);
    },
  };
});

// Hoisted stress-test vm override. The page-level print-disabled-while-running
// + header progress-bar/Recalculate swap key off `stressVm.isRunning`,
// which the real MC provider settles to `false` in jsdom; this toggle forces a
// running vm for those two assertions. `null` → pass through to the real hook.
const stressVmOverride = vi.hoisted<{
  value: import('../components/PlanStressTestSection').PlanStressTestVm | null;
}>(() => ({ value: null }));
vi.mock('../components/PlanStressTestSection', async () => {
  const actual = await vi.importActual<
    typeof import('../components/PlanStressTestSection')
  >('../components/PlanStressTestSection');
  return {
    ...actual,
    usePlanStressTestVm: (
      ...args: Parameters<typeof actual.usePlanStressTestVm>
    ) => {
      const real = actual.usePlanStressTestVm(...args);
      return stressVmOverride.value
        ? { ...real, ...stressVmOverride.value }
        : real;
    },
  };
});



import React from 'react';
import { BalanceProjectionPage } from './BalanceProjectionPage';
import { MonteCarloProvider } from '../monte-carlo/MonteCarloProvider';
import { withTheme } from '../test/theme-render';
import { renderOnce } from '../test/render-once';
import { REPO_URL } from '../lib/brand';

const GRANULARITY_KEY = 'retivo.balanceProjection.cashflowGranularity';
const INCOME_BREAKDOWN_GRANULARITY_KEY =
  'retivo.balanceProjection.incomeBreakdownGranularity';

// The page's charts read useChartColors() → need a ThemeProvider
// ancestor, exactly as the real app shell provides.
function pageElement(): React.ReactElement {
  return withTheme(
    'light',
    <MemoryRouter initialEntries={['/balance-projection']}>
      <MonteCarloProvider>
        <BalanceProjectionPage />
      </MonteCarloProvider>
    </MemoryRouter>,
  );
}

function renderPage(): ReturnType<typeof render> {
  return render(pageElement());
}

/** Seeds the demo workspace once and mounts the page once for a describe
 *  whose cases only read the rendered page. Returns the mounted container and
 *  a teardown for `afterAll`. */
async function mountSharedPage(): Promise<{
  container: HTMLElement;
  dispose: () => Promise<void>;
}> {
  await clearAllStores();
  await clearSelectedScenario();
  window.localStorage.clear();
  stressVmOverride.value = null;
  await loadDemoData({
    householdId: 'hh-test',
    email: 'demo@example.test',
    displayName: 'Demo User',
  });
  const mounted = renderOnce(pageElement());
  return {
    container: mounted.container,
    dispose: async () => {
      mounted.dispose();
      await clearAllStores();
      await clearSelectedScenario();
      window.localStorage.clear();
    },
  };
}

const SHARED_SETUP_TIMEOUT_MS = 30_000;

/**
 * Select the named view's tab. Content
 * tests that touch Cash flow / Accounts content select their tab as setup,
 * then go on asserting exactly what they asserted before the page grew tabs
 * — the default view is Overview, so a test that only touches Overview
 * content (the KPI grid, the Basis select's Monte Carlo outcomes, the
 * per-year chart, Stress-test outcomes) needs no tab switch.
 */
async function selectView(name: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name }, { timeout: 5000 }));
}

async function findGranularityGroup(): Promise<HTMLElement> {
  // The cashflow card owns this toggle (the income-breakdown card
  // owns a separate, independent one).
  return screen.findByRole(
    'radiogroup',
    { name: 'Cashflow chart granularity' },
    { timeout: 5000 },
  );
}

async function findIncomeBreakdownGranularityGroup(): Promise<HTMLElement> {
  return screen.findByRole(
    'radiogroup',
    { name: 'Income breakdown chart granularity' },
    { timeout: 5000 },
  );
}

describe('BalanceProjectionPage — chart granularity toggle', () => {
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

  it('renders a radiogroup with Yearly + Monthly, defaulting to Yearly', async () => {
    renderPage();
    // Expected cashflow lives on the Cash flow tab.
    await selectView('Cash flow');
    const group = await findGranularityGroup();
    const yearly = within(group).getByRole('radio', { name: 'Yearly' });
    const monthly = within(group).getByRole('radio', { name: 'Monthly' });
    expect(group).toContainElement(yearly);
    expect(group).toContainElement(monthly);
    // React Aria radios are native <input role="radio">; selected
    // state is the native `checked` (the HUI build used aria-checked).
    expect(yearly).toBeChecked();
    expect(monthly).not.toBeChecked();
  });

  it('persists the cashflow-card choice across a remount (localStorage round-trip)', async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await selectView('Cash flow');
    const group = await findGranularityGroup();
    // React Aria's RadioGroup press model requires the
    // user-event interaction driver, not fireEvent.
    await user.click(within(group).getByRole('radio', { name: 'Monthly' }));
    await waitFor(() =>
      expect(window.localStorage.getItem(GRANULARITY_KEY)).toBe('monthly'),
    );
    first.unmount();

    renderPage();
    // A remount resets the URL to `/balance-projection` (no `?view=`), so
    // the fresh page again defaults to Overview (no persistence).
    await selectView('Cash flow');
    const reopened = await findGranularityGroup();
    expect(within(reopened).getByRole('radio', { name: 'Monthly' })).toBeChecked();
    expect(
      within(reopened).getByRole('radio', { name: 'Yearly' }),
    ).not.toBeChecked();
  });

  it('keeps the cashflow + income-breakdown granularity toggles independent', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectView('Cash flow');
    const cashflowGroup = await findGranularityGroup();
    const incomeGroup = await findIncomeBreakdownGranularityGroup();
    // Both default to Yearly.
    expect(within(cashflowGroup).getByRole('radio', { name: 'Yearly' })).toBeChecked();
    expect(within(incomeGroup).getByRole('radio', { name: 'Yearly' })).toBeChecked();

    // Flip ONLY the cashflow card to Monthly; the income-breakdown card
    // stays Yearly (independent state — they may drift).
    await user.click(within(cashflowGroup).getByRole('radio', { name: 'Monthly' }));
    await waitFor(() =>
      expect(window.localStorage.getItem(GRANULARITY_KEY)).toBe('monthly'),
    );
    expect(within(cashflowGroup).getByRole('radio', { name: 'Monthly' })).toBeChecked();
    expect(within(incomeGroup).getByRole('radio', { name: 'Yearly' })).toBeChecked();
    // The income-breakdown key is untouched by the cashflow flip.
    expect(
      window.localStorage.getItem(INCOME_BREAKDOWN_GRANULARITY_KEY),
    ).toBe('yearly');

    // Now flip ONLY the income-breakdown card to Monthly.
    await user.click(within(incomeGroup).getByRole('radio', { name: 'Monthly' }));
    await waitFor(() =>
      expect(
        window.localStorage.getItem(INCOME_BREAKDOWN_GRANULARITY_KEY),
      ).toBe('monthly'),
    );
    expect(within(incomeGroup).getByRole('radio', { name: 'Monthly' })).toBeChecked();
    // Cashflow unchanged.
    expect(within(cashflowGroup).getByRole('radio', { name: 'Monthly' })).toBeChecked();
  });
});

describe('BalanceProjectionPage — header Basis selector + Monte Carlo outcomes', () => {
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    ({ dispose } = await mountSharedPage());
  }, SHARED_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await dispose();
  });

  it('renders the header Basis select and removes the buried per-account method tablist', async () => {
    // The Basis control is a React Aria Select (button trigger) named by
    // its visible "Basis" label. It drives the active method/percentile.
    const basis = await screen.findByRole(
      'button',
      { name: /Basis/i },
      { timeout: 5000 },
    );
    expect(basis).toBeInTheDocument();
    // The old buried per-account projection-method tab strip is gone — the
    // page's only tablist is the "Projection views" tab row 02 adds, and no
    // tab on it carries a projection-method label (Planned / TWR / Typical /
    // Pessimistic / Bad-luck).
    const tablists = screen.getAllByRole('tablist');
    expect(tablists).toHaveLength(1);
    expect(tablists[0]).toHaveAccessibleName('Projection views');
    const methodLabels = [
      'Planned',
      'Historical',
      'TWR',
      'Typical',
      'Pessimistic',
      'Bad-luck',
    ];
    for (const tab of screen.getAllByRole('tab')) {
      expect(methodLabels).not.toContain(tab.textContent);
    }
  });

  // The same-path stress comparison starts on its own, but only
  // once the page's PRIMARY run has settled for the plan on screen. Nothing
  // settles under jsdom (no real worker), so the section stands with its
  // heading and the "run the stress test first" note, and the four extra
  // 10,000-path runs are never dispatched.
  it('withholds the market-stress comparison until the page’s own run settles', async () => {
    expect(
      await screen.findByRole(
        'heading',
        { name: 'Compare against market stresses' },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('grid', { name: 'Market stress comparison' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/run the stress test first to compare your plan/i),
    ).toBeInTheDocument();
  });

  it('renders the Monte Carlo outcomes section heading + caption', async () => {
    expect(
      await screen.findByRole(
        'heading',
        { name: 'Monte Carlo outcomes' },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    // Each MC tier card renders its scope · tier header; the At retirement
    // + At horizon rows each carry Typical / Pessimistic / Bad-luck.
    await waitFor(() => {
      expect(screen.getByText('At retirement · Typical')).toBeInTheDocument();
      expect(screen.getByText('At horizon · Pessimistic')).toBeInTheDocument();
      expect(screen.getByText('At horizon · Bad-luck')).toBeInTheDocument();
    });
  });
});

describe('BalanceProjectionPage — header Basis selector (interaction)', () => {
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

  it('renders the Deterministic + Monte Carlo optgroups in the Basis select', async () => {
    const user = userEvent.setup();
    renderPage();
    const basis = await screen.findByRole(
      'button',
      { name: /Basis/i },
      { timeout: 5000 },
    );
    await user.click(basis);
    // The grouped listbox surfaces both optgroups + the Monte Carlo tier
    // options (Typical / Pessimistic / Bad-luck) beside the deterministic ones.
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Deterministic')).toBeInTheDocument();
    expect(within(listbox).getByText('Monte Carlo')).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: 'Typical' })).toBeInTheDocument();
    expect(
      within(listbox).getByRole('option', { name: 'Pessimistic' }),
    ).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: 'Bad-luck' })).toBeInTheDocument();
  });
});

const STRIPE_CLASSES = ['bg-surface-sunken'] as const;

/** Body rows of the first `<table>` inside the named landmark. */
function tbodyRows(landmarkLabel: string): HTMLTableRowElement[] {
  const region = screen.getByRole('region', { name: landmarkLabel });
  const table = region.querySelector('table');
  if (!table) throw new Error(`no <table> in "${landmarkLabel}"`);
  return Array.from(
    table.querySelectorAll<HTMLTableRowElement>('tbody > tr'),
  );
}

describe('BalanceProjectionPage — even-row zebra striping', () => {
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

  it('stripes the even (2nd) row of both the per-account breakdown and year-by-year tables', async () => {
    const user = userEvent.setup();
    renderPage();
    // Both tables live on the Accounts tab.
    await selectView('Accounts');

    // The per-account breakdown table is now collapsed behind a
    // disclosure button (Graphite Spectrum — both projection tables
    // collapse by default). Open it, then read its ≥ 2 demo-account
    // body rows from the "Per-account breakdown" landmark.
    await user.click(
      await screen.findByRole(
        'button',
        { name: 'Show account-by-account projection' },
        { timeout: 5000 },
      ),
    );
    const breakdownRows = await waitFor(
      () => {
        const region = screen.getByRole('region', {
          name: 'Per-account breakdown',
        });
        const table = region.querySelector('table');
        const rows = table
          ? Array.from(
              table.querySelectorAll<HTMLTableRowElement>('tbody > tr'),
            )
          : [];
        if (rows.length < 2) throw new Error('breakdown not ready');
        return rows;
      },
      { timeout: 5000 },
    );
    // 1-based even = 0-based index 1 (2nd row) carries the stripe;
    // the 1st row keeps the default surface.
    expect(breakdownRows[0].className).not.toContain('bg-surface-sunken');
    for (const cls of STRIPE_CLASSES) {
      expect(breakdownRows[1].className).toContain(cls);
    }

    // The year-by-year table is collapsed behind a disclosure button.
    await user.click(
      screen.getByRole('button', { name: 'Show year-by-year table' }),
    );
    const yearRows = await waitFor(
      () => {
        const rows = tbodyRows('Year-by-year projection table');
        if (rows.length < 2) throw new Error('year table not ready');
        return rows;
      },
      { timeout: 5000 },
    );
    expect(yearRows[0].className).not.toContain('bg-surface-sunken');
    for (const cls of STRIPE_CLASSES) {
      expect(yearRows[1].className).toContain(cls);
    }
  });
});

/** Parse a `$1,234` cell to a number. */
function dollars(text: string): number {
  return Number(text.replace(/[^0-9.-]/g, ''));
}

describe('BalanceProjectionPage — today-mode expense column reads entered real amount', () => {
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

  it("today's-dollars Expenses < future-dollars Expenses for a post-anchor year (real entered amount, not inflated nominal)", async () => {
    const user = userEvent.setup();
    renderPage();
    // The year-by-year table lives on the Accounts tab;
    // the Future-dollars toggle stays in the controls strip, reachable from
    // any tab. Default display mode is "Today's dollars". Open the
    // year-by-year table (collapsed behind a disclosure button).
    await selectView('Accounts');
    await user.click(
      await screen.findByRole(
        'button',
        { name: 'Show year-by-year table' },
        { timeout: 5000 },
      ),
    );
    const rowsToday = await waitFor(
      () => {
        const rows = tbodyRows('Year-by-year projection table');
        if (rows.length < 6) throw new Error('year table not ready');
        return rows;
      },
      { timeout: 5000 },
    );
    // Pick a mid-table cashflow row whose Expenses cell is a real
    // figure (not the pre-retirement "—"). Expenses is the 5th column
    // (Year, Earned, Withdrawal, Total income, Expenses, …).
    const expenseCellText = (tr: HTMLTableRowElement): string =>
      tr.querySelectorAll('td')[4]?.textContent ?? '';
    const target = rowsToday.find(
      (tr) => /\$/.test(expenseCellText(tr)) && dollars(expenseCellText(tr)) > 0,
    );
    if (!target) throw new Error('no cashflow row with an Expenses figure');
    const year = target.querySelector('td')!.textContent!;
    const todayExpense = dollars(expenseCellText(target));
    expect(todayExpense).toBeGreaterThan(0);

    // Flip to Future dollars: the SAME year's Expenses cell now carries
    // the nominal inflated figure → strictly larger than the entered
    // real amount (the today-mode value is no longer a deflated nominal
    // that would track it).
    await user.click(screen.getByRole('radio', { name: 'Future dollars' }));
    const futureExpense = await waitFor(
      () => {
        const rows = tbodyRows('Year-by-year projection table');
        const tr = rows.find(
          (r) => r.querySelector('td')?.textContent === year,
        );
        const v = tr ? dollars(expenseCellText(tr)) : 0;
        if (!(v > todayExpense)) throw new Error('future not yet larger');
        return v;
      },
      { timeout: 5000 },
    );
    expect(futureExpense).toBeGreaterThan(todayExpense);
  });
});

describe('BalanceProjectionPage — RA Table migration', () => {
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

  it('renders the per-account summary as an RA grid with compound column names', async () => {
    const user = userEvent.setup();
    renderPage();
    // Both breakdown tables live on the Accounts tab.
    await selectView('Accounts');
    // The per-account "Projected at retirement" summary is the
    // multi-row-colgroup table — it has single-row compound
    // names. It is now collapsed behind a disclosure button; open it
    // first. Concrete names assertedto keep the regex
    // deterministic.
    await user.click(
      await screen.findByRole(
        'button',
        { name: 'Show account-by-account projection' },
        { timeout: 5000 },
      ),
    );
    const grid = await screen.findByRole(
      'grid',
      { name: /Projected at retirement/ },
      { timeout: 5000 },
    );
    expect(grid).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Today' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Projected: Pre-tax' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Projected: Post-tax' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Projected: Total' }),
    ).toBeInTheDocument();
  });

  it('renders the totals row as the final Row with data-totals + the totals-tint utility class', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectView('Accounts');
    // The breakdown table is collapsed by default; open it first.
    await user.click(
      await screen.findByRole(
        'button',
        { name: 'Show account-by-account projection' },
        { timeout: 5000 },
      ),
    );
    // The legacy <tfoot> is gone; the totals row renders as the final
    // <Row> in <TableBody> with data-totals="true" + the tint+weight
    // utility class `rowTotalsClass`. The per-account breakdown table
    // is not inside <TableScroll>, so sticky-bottom would be inert
    // paint cost — the surrounding tint (`bg-surface-sunken`
    // + `font-semibold`) is what makes the row read as totals. RA's
    // `Row` does not forward `aria-label` to the rendered `<tr>`;
    // `data-totals` is the structural identifier.
    const region = await screen.findByRole(
      'region',
      { name: 'Per-account breakdown' },
      { timeout: 5000 },
    );
    await waitFor(() => {
      const totalsRow = region.querySelector('tr[data-totals="true"]');
      if (!totalsRow) throw new Error('totals row not rendered yet');
      // jsdom-safe className wiring check — the `rowTotalsClass` token
      // (`bg-surface-sunken font-semibold`) ships the tint + weight as a
      // single utility string. Paint behavior is covered by a manual
      // visual check.
      expect(totalsRow.className).toMatch(/font-semibold/);
      expect(totalsRow.className).toMatch(/bg-surface-sunken/);
    });
  });

  it('renders the year-by-year table with sticky-top columns + RA Tooltip header trigger', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectView('Accounts');
    // Year-by-year is collapsed behind a disclosure button.
    await user.click(
      await screen.findByRole(
        'button',
        { name: 'Show year-by-year table' },
        { timeout: 5000 },
      ),
    );
    const grid = await screen.findByRole(
      'grid',
      { name: 'Year-by-year projection' },
      { timeout: 5000 },
    );
    expect(grid).toBeInTheDocument();
    // Scope to this grid: the "Taxes & health costs" sub-table also
    // carries a "Year" column, so a page-wide query is now ambiguous.
    const gridScope = within(grid);
    // The Year column carries the sticky-top utility class (jsdom
    // verifies className wiring even without painting). The full
    // arrow-key keyboard model is jsdom-brittle and covered by the
    // manual keyboard check.
    const yearHeader = gridScope.getByRole('columnheader', { name: 'Year' });
    expect(yearHeader.className).toContain('sticky');
    expect(yearHeader.className).toContain('top-0');
    // RA Tooltip header triggers reveal the help text via
    // aria-describedby — the Earned column's accessible name stays
    // "Earned" (the tooltip body lives in a separate <Tooltip>).
    expect(
      gridScope.getByRole('columnheader', { name: 'Earned' }),
    ).toBeInTheDocument();
  });
});

describe('BalanceProjectionPage — projection method explainer', () => {
  afterEach(async () => {
    await clearAllStores();
    window.localStorage.clear();
  });

  it('renders the explainer trigger in the page header above the stat rows and opens its dialog', async () => {
    const user = userEvent.setup();
    await clearAllStores();
    window.localStorage.clear();
    await loadDemoData({
      householdId: 'hh-test',
      email: 'demo@example.test',
      displayName: 'Demo User',
    });
    renderPage();

    const trigger = await screen.findByRole(
      'button',
      { name: 'What do these mean?' },
      { timeout: 5000 },
    );
    // Acceptance criterion: the trigger renders in the controls strip,
    // ahead of the deterministic KPI grid (Overview tab, selected by
    // default). Assert DOM order, not mere
    // co-presence — `trigger` must precede the stat element in document
    // order (DOCUMENT_POSITION_FOLLOWING ⇒ stat follows it). The KPI
    // tile label is now "Planned · at retirement" (Graphite Spectrum
    // 4-up grid), not the prior "At retirement — Planned".
    const stat = screen.getByText(/Planned · at retirement/);
    expect(
      trigger.compareDocumentPosition(stat) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(trigger);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('How to read these figures');
  });

  it('does not render the trigger in a resolved no-projection state', async () => {
    // Loaded-but-no-projection: seed the full demo workspace (valid
    // scenario + retirement age + selected scenario), then delete
    // every account. The page now *resolves* (`data` non-null) but
    // has no projectable rows, so it renders the settled
    // "Add an account to see projections." empty state — NOT the
    // transient `Loading…`. The page returns early at the
    // no-accounts guard, before the main view that hosts the header
    // explainer, so the trigger must not render.
    await clearAllStores();
    window.localStorage.clear();
    await loadDemoData({
      householdId: 'hh-test',
      email: 'demo@example.test',
      displayName: 'Demo User',
    });
    const accounts = await listAggregates('account');
    await Promise.all(
      accounts.map((a) => deleteAggregateLocally('account', a.id)),
    );
    renderPage();

    expect(
      await screen.findByText('Add an account to see projections.', undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'What do these mean?' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Planned · at retirement/)).not.toBeInTheDocument();
  });
});

describe('BalanceProjectionPage — page heading shows active scenario name', () => {
  beforeEach(async () => {
    await clearAllStores();
    // `clearAllStores` does not touch the `selectedScenario`
    // singleton store, so a prior test's `writeSelectedScenario`
    // would carry across and the default Base scenario assertion
    // would fail with the prior test's selection.
    await clearSelectedScenario();
    window.localStorage.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearAllStores();
    await clearSelectedScenario();
    window.localStorage.clear();
  });

  it('shows "Balance Projection - Scenario: <name>" once the selected scenario resolves', async () => {
    await loadDemoData({
      householdId: 'hh-test',
      email: 'demo@example.test',
      displayName: 'Demo User',
    });
    renderPage();

    // Demo loader names the base (selected-by-default) scenario "Base".
    const heading = await screen.findByRole(
      'heading',
      { level: 1, name: 'Balance Projection - Scenario: Base' },
      { timeout: 5000 },
    );
    expect(heading.textContent).toBe('Balance Projection - Scenario: Base');
    // a11y wiring preserved: the inner <span> still carries the
    // landmark id every <section aria-labelledby> path depends on.
    expect(heading.querySelector('#balance-projection-heading')).not.toBeNull();
  });

  it('falls back to bare "Balance Projection" on the first-paint !data branch (no demo loaded)', async () => {
    // No demo seed → the page's IDB-read effect resolves to
    // `scenarioRows.length === 0` → `setData(null)`. The synchronous
    // initial render also sees `data === null`. Either way the !data
    // branch fires and the heading reads bare. Assert synchronously
    // on the first paint, then `waitFor` flushes the pending effect
    // updates inside React's act window so the resolved-empty state
    // does not leak as an unwrapped update warning.
    renderPage();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Balance Projection');
    expect(heading.querySelector('#balance-projection-heading')).not.toBeNull();
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        'Balance Projection',
      );
    });
  });

  it('keeps the scenario suffix on the no-retirement-age branch', async () => {
    await loadDemoData({
      householdId: 'hh-test',
      email: 'demo@example.test',
      displayName: 'Demo User',
    });
    // Strip the retirementAge override off the base scenario so
    // `resolved.retirementAge` is undefined and the page returns
    // early via the "Set a retirement age" branch — which still
    // renders the heading.
    const scenarios = (await listAggregates('scenario')) as Aggregate<ScenarioPayload>[];
    const base = scenarios.find((s) => s.payload.isPrimary);
    if (!base) throw new Error('demo loader did not seed a primary scenario');
    const stripped: Aggregate<ScenarioPayload> = {
      ...base,
      payload: { ...base.payload, overrides: {} },
    };
    await putAggregate('scenario', stripped);

    renderPage();

    const heading = await screen.findByRole(
      'heading',
      { level: 1, name: 'Balance Projection - Scenario: Base' },
      { timeout: 5000 },
    );
    // The "Set a retirement age" CTA proves we are on the
    // no-retirement-age branch, not the main view.
    expect(
      await screen.findByText('Set a retirement age on this scenario to project.'),
    ).toBeInTheDocument();
    expect(heading.textContent).toBe('Balance Projection - Scenario: Base');
  });

  it('updates the heading live when the selected scenario changes', async () => {
    await loadDemoData({
      householdId: 'hh-test',
      email: 'demo@example.test',
      displayName: 'Demo User',
    });
    renderPage();

    await screen.findByRole(
      'heading',
      { level: 1, name: 'Balance Projection - Scenario: Base' },
      { timeout: 5000 },
    );

    // Switch to the "Retire early at 62" alternate (seeded by the
    // demo loader) the same way SidebarScenarioPicker does — write
    // the singleton, then fire the picker event.
    const scenarios = (await listAggregates('scenario')) as Aggregate<ScenarioPayload>[];
    const next = scenarios.find((s) => s.payload.name === 'Retire early at 62');
    if (!next) throw new Error('demo loader did not seed "Retire early at 62"');
    await writeSelectedScenario({
      scenarioId: next.id,
      updatedAt: new Date().toISOString(),
    });
    await act(async () => {
      window.dispatchEvent(new Event(SELECTED_SCENARIO_CHANGED_EVENT));
    });

    await screen.findByRole(
      'heading',
      { level: 1, name: 'Balance Projection - Scenario: Retire early at 62' },
      { timeout: 5000 },
    );
  });

  it('keeps the prior scenario suffix when a reload fails after a previous success', async () => {
    await loadDemoData({
      householdId: 'hh-test',
      email: 'demo@example.test',
      displayName: 'Demo User',
    });
    renderPage();
    await screen.findByRole(
      'heading',
      { level: 1, name: 'Balance Projection - Scenario: Base' },
      { timeout: 5000 },
    );

    // Force the next reload to throw via the hoisted toggle. The reactive
    // `useAggregates` read rejects; the hook surfaces the error but keeps its
    // prior `aggregates`, so the combined `error` shows "Failed to load
    // projection data." while `scenarios` (and the resolved selected scenario)
    // stay put — the heading must keep its prior suffix (a stale suffix is
    // preferable to a bare title while the user looks at an error tied to a
    // specific scenario). A coarse `WORKSPACE_CHANGED_EVENT` (the bulk-fill
    // re-read trigger the reactive layer listens to) drives the failing
    // re-read.
    storeOverrides.listAggregatesShouldThrow = true;
    try {
      await act(async () => {
        notifyWorkspaceChanged();
      });

      await screen.findByText('Failed to load projection data.', undefined, {
        timeout: 5000,
      });

      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading.textContent).toBe('Balance Projection - Scenario: Base');
      expect(heading.querySelector('#balance-projection-heading')).not.toBeNull();
    } finally {
      storeOverrides.listAggregatesShouldThrow = false;
    }
  });
});

describe('NoHistoryState — page-level wiring', () => {
  beforeEach(async () => {
    await clearAllStores();
    await clearSelectedScenario();
    window.localStorage.clear();
  });

  afterEach(async () => {
    await clearAllStores();
    await clearSelectedScenario();
    window.localStorage.clear();
  });

  it('renders the NoHistoryState when the portfolio has only all-zero balance rows', async () => {
    // Seed the full demo workspace (valid scenario + retirement age + selected
    // scenario + accounts), then overwrite EVERY accountBalance row with an
    // all-zero seed payload so `hasAnyRealBalance` is false while the accounts
    // still project (rows.length > 0, hiddenZeroHistoryCount > 0). The page
    // therefore falls through the no-account guard to the `!hasAnyRealBalance`
    // branch (line 355) and must render BalanceProjectionNoHistoryState.
    await loadDemoData({
      householdId: 'hh-test',
      email: 'demo@example.test',
      displayName: 'Demo User',
    });

    const balances = (await listAggregates(
      'accountBalance',
    )) as Aggregate<AccountBalancePayload>[];
    expect(balances.length).toBeGreaterThan(0);
    await Promise.all(
      balances.map((b) =>
        putAggregate('accountBalance', {
          ...b,
          payload: {
            ...b.payload,
            startingBalance: 0,
            startingBalancePreTax: null,
            startingBalancePostTax: null,
            contributionsPreTax: null,
            contributionsPostTax: null,
            companyContributions: 0,
            companyContributionsPreTax: null,
            companyContributionsPostTax: null,
            rollover: 0,
            distributions: 0,
            endingBalance: 0,
            endingBalancePreTax: null,
            endingBalancePostTax: null,
            totalContributions: 0,
          },
        }),
      ),
    );

    renderPage();

    expect(
      await screen.findByText(
        'Enter at least one year of balance for an account to see projections.',
        undefined,
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  });
});

describe('BalanceProjectionPage — print header + calc-state (read-only)', () => {
  let sharedContainer: HTMLElement;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    ({ container: sharedContainer, dispose } = await mountSharedPage());
  }, SHARED_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await dispose();
  });

  it('shows the Recalculate button (not the progress bar) in the header when idle', async () => {
    // Once the auto-run settles (idle/done), the header shows Recalculate.
    expect(
      await screen.findByRole(
        'button',
        { name: 'Recalculate the example projection' },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  });

  it("shows \"Values in today's dollars (inflation-adjusted)\" in the print header block by default", async () => {
    // Default displayMode = 'today'; the bp-print-header div is always mounted.
    expect(
      await screen.findByText(
        "Values in today's dollars (inflation-adjusted)",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  });

  it('renders the repo address and the open-source link inside the print-only header', async () => {
    const container = sharedContainer;
    // Wait for the full projection state (the Print button only renders there,
    // alongside the print-only header).
    await screen.findByRole(
      'button',
      { name: 'Print / Save as PDF' },
      { timeout: 5000 },
    );
    const printHeader = container.querySelector('.bp-print-header');
    expect(printHeader).not.toBeNull();
    expect(printHeader!.textContent).toContain(`Created with Retivo · ${REPO_URL}`);
    // The clickable open-source link is scoped to the print header.
    const link = printHeader!.querySelector(`a[href="${REPO_URL}"]`);
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe('RETIVO is open source');
  });
});

describe('BalanceProjectionPage — print button + calc-state header', () => {
  beforeEach(async () => {
    await clearAllStores();
    await clearSelectedScenario();
    window.localStorage.clear();
    stressVmOverride.value = null;
    await loadDemoData({
      householdId: 'hh-test',
      email: 'demo@example.test',
      displayName: 'Demo User',
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    stressVmOverride.value = null;
    await clearAllStores();
    await clearSelectedScenario();
    window.localStorage.clear();
  });

  it('renders the Print / Save as PDF button and calls window.print() on press', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderPage();
    const printBtn = await screen.findByRole(
      'button',
      { name: 'Print / Save as PDF' },
      { timeout: 5000 },
    );
    expect(printBtn).toBeInTheDocument();
    await user.click(printBtn);
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('mounts all four collapsible tables collapsed by default', async () => {
    renderPage();
    // Both breakdown tables live on the Accounts tab.
    await selectView('Accounts');
    // The default-collapsed state lives in the page's useState(false) flags;
    // every disclosure reads "Show …", and none of the four tables' grids are
    // in the a11y tree.
    expect(
      await screen.findByRole(
        'button',
        { name: 'Show account-by-account projection' },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Show year-by-year table' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('grid', { name: /Projected at retirement/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('grid', { name: 'Year-by-year projection' }),
    ).not.toBeInTheDocument();
  });

  it('disables the Print button + swaps Recalculate for the header progress bar while the stress calc runs', async () => {
    // Force a running stress vm so the gated states are deterministic.
    stressVmOverride.value = {
      isRunning: true,
      progressDone: 1,
      progressTotal: 10_000,
    } as import('../components/PlanStressTestSection').PlanStressTestVm;
    renderPage();
    const printBtn = await screen.findByRole(
      'button',
      { name: 'Print / Save as PDF' },
      { timeout: 5000 },
    );
    // React Aria reflects `isDisabled` as the native `disabled` attribute.
    expect(printBtn).toBeDisabled();
    // The header shows the running progress bar (role="status") in place of the
    // Recalculate button while the run is in flight.
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Recalculate the example projection' }),
    ).not.toBeInTheDocument();
  });

  it('shows "Values in future nominal dollars" in the print header block when Future dollars selected', async () => {
    const user = userEvent.setup();
    renderPage();
    // Wait for page to settle.
    await screen.findByRole('button', { name: 'Print / Save as PDF' }, { timeout: 5000 });
    // Click the Future-dollars radio to toggle displayMode to 'future'.
    const futureRadio = screen.getByRole('radio', { name: 'Future dollars' });
    await user.click(futureRadio);
    expect(
      screen.getByText('Values in future nominal dollars'),
    ).toBeInTheDocument();
  });

  it('shows the error status row (not Recalculate) in the header when the stress run has errored', async () => {
    stressVmOverride.value = {
      isRunning: false,
      progressDone: 0,
      progressTotal: 0,
      error: 'Stress run failed: test error',
      result: null,
    } as import('../components/PlanStressTestSection').PlanStressTestVm;
    renderPage();
    await screen.findByRole('button', { name: 'Print / Save as PDF' }, { timeout: 5000 });
    // When errored and !isRunning, the "Projection controls" group should
    // render PlanStressTestStatusRow, whose error branch is a role="alert"
    // toast — not the Recalculate button. Scope to that group (it is
    // no longer inside <header>) to disambiguate from the print-only error
    // notice (also role="alert") rendered inside the stress-test card.
    const controls = screen.getByRole('group', { name: 'Projection controls' });
    const alert = within(controls).getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent('Stress-test failed: Stress run failed: test error');
    expect(
      screen.queryByRole('button', { name: 'Recalculate the example projection' }),
    ).not.toBeInTheDocument();
    // The print-only error notice surfaces the failure reason inside the
    // stress-test card so the printout is not blank (it is screen-hidden).
    const stressRegion = screen.getByRole('region', { name: 'Stress-test outcomes' });
    expect(
      within(stressRegion).getByText('Stress-test failed: Stress run failed: test error'),
    ).toBeInTheDocument();
    // The error state is not isRunning, so Print stays pressable.
    expect(
      screen.getByRole('button', { name: 'Print / Save as PDF' }),
    ).not.toBeDisabled();
  });
});
