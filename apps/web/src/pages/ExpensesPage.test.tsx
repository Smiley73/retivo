/**
 * ExpensesPage empty-state render test.
 *
 * Locks the single-CTA empty state: with an empty expenses store the
 * page shows the "No expenses yet" helper copy and the ONLY "Add"
 * call-to-action is the PageHeader primary action — there is no
 * in-card Add button duplicating it. Drives IndexedDB through
 * fake-indexeddb; Auth/Sync mocked at the module boundary, theme
 * supplied via the shared ThemeProvider seam (the page body reads
 * `useTheme()`).
 */
import 'fake-indexeddb/auto';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  clearSelectedScenario,
  putAggregate,
  writeSelectedScenario,
} from '../db/store';
import { notifySelectedScenarioChanged } from '../lib/scenario-mutations';
import type {
  Aggregate,
  ExpenseCategoryPayload,
  ExpensePayload,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';
import { withTheme } from '../test/theme-render';
import { EXPENSES_DISPLAY_MODE_STORAGE_KEY } from './ExpensesPage';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

// The real chart lazy-loads recharts into a `ResponsiveContainer`, which
// jsdom sizes to 0×0 — so it paints no measurable geometry and the
// projection rows never reach the DOM. Mock the "Total expenses" section
// with a thin stand-in that keeps the heading the page tests query AND
// renders the data the page actually fed it (the sum of every projected
// monthly run-rate) as text in a stable testid. That sum is the pure
// product of the resolved inflation rate, so an assertion against it
// proves the projection engine received the active display mode — not
// just that a radio's checked-state markup flipped.
vi.mock('./expenses-projection-section', () => ({
  ExpensesProjectionSection: (props: {
    rows: ReadonlyArray<{ total: number }>;
    tabs?: React.ReactNode;
  }) => {
    const sum = props.rows.reduce((acc, r) => acc + r.total, 0);
    return (
      <section aria-labelledby="expenses-total-heading">
        <h2 id="expenses-total-heading">Total expenses</h2>
        <span data-testid="chart-total-sum">{sum}</span>
        {props.tabs}
      </section>
    );
  },
}));

import React from 'react';
import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { ExpensesPage } from './ExpensesPage';

const HH = 'hh-test';

function setupContexts(): void {
  (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    householdId: HH,
    me: { email: 'me@example.test', displayName: 'Me', roles: [], userId: 'u-1' },
    isAuthenticated: true,
  });
  (useSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    notifyPending: vi.fn(),
    state: { kind: 'synced', lastSyncedAt: null },
  });
}

function renderPage(): ReturnType<typeof render> {
  return render(
    withTheme(
      'light',
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    ),
  );
}

async function seedMember(): Promise<void> {
  const m: Aggregate<HouseholdMemberPayload> = {
    id: 'hm-1',
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary: true,
      firstName: 'Alex',
      lastName: 'Primary',
      email: 'alex@example.test',
      birthdate: '1985-04-15',
    },
  };
  await putAggregate('householdMember', m);
}

async function seedCategory(): Promise<void> {
  const c: Aggregate<ExpenseCategoryPayload> = {
    id: 'cat-1',
    householdId: HH,
    aggregateType: 'expenseCategory',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: { name: 'Housing' },
  };
  await putAggregate('expenseCategory', c);
}

async function seedScenario(
  id: string,
  overrides: ScenarioPayload['overrides'],
): Promise<void> {
  const s: Aggregate<ScenarioPayload> = {
    id,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'Base',
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides,
    },
  };
  await putAggregate('scenario', s);
}

async function seedExpense(
  overrides: Partial<ExpensePayload> = {},
  id = 'exp-1',
): Promise<void> {
  const e: Aggregate<ExpensePayload> = {
    id,
    householdId: HH,
    aggregateType: 'expense',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'Groceries',
      amount: 1000,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: 'cat-1',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'primary' },
      ...overrides,
    },
  };
  await putAggregate('expense', e);
}

/** Seed a full chart-renderable household: member + category + one
 *  monthly expense + a primary scenario carrying `ratePct` inflation,
 *  with that scenario selected. The chart card (and its display-unit
 *  toggle) only renders when the projection has rows. */
async function seedChartHousehold(ratePct = 3): Promise<void> {
  await seedMember();
  await seedCategory();
  await seedExpense();
  await seedScenario('scn-base', {
    retirementAge: { primary: { ageYears: 60, ageMonths: 0 } },
    inflation: { ratePct },
  });
  await writeSelectedScenario({
    scenarioId: 'scn-base',
    updatedAt: '2026-05-01T00:00:00Z',
  });
}

