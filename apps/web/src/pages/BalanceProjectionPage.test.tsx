// BalanceProjectionPage wiring over the demo workspace: granularity toggles, Basis selector, tables, heading, print and calc-state header.
import 'fake-indexeddb/auto';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteAggregateLocally,
  listAggregates,
  putAggregate,
  writeSelectedScenario,
} from '../db/store';
import { SELECTED_SCENARIO_CHANGED_EVENT } from '../lib/scenario-mutations';
import { notifyWorkspaceChanged } from '../lib/workspace-events';
import type {
  AccountBalancePayload,
  Aggregate,
  ScenarioPayload,
} from '../db/types';

// Hoisted fault toggle, flipped by the error-after-prior-success test to make the next page reload throw; other tests pass through.
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

// Hoisted stress-vm override: the real MC provider settles `isRunning` to false in jsdom, so this forces a running vm; `null` passes through to the real hook.
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



import {
  loadDemo,
  mountSharedPage,
  renderPage,
  resetWorkspace,
  seedDemo,
} from './balance-projection-page.test-harness';
import { REPO_URL } from '../lib/brand';

const GRANULARITY_KEY = 'retivo.balanceProjection.cashflowGranularity';
const INCOME_BREAKDOWN_GRANULARITY_KEY =
  'retivo.balanceProjection.incomeBreakdownGranularity';

const SHARED_SETUP_TIMEOUT_MS = 30_000;

// Selects the tab as test setup; the default view is Overview, so Overview-only tests need no switch.
async function selectView(name: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name }, { timeout: 5000 }));
}

async function findGranularityGroup(): Promise<HTMLElement> {
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
  beforeEach(seedDemo);

  afterEach(resetWorkspace);

  it('renders a radiogroup with Yearly + Monthly, defaulting to Yearly', async () => {
    renderPage();
    await selectView('Cash flow');
    const group = await findGranularityGroup();
    const yearly = within(group).getByRole('radio', { name: 'Yearly' });
    const monthly = within(group).getByRole('radio', { name: 'Monthly' });
    expect(group).toContainElement(yearly);
    expect(group).toContainElement(monthly);
    // React Aria radios are native `<input role="radio">`; selected state is the native `checked`.
    expect(yearly).toBeChecked();
    expect(monthly).not.toBeChecked();
  });

  it('persists the cashflow-card choice across a remount (localStorage round-trip)', async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await selectView('Cash flow');
    const group = await findGranularityGroup();
    // React Aria's RadioGroup press model needs the user-event driver, not fireEvent.
    await user.click(within(group).getByRole('radio', { name: 'Monthly' }));
    await waitFor(() =>
      expect(window.localStorage.getItem(GRANULARITY_KEY)).toBe('monthly'),
    );
    first.unmount();

    renderPage();
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
    expect(within(cashflowGroup).getByRole('radio', { name: 'Yearly' })).toBeChecked();
    expect(within(incomeGroup).getByRole('radio', { name: 'Yearly' })).toBeChecked();

    await user.click(within(cashflowGroup).getByRole('radio', { name: 'Monthly' }));
    await waitFor(() =>
      expect(window.localStorage.getItem(GRANULARITY_KEY)).toBe('monthly'),
    );
    expect(within(cashflowGroup).getByRole('radio', { name: 'Monthly' })).toBeChecked();
    expect(within(incomeGroup).getByRole('radio', { name: 'Yearly' })).toBeChecked();
    expect(
      window.localStorage.getItem(INCOME_BREAKDOWN_GRANULARITY_KEY),
    ).toBe('yearly');

    await user.click(within(incomeGroup).getByRole('radio', { name: 'Monthly' }));
    await waitFor(() =>
      expect(
        window.localStorage.getItem(INCOME_BREAKDOWN_GRANULARITY_KEY),
      ).toBe('monthly'),
    );
    expect(within(incomeGroup).getByRole('radio', { name: 'Monthly' })).toBeChecked();
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
    const basis = await screen.findByRole(
      'button',
      { name: /Basis/i },
      { timeout: 5000 },
    );
    expect(basis).toBeInTheDocument();
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

  // The comparison starts only once the page's primary run has settled; nothing settles under jsdom (no real worker), so the extra runs are never dispatched.
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
    await waitFor(() => {
      expect(screen.getByText('At retirement · Typical')).toBeInTheDocument();
      expect(screen.getByText('At horizon · Pessimistic')).toBeInTheDocument();
      expect(screen.getByText('At horizon · Bad-luck')).toBeInTheDocument();
    });
  });
});

