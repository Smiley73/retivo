// ExpensesPage over fake-indexeddb: the single-CTA empty state (only the PageHeader Add, no in-card Add), display-mode and scenario wiring, and focus restore.
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
import { SELECTED_SCENARIO_CHANGED_EVENT } from '../lib/scenario-mutations';
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

// The real chart is lazy-loaded; stub the "Total expenses" section with one that renders the sum of the projected monthly run-rates as text, so assertions prove the projection engine received the active display mode, not just that a radio flipped.
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
    await seedMember();
    await seedCategory();
    renderPage();

    const helper = await screen.findByText(/No expenses yet/i);
    expect(helper).toBeInTheDocument();

    await waitFor(() => {
      const addCtas = screen
        .getAllByRole('button')
        .filter((b) => /add expense/i.test(b.textContent ?? ''));
      expect(addCtas).toHaveLength(1);
    });
    const addBtn = screen.getByRole('button', { name: 'Add expense' });
    expect(addBtn).toBeInTheDocument();

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

    // Assert on chart data, not markup: the stub renders the sum of the projected run-rates, which only a different inflation rate reaching the projection engine can move. The exact divergence is unit-tested in ExpensesPage.builder.test.ts.
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
    // clearAllStores preserves the selectedScenario pointer (production keeps it across a force-bootstrap), so reset it too or the active scenario leaks into another page's default pick.
    await clearSelectedScenario();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('re-derives on a fine store signal alone (putAggregate, no coarse event)', async () => {
    await seedMember();
    await seedCategory();
    renderPage();
    expect(await screen.findByText(/No expenses yet/i)).toBeInTheDocument();

    // A single-row write fires only the per-store signal, no notifyWorkspaceChanged(); the useAggregates subscription must still wake.
    await act(async () => {
      await seedExpense();
    });

    await waitFor(() =>
      expect(screen.getByText('Groceries')).toBeInTheDocument(),
    );
  });

  it('re-projects on SELECTED_SCENARIO_CHANGED_EVENT (active scenario switch)', async () => {
    // Future-dollar mode, so the projection compounds at the selected scenario's inflation rate.
    window.localStorage.setItem(EXPENSES_DISPLAY_MODE_STORAGE_KEY, 'future');
    await seedMember();
    await seedCategory();
    await seedExpense();
    await seedScenario('scn-base', {
      retirementAge: { primary: { ageYears: 60, ageMonths: 0 } },
      inflation: { ratePct: 3 },
    });
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

    await writeSelectedScenario({
      scenarioId: 'scn-alt',
      updatedAt: '2026-05-02T00:00:00Z',
    });
    await act(async () => {
      window.dispatchEvent(new Event(SELECTED_SCENARIO_CHANGED_EVENT));
    });

    await waitFor(() => {
      const altSum = Number(
        screen.getByTestId('chart-total-sum').textContent,
      );
      expect(altSum).toBeGreaterThan(baseSum);
    });
  });
});

describe('ExpensesPage — focus restore', () => {
  beforeEach(() => {
    setupContexts();
    // jsdom has no scrollIntoView; install a no-op globally and replace it with a spy per test.
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
    window.HTMLElement.prototype.scrollIntoView = scrollSpy;

    renderPageAt('/expenses?focusExpenseId=exp-focus');

    await screen.findByText('Groceries');

    await waitFor(() => {
      expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'instant', block: 'nearest' });
    });

    await waitFor(() => {
      const editBtn = screen.getAllByRole('button', { name: 'Edit' })[0];
      expect(document.activeElement).toBe(editBtn);
    });
  });

  it('strips the focusExpenseId param from the URL after restoration', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense({ name: 'Groceries' }, 'exp-strip');

    // Seed the real URL with the param: MemoryRouter never writes to window.location, so the replaceState assertion would pass vacuously otherwise.
    window.history.replaceState(null, '', '/expenses?focusExpenseId=exp-strip');

    renderPageAt('/expenses?focusExpenseId=exp-strip');
    await screen.findByText('Groceries');

    await waitFor(() => {
      expect(window.location.search).not.toContain('focusExpenseId');
    });
  });

  it('strips the param but does nothing else when the id matches no row', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense({ name: 'Groceries' }, 'exp-real');

    const scrollSpy = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollSpy;

    window.history.replaceState(null, '', '/expenses?focusExpenseId=exp-missing');

    renderPageAt('/expenses?focusExpenseId=exp-missing');
    await screen.findByText('Groceries');

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

    // `%5B` is `[`, a selector metacharacter that the regex guard must reject.
    window.history.replaceState(null, '', '/expenses?focusExpenseId=bad%5Bid');

    renderPageAt('/expenses?focusExpenseId=bad%5Bid');
    await screen.findByText('Groceries');

    await waitFor(() => {
      expect(window.location.search).not.toContain('focusExpenseId');
    });
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('navigates to the encoded returnTo URL when the row Edit button is clicked', async () => {
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

    await waitFor(() => {
      expect(capturedLocation).toBe(
        '/expenses/exp-nav/edit?returnTo=%2Fexpenses%3FfocusExpenseId%3Dexp-nav',
      );
    });
  });

  it('scenario-link (Add expense) navigation is not affected by the restore feature', async () => {
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

    await screen.findByText(/No expenses yet/i);

    const addBtn = screen.getByRole('button', { name: 'Add expense' });
    await userEvent.click(addBtn);

    await waitFor(() => {
      expect(capturedLocation).toBe('/expenses/new');
    });
  });
});

describe('ExpensesPage — Add Medicare premiums', () => {
  beforeEach(async () => {
    setupContexts();
    await seedMember();
    await seedCategory();
    const medical: Aggregate<ExpenseCategoryPayload> = {
      id: 'cat-medical',
      householdId: HH,
      aggregateType: 'expenseCategory',
      schemaVersion: 2,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: { name: 'Medical', isMedical: true },
    };
    await putAggregate('expenseCategory', medical);
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('opens the preview from the header action', async () => {
    renderPageAt('/expenses');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add Medicare premiums' }),
    );
    expect(
      await screen.findByRole('dialog', { name: 'Add Medicare premiums' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Alex Medicare Part B' })).toBeChecked();
  });

  it('does not open the preview on a plain load', async () => {
    renderPageAt('/expenses');
    await screen.findByText(/No expenses yet/i);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the preview from the entry-point parameter and strips it from the URL', async () => {
    // The real URL carries the parameter so the strip has something to remove; MemoryRouter never writes to window.location.
    window.history.replaceState(null, '', '/expenses?medicarePremiums=1');
    renderPageAt('/expenses?medicarePremiums=1');
    expect(
      await screen.findByRole('dialog', { name: 'Add Medicare premiums' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.search).not.toContain('medicarePremiums');
    });
  });

  it('stays closed after Cancel even though the router still holds the parameter', async () => {
    renderPageAt('/expenses?medicarePremiums=1');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