/**
 * Render the page at a given path, optionally seeding the MemoryRouter
 * with `initialEntries` so focus-restore tests can land at
 * `/expenses?focusExpenseId=<id>`.
 */
function renderPageAt(path = '/expenses'): ReturnType<typeof render> {
  return render(
    withTheme(
      'light',
      <MemoryRouter initialEntries={[path]}>
        <ExpensesPage />
      </MemoryRouter>,
    ),
  );
}

describe('ExpensesPage — empty state', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders the single-CTA empty state when no expenses exist', async () => {
    // A member + category exist but zero expenses — the page must show
    // the helper copy, never an in-card Add button.
    await seedMember();
    await seedCategory();
    renderPage();

    // (a) Helper copy renders.
    const helper = await screen.findByText(/No expenses yet/i);
    expect(helper).toBeInTheDocument();

    // (b) The PageHeader Add-expense action is the ONLY "Add" CTA.
    await waitFor(() => {
      const addCtas = screen
        .getAllByRole('button')
        .filter((b) => /add/i.test(b.textContent ?? ''));
      expect(addCtas).toHaveLength(1);
    });
    const addBtn = screen.getByRole('button', { name: 'Add expense' });
    expect(addBtn).toBeInTheDocument();

    // (c) No in-card Add button — the empty-state card holds no buttons.
    const card = helper.closest('section');
    expect(card).not.toBeNull();
    expect(card?.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('ExpensesPage — HSA badge', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('shows an HSA badge for HSA-qualified expenses in the overview list', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense({ hsaQualified: true });
    renderPage();

    expect(await screen.findByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('HSA')).toBeInTheDocument();
  });
});

describe('ExpensesPage — display-unit toggle', () => {
  beforeEach(() => {
    setupContexts();
    window.localStorage.clear();
  });

  afterEach(async () => {
    await clearAllStores();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders the Display unit toggle defaulting to "Today\'s dollars"', async () => {
    await seedChartHousehold();
    renderPage();

    const group = await screen.findByRole('radiogroup', {
      name: 'Display unit',
    });
    const today = screen.getByRole('radio', { name: "Today's dollars" });
    const future = screen.getByRole('radio', { name: 'Future dollars' });
    expect(group).toBeInTheDocument();
    expect(today).toBeChecked();
    expect(future).not.toBeChecked();
  });

  it('persists "Future dollars" to localStorage when clicked', async () => {
    await seedChartHousehold();
    renderPage();

    const future = await screen.findByRole('radio', { name: 'Future dollars' });
    await userEvent.click(future);

    await waitFor(() => {
      expect(future).toBeChecked();
    });
    expect(
      window.localStorage.getItem(EXPENSES_DISPLAY_MODE_STORAGE_KEY),
    ).toBe('future');
  });

  it('restores a stored "future" selection on load and re-renders the chart vs today mode', async () => {
    window.localStorage.setItem(EXPENSES_DISPLAY_MODE_STORAGE_KEY, 'future');
    await seedChartHousehold();
    renderPage();

    const future = await screen.findByRole('radio', { name: 'Future dollars' });
    expect(future).toBeChecked();

    // Assert against the actual chart DATA, not whole-card markup: the
    // mocked "Total expenses" section renders the sum of the projected
    // monthly run-rates the page fed it. In future mode the curve
    // compounds (sum strictly larger); in today mode it is flat (smaller
    // sum). A radio's checked-state markup flip can't move this number —
    // only a different inflation rate reaching the projection engine can.
    // The exact numeric divergence is unit-tested in
    // ExpensesPage.builder.test.ts; this locks that the restored mode
    // actually feeds the chart.
    const futureSum = Number(
      (await screen.findByTestId('chart-total-sum')).textContent,
    );
    expect(futureSum).toBeGreaterThan(0);

    const today = screen.getByRole('radio', { name: "Today's dollars" });
    await userEvent.click(today);
    await waitFor(() => {
      expect(today).toBeChecked();
    });
    await waitFor(() => {
      const todaySum = Number(
        screen.getByTestId('chart-total-sum').textContent,
      );
      // Flat today-dollar curve sums to strictly less than the compounded
      // future-dollar curve → the restored mode genuinely re-fed the chart.
      expect(todaySum).toBeLessThan(futureSum);
    });
  });

  it('falls back to "Today\'s dollars" when the stored value is invalid', async () => {
    window.localStorage.setItem(
      EXPENSES_DISPLAY_MODE_STORAGE_KEY,
      'not-a-mode',
    );
    await seedChartHousehold();
    renderPage();

    const today = await screen.findByRole('radio', { name: "Today's dollars" });
    expect(today).toBeChecked();
    expect(
      screen.getByRole('radio', { name: 'Future dollars' }),
    ).not.toBeChecked();
  });
});