describe('BalanceProjectionPage — header Basis selector (interaction)', () => {
  beforeEach(seedDemo);

  afterEach(resetWorkspace);

  it('renders the Deterministic + Monte Carlo optgroups in the Basis select', async () => {
    const user = userEvent.setup();
    renderPage();
    const basis = await screen.findByRole(
      'button',
      { name: /Basis/i },
      { timeout: 5000 },
    );
    await user.click(basis);
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

function tbodyRows(landmarkLabel: string): HTMLTableRowElement[] {
  const region = screen.getByRole('region', { name: landmarkLabel });
  const table = region.querySelector('table');
  if (!table) throw new Error(`no <table> in "${landmarkLabel}"`);
  return Array.from(
    table.querySelectorAll<HTMLTableRowElement>('tbody > tr'),
  );
}

describe('BalanceProjectionPage — even-row zebra striping', () => {
  beforeEach(seedDemo);

  afterEach(resetWorkspace);

  it('stripes the even (2nd) row of both the per-account breakdown and year-by-year tables', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectView('Accounts');

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
    expect(breakdownRows[0].className).not.toContain('bg-surface-sunken');
    for (const cls of STRIPE_CLASSES) {
      expect(breakdownRows[1].className).toContain(cls);
    }

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

function dollars(text: string): number {
  return Number(text.replace(/[^0-9.-]/g, ''));
}

describe('BalanceProjectionPage — today-mode expense column reads entered real amount', () => {
  beforeEach(seedDemo);

  afterEach(resetWorkspace);

  it("today's-dollars Expenses < future-dollars Expenses for a post-anchor year (real entered amount, not inflated nominal)", async () => {
    const user = userEvent.setup();
    renderPage();
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
    // Expenses is the 5th column (Year, Earned, Withdrawal, Total income, Expenses, …).
    const expenseCellText = (tr: HTMLTableRowElement): string =>
      tr.querySelectorAll('td')[4]?.textContent ?? '';
    const target = rowsToday.find(
      (tr) => /\$/.test(expenseCellText(tr)) && dollars(expenseCellText(tr)) > 0,
    );
    if (!target) throw new Error('no cashflow row with an Expenses figure');
    const year = target.querySelector('td')!.textContent!;
    const todayExpense = dollars(expenseCellText(target));
    expect(todayExpense).toBeGreaterThan(0);

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
  beforeEach(seedDemo);

  afterEach(resetWorkspace);

  it('renders the per-account summary as an RA grid with compound column names', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectView('Accounts');
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
    await user.click(
      await screen.findByRole(
        'button',
        { name: 'Show account-by-account projection' },
        { timeout: 5000 },
      ),
    );
    // The totals row is the final `<Row>` with `data-totals="true"` and `rowTotalsClass`; the table is not inside `<TableScroll>`, so sticky-bottom would be inert.
    const region = await screen.findByRole(
      'region',
      { name: 'Per-account breakdown' },
      { timeout: 5000 },
    );
    await waitFor(() => {
      const totalsRow = region.querySelector('tr[data-totals="true"]');
      if (!totalsRow) throw new Error('totals row not rendered yet');
      // jsdom-safe className check: paint behaviour is covered by a manual visual check.
      expect(totalsRow.className).toMatch(/font-semibold/);
      expect(totalsRow.className).toMatch(/bg-surface-sunken/);
    });
  });

  it('renders the year-by-year table with sticky-top columns + RA Tooltip header trigger', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectView('Accounts');
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
    // Scoped to this grid: the "Taxes & health costs" sub-table also has a "Year" column.
    const gridScope = within(grid);
    // jsdom verifies className wiring without painting; the full arrow-key model is jsdom-brittle.
    const yearHeader = gridScope.getByRole('columnheader', { name: 'Year' });
    expect(yearHeader.className).toContain('sticky');
    expect(yearHeader.className).toContain('top-0');
    // React Aria Tooltip triggers reveal help text via aria-describedby, so the Earned column's accessible name stays "Earned".
    expect(
      gridScope.getByRole('columnheader', { name: 'Earned' }),
    ).toBeInTheDocument();
  });
});

describe('BalanceProjectionPage — projection method explainer', () => {
  afterEach(resetWorkspace);

  it('renders the explainer trigger in the page header above the stat rows and opens its dialog', async () => {
    const user = userEvent.setup();
    await seedDemo();
    renderPage();

    const trigger = await screen.findByRole(
      'button',
      { name: 'What do these mean?' },
      { timeout: 5000 },
    );
    // Assert DOM order, not co-presence: the trigger must precede the KPI stat in the document.
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
    // Seed the demo workspace, then delete every account: the page resolves with no projectable rows and shows the settled empty state, not the transient `Loading…`, returning before the main view that hosts the explainer.
    await seedDemo();
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
  beforeEach(resetWorkspace);

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetWorkspace();
  });

  it('shows "Balance Projection - Scenario: <name>" once the selected scenario resolves', async () => {
    await loadDemo();
    renderPage();

    const heading = await screen.findByRole(
      'heading',
      { level: 1, name: 'Balance Projection - Scenario: Base' },
      { timeout: 5000 },
    );
    expect(heading.textContent).toBe('Balance Projection - Scenario: Base');
    // The inner span still carries the landmark id every `<section aria-labelledby>` path depends on.
    expect(heading.querySelector('#balance-projection-heading')).not.toBeNull();
  });

  it('falls back to bare "Balance Projection" on the first-paint !data branch (no demo loaded)', async () => {
    // With no demo seed `data` is null on first paint and after the IDB read. Assert synchronously, then `waitFor` flushes the pending effect inside act so the resolved-empty state does not leak an unwrapped update warning.
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
    await loadDemo();
    // Strip the retirementAge override so the page returns early via the "Set a retirement age" branch, which still renders the heading.
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
    expect(
      await screen.findByText('Set a retirement age on this scenario to project.'),
    ).toBeInTheDocument();
    expect(heading.textContent).toBe('Balance Projection - Scenario: Base');
  });

  it('updates the heading live when the selected scenario changes', async () => {
    await loadDemo();
    renderPage();

    await screen.findByRole(
      'heading',
      { level: 1, name: 'Balance Projection - Scenario: Base' },
      { timeout: 5000 },
    );

    // Switch to the "Retire early at 62" alternate the way SidebarScenarioPicker does: write the singleton, then fire the picker event.
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
    await loadDemo();
    renderPage();
    await screen.findByRole(
      'heading',
      { level: 1, name: 'Balance Projection - Scenario: Base' },
      { timeout: 5000 },
    );

    // Force the next reload to throw: the reactive read rejects but the hook keeps its prior aggregates, so the heading keeps its prior suffix (stale beats a bare title beside an error tied to a scenario). A WORKSPACE_CHANGED_EVENT drives the failing re-read.
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
  beforeEach(resetWorkspace);

  afterEach(resetWorkspace);

  it('renders the NoHistoryState when the portfolio has only all-zero balance rows', async () => {
    // Overwrite every accountBalance row with an all-zero payload so `hasAnyRealBalance` is false while accounts still project; the page must fall through to `BalanceProjectionNoHistoryState`.
    await loadDemo();

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
    expect(
      await screen.findByRole(
        'button',
        { name: 'Recalculate the example projection' },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  });

  it("shows \"Values in today's dollars (inflation-adjusted)\" in the print header block by default", async () => {
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
    await screen.findByRole(
      'button',
      { name: 'Print / Save as PDF' },
      { timeout: 5000 },
    );
    const printHeader = container.querySelector('.bp-print-header');
    expect(printHeader).not.toBeNull();
    expect(printHeader!.textContent).toContain(`Created with Retivo · ${REPO_URL}`);
    const link = printHeader!.querySelector(`a[href="${REPO_URL}"]`);
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe('RETIVO is open source');
  });
});

describe('BalanceProjectionPage — print button + calc-state header', () => {
  beforeEach(async () => {
    stressVmOverride.value = null;
    await seedDemo();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    stressVmOverride.value = null;
    await resetWorkspace();
  });

  it('renders the Print / Save as PDF button and calls window.print() on press', async () => {
    // Print is disabled while the stress run is in flight; the real run starts ~800 ms after mount (auto-run debounce) and never finishes in jsdom (the Worker stub never replies), so on a slow machine the click would land on a disabled button.
    stressVmOverride.value = {
      isRunning: false,
    } as import('../components/PlanStressTestSection').PlanStressTestVm;
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
    await selectView('Accounts');
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
    expect(printBtn).toBeDisabled();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Recalculate the example projection' }),
    ).not.toBeInTheDocument();
    const progressbar = screen.getByRole('progressbar');
    expect(screen.getByRole('group', { name: 'Projection controls' })).toContainElement(progressbar);
    expect(screen.getByRole('region', { name: 'Stress-test outcomes' })).not.toContainElement(progressbar);
  });

  it('shows "Values in future nominal dollars" in the print header block when Future dollars selected', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: 'Print / Save as PDF' }, { timeout: 5000 });
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
    // Scope to the "Projection controls" group to disambiguate from the print-only error notice, also role="alert", inside the stress-test card.
    const controls = screen.getByRole('group', { name: 'Projection controls' });
    const alert = within(controls).getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent('Stress-test failed: Stress run failed: test error');
    expect(
      screen.queryByRole('button', { name: 'Recalculate the example projection' }),
    ).not.toBeInTheDocument();
    const stressRegion = screen.getByRole('region', { name: 'Stress-test outcomes' });
    expect(
      within(stressRegion).getByText('Stress-test failed: Stress run failed: test error'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Print / Save as PDF' }),
    ).not.toBeDisabled();
  });
});