describe('ExpensesPage — reactive reads', () => {
  beforeEach(() => {
    setupContexts();
    window.localStorage.clear();
  });

  afterEach(async () => {
    await clearAllStores();
    // clearAllStores preserves the selectedScenario pointer (production keeps
    // it across a force-bootstrap), so reset it too — otherwise the active
    // scenario written here leaks into another mounted page's default pick.
    await clearSelectedScenario();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('re-derives on a fine store signal alone (putAggregate, no coarse event)', async () => {
    await seedMember();
    await seedCategory();
    renderPage();
    expect(await screen.findByText(/No expenses yet/i)).toBeInTheDocument();

    // A single-row write fires only the per-store fine signal — no
    // notifyWorkspaceChanged() — proving the useAggregates subscription wakes.
    await act(async () => {
      await seedExpense();
    });

    await waitFor(() =>
      expect(screen.getByText('Groceries')).toBeInTheDocument(),
    );
  });

  it('re-projects on notifySelectedScenarioChanged (active scenario switch)', async () => {
    // Future-dollar mode so the projection compounds at the SELECTED
    // scenario's inflation rate — switching the active scenario changes the
    // chart-sum the mocked Total section renders.
    window.localStorage.setItem(EXPENSES_DISPLAY_MODE_STORAGE_KEY, 'future');
    await seedMember();
    await seedCategory();
    await seedExpense();
    // Base scenario at 3% inflation, selected.
    await seedScenario('scn-base', {
      retirementAge: { primary: { ageYears: 60, ageMonths: 0 } },
      inflation: { ratePct: 3 },
    });
    // A non-primary alternate at a much higher inflation rate.
    const alt: Aggregate<ScenarioPayload> = {
      id: 'scn-alt',
      householdId: HH,
      aggregateType: 'scenario',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'High inflation',
        description: '',
        parentScenarioId: 'scn-base',
        isPrimary: false,
        notes: '',
        overrides: {
          retirementAge: { primary: { ageYears: 60, ageMonths: 0 } },
          inflation: { ratePct: 9 },
        },
      },
    };
    await putAggregate('scenario', alt);
    await writeSelectedScenario({
      scenarioId: 'scn-base',
      updatedAt: '2026-05-01T00:00:00Z',
    });
    renderPage();

    const baseSum = Number(
      (await screen.findByTestId('chart-total-sum')).textContent,
    );
    expect(baseSum).toBeGreaterThan(0);

    // Sidebar switches the active scenario to the higher-inflation alternate.
    await writeSelectedScenario({
      scenarioId: 'scn-alt',
      updatedAt: '2026-05-02T00:00:00Z',
    });
    await act(async () => {
      notifySelectedScenarioChanged();
    });

    // The page re-read the pointer and re-projected under the 9% rate, so the
    // future-dollar chart-sum grows.
    await waitFor(() => {
      const altSum = Number(
        screen.getByTestId('chart-total-sum').textContent,
      );
      expect(altSum).toBeGreaterThan(baseSum);
    });
  });
});

// ---------------------------------------------------------------------------
// Focus-restore tests.
// ---------------------------------------------------------------------------

describe('ExpensesPage — focus restore', () => {
  beforeEach(() => {
    setupContexts();
    // Install a global scrollIntoView no-op so jsdom doesn't throw (the
    // real implementation is absent in jsdom). Replaced with a spy per
    // test that asserts it was called.
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
    // Reset the real URL so a seeded focus param can't leak between tests.
    window.history.replaceState(null, '', '/');
  });

  it('scrolls to and focuses the Edit button for the matching row after load', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense({ name: 'Groceries' }, 'exp-focus');

    const scrollSpy = vi.fn();
    // Attach the spy before render so it captures the call made during effect.
    window.HTMLElement.prototype.scrollIntoView = scrollSpy;

    renderPageAt('/expenses?focusExpenseId=exp-focus');

    // Wait for the row to appear (confirms data loaded).
    await screen.findByText('Groceries');

    // The effect fires after loading completes.
    await waitFor(() => {
      expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'instant', block: 'nearest' });
    });

    // The Edit button receives focus.
    await waitFor(() => {
      const editBtn = screen.getAllByRole('button', { name: 'Edit' })[0];
      expect(document.activeElement).toBe(editBtn);
    });
  });

  it('strips the focusExpenseId param from the URL after restoration', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense({ name: 'Groceries' }, 'exp-strip');

    // Seed the real URL with the param so the replaceState strip has
    // something to remove — MemoryRouter keeps its history in-memory and
    // never writes to window.location, so the assertion would otherwise
    // pass vacuously.
    window.history.replaceState(null, '', '/expenses?focusExpenseId=exp-strip');

    renderPageAt('/expenses?focusExpenseId=exp-strip');
    await screen.findByText('Groceries');

    await waitFor(() => {
      // replaceState removes the param; the URL should no longer contain focusExpenseId.
      expect(window.location.search).not.toContain('focusExpenseId');
    });
  });

  it('strips the param but does nothing else when the id matches no row', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense({ name: 'Groceries' }, 'exp-real');

    const scrollSpy = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollSpy;

    // Seed the real URL so the strip assertion is meaningful.
    window.history.replaceState(null, '', '/expenses?focusExpenseId=exp-missing');

    renderPageAt('/expenses?focusExpenseId=exp-missing');
    await screen.findByText('Groceries');

    // Param is stripped; no scroll (no matching DOM node).
    await waitFor(() => {
      expect(window.location.search).not.toContain('focusExpenseId');
    });
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('is a no-op for an invalid id containing selector metacharacters', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense({ name: 'Groceries' }, 'exp-real');

    const scrollSpy = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollSpy;

    // `%5B` = `[` — a selector metacharacter; regex guard must reject it.
    // Seed the real URL so the strip assertion is meaningful.
    window.history.replaceState(null, '', '/expenses?focusExpenseId=bad%5Bid');

    renderPageAt('/expenses?focusExpenseId=bad%5Bid');
    await screen.findByText('Groceries');

    await waitFor(() => {
      expect(window.location.search).not.toContain('focusExpenseId');
    });
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('navigates to the encoded returnTo URL when the row Edit button is clicked', async () => {
    // Wrap in a Routes setup so navigate() has a proper router context and
    // the resulting location can be captured.
    let capturedLocation = '';
    const LocationProbe: React.FC = () => {
      const loc = useLocation();
      capturedLocation = loc.pathname + loc.search;
      return null;
    };

    await seedMember();
    await seedCategory();
    await seedExpense({ name: 'Groceries' }, 'exp-nav');

    render(
      withTheme(
        'light',
        <MemoryRouter initialEntries={['/expenses']}>
          <LocationProbe />
          <Routes>
            <Route path="/expenses" element={<ExpensesPage />} />
            <Route path="/expenses/:id/edit" element={<div>edit form</div>} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    await screen.findByText('Groceries');

    const editBtn = await screen.findByRole('button', { name: 'Edit' });
    await userEvent.click(editBtn);

    // The nav target must be the encoded returnTo URL.
    await waitFor(() => {
      expect(capturedLocation).toBe(
        '/expenses/exp-nav/edit?returnTo=%2Fexpenses%3FfocusExpenseId%3Dexp-nav',
      );
    });
  });

  it('scenario-link (Add expense) navigation is not affected by the restore feature', async () => {
    // Smoke test: clicking "Add expense" still navigates to /expenses/new,
    // not to any focus-restore URL.
    let capturedLocation = '';
    const LocationProbe: React.FC = () => {
      const loc = useLocation();
      capturedLocation = loc.pathname + loc.search;
      return null;
    };

    await seedMember();
    await seedCategory();

    render(
      withTheme(
        'light',
        <MemoryRouter initialEntries={['/expenses']}>
          <LocationProbe />
          <Routes>
            <Route path="/expenses" element={<ExpensesPage />} />
            <Route path="/expenses/new" element={<div>new form</div>} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    // Wait for loading to finish (empty state renders).
    await screen.findByText(/No expenses yet/i);

    const addBtn = screen.getByRole('button', { name: 'Add expense' });
    await userEvent.click(addBtn);

    await waitFor(() => {
      expect(capturedLocation).toBe('/expenses/new');
    });
  });
});
