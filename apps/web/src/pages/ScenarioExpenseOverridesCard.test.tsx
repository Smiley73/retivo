// ScenarioExpenseOverridesCard Edit navigation, per-key merged badges, and the guard that the old "Override amount" button and amount-only modal are gone (replaced by the shared expense editor in scenario-patch mode).
// The card takes `scenario` / `scenarios` / `householdId` / `onChanged` props (no AuthContext).
import 'fake-indexeddb/auto';
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  clearMutationQueue,
  listPendingMutations,
  putAggregate,
} from '../db/store';
import type {
  Aggregate,
  ExpenseCategoryPayload,
  ExpensePayload,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useSync } from '../sync/SyncContext';
import { ExpenseOverridesCard } from './ScenarioExpenseOverridesCard';

const HH = 'hh-test';

let lastLocation = '';
const LocationProbe: React.FC = () => {
  const loc = useLocation();
  lastLocation = loc.pathname + loc.search;
  return null;
};

function setupSync() {
  (useSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    notifyPending: vi.fn(),
    state: { kind: 'synced', lastSyncedAt: null },
  });
}

const scenarioAgg = (
  id: string,
  payload: Partial<ScenarioPayload> & { name: string },
): ScenarioAggregate => ({
  id,
  householdId: HH,
  aggregateType: 'scenario',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'dev-1',
  payload: {
    name: payload.name,
    description: '',
    parentScenarioId: payload.parentScenarioId ?? null,
    isPrimary: payload.isPrimary ?? false,
    notes: '',
    overrides: payload.overrides ?? {},
  },
});

function renderCard(scenario: ScenarioAggregate, scenarios: ScenarioAggregate[]) {
  return render(
    <MemoryRouter initialEntries={[`/scenarios/${scenario.id}/expenses`]}>
      <LocationProbe />
      <Routes>
        <Route
          path="/scenarios/:id/expenses"
          element={
            <ExpenseOverridesCard
              scenario={scenario}
              scenarios={scenarios}
              householdId={HH}
              onChanged={vi.fn()}
            />
          }
        />
        <Route path="/expenses/:id/edit" element={<div>expense editor</div>} />
        <Route path="/expenses/new" element={<div>new expense</div>} />
        <Route
          path="/expenses/scenario-entry"
          element={<div>scenario entry</div>}
        />
      </Routes>
    </MemoryRouter>,
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
      birthdate: '1965-04-15',
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
    payload: { name: 'Leisure' },
  };
  await putAggregate('expenseCategory', c);
}

async function seedExpense(
  id: string,
  payload: Partial<ExpensePayload> = {},
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
      name: 'Travel',
      amount: 1000,
      frequency: 'yearly',
      classification: 'discretionary',
      categoryId: 'cat-1',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'primary' },
      ...payload,
    },
  };
  await putAggregate('expense', e);
}

beforeEach(() => {
  setupSync();
  lastLocation = '';
});

afterEach(async () => {
  await clearAllStores();
  await clearMutationQueue();
  vi.clearAllMocks();
});

describe('ScenarioExpenseOverridesCard', () => {
  it('Edit on a canonical row navigates to the scenario-patch editor URL', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { name: 'Travel' });
    const base = scenarioAgg('scn-base', { name: 'Base', isPrimary: true });
    renderCard(base, [base]);

    const row = (await screen.findByText('Travel')).closest('li') as HTMLElement;
    expect(within(row).getByText('Default')).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));

    await waitFor(() =>
      expect(lastLocation).toBe(
        '/expenses/exp-1/edit?scenarioId=scn-base&returnTo=%2Fscenarios%2Fscn-base%2Fexpenses',
      ),
    );
  });

  it('a patched row shows the "Modified" badge and Edit navigates the same way', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { name: 'Travel', amount: 1000 });
    const child = scenarioAgg('scn-a', {
      name: 'Alt',
      parentScenarioId: null,
      overrides: {
        expenses: { patches: { 'aggregate:exp-1': { amount: 5000 } } },
      },
    });
    renderCard(child, [child]);

    const row = (await screen.findByText('Travel')).closest('li') as HTMLElement;
    expect(within(row).getByText('Modified')).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    await waitFor(() =>
      expect(lastLocation).toBe(
        '/expenses/exp-1/edit?scenarioId=scn-a&returnTo=%2Fscenarios%2Fscn-a%2Fexpenses',
      ),
    );
  });

  it('per-key merge: a parent {amount} + child {categoryId} patch still reads as Modified', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { name: 'Travel', amount: 1000 });
    const parent = scenarioAgg('scn-p', {
      name: 'Parent',
      isPrimary: true,
      overrides: {
        expenses: { patches: { 'aggregate:exp-1': { amount: 2000 } } },
      },
    });
    const child = scenarioAgg('scn-c', {
      name: 'Child',
      parentScenarioId: 'scn-p',
      overrides: {
        expenses: { patches: { 'aggregate:exp-1': { categoryId: 'cat-1' } } },
      },
    });
    renderCard(child, [parent, child]);

    const row = (await screen.findByText('Travel')).closest('li') as HTMLElement;
    expect(within(row).getByText('Modified')).toBeInTheDocument();
  });

  it('a patched row whose patch is ancestor-only renders Edit but NO Reset', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { name: 'Travel', amount: 1000 });
    // The patch lives on the parent; the child inherits the resolution but owns no `patches` key, so Reset (which deletes only the current scenario's key) would be a no-op and must not render.
    const parent = scenarioAgg('scn-p', {
      name: 'Parent',
      isPrimary: true,
      overrides: {
        expenses: { patches: { 'aggregate:exp-1': { amount: 2000 } } },
      },
    });
    const child = scenarioAgg('scn-c', {
      name: 'Child',
      parentScenarioId: 'scn-p',
    });
    renderCard(child, [parent, child]);

    const row = (await screen.findByText('Travel')).closest('li') as HTMLElement;
    expect(within(row).getByText('Modified')).toBeInTheDocument();
    expect(
      within(row).getByRole('button', { name: 'Edit' }),
    ).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('a patched row owned by the current scenario renders Reset', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { name: 'Travel', amount: 1000 });
    const child = scenarioAgg('scn-a', {
      name: 'Alt',
      parentScenarioId: null,
      overrides: {
        expenses: { patches: { 'aggregate:exp-1': { amount: 5000 } } },
      },
    });
    renderCard(child, [child]);

    const row = (await screen.findByText('Travel')).closest('li') as HTMLElement;
    expect(
      within(row).getByRole('button', { name: 'Reset' }),
    ).toBeInTheDocument();
  });

  it('Move to household list preserves a scenario-only added expense\'s discretionaryGlide', async () => {
    await seedMember();
    await seedCategory();
    const glide: NonNullable<ExpensePayload['discretionaryGlide']> = {
      endMultiplierPct: 60,
      glideStart: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      glideEnd: { kind: 'age', memberId: 'primary', years: 80, months: 0 },
    };
    const base = scenarioAgg('scn-base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        expenses: {
          added: [
            {
              _localId: 'lid-1',
              name: 'Sabbatical',
              amount: 4000,
              frequency: 'yearly',
              classification: 'discretionary',
              categoryId: 'cat-1',
              start: { kind: 'retirementStart' },
              end: { kind: 'lifetime', whose: 'primary' },
              discretionaryGlide: glide,
            },
          ],
        },
      },
    });
    renderCard(base, [base]);

    const row = (await screen.findByText('Sabbatical')).closest(
      'li',
    ) as HTMLElement;
    fireEvent.click(
      within(row).getByRole('button', { name: 'Move to household list' }),
    );

    // The shared confirm (useConfirm) is a React Aria alertdialog.
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Move to household list' }),
    );

    await waitFor(async () => {
      const pending = await listPendingMutations();
      const m = pending.find(
        (p) => p.aggregateType === 'expense' && p.operation === 'create',
      );
      expect(m).toBeDefined();
      const pl = m?.payload as ExpensePayload;
      expect(pl.name).toBe('Sabbatical');
      expect(pl.discretionaryGlide).toEqual(glide);
    });
  });

  it('Edit on a scenario-only added row navigates to the add-edit entry URL', async () => {
    await seedMember();
    await seedCategory();
    const base = scenarioAgg('scn-base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        expenses: {
          added: [
            {
              _localId: 'lid-1',
              name: 'Sabbatical',
              amount: 4000,
              frequency: 'yearly',
              classification: 'discretionary',
              categoryId: 'cat-1',
              start: { kind: 'retirementStart' },
              end: { kind: 'lifetime', whose: 'primary' },
            },
          ],
        },
      },
    });
    renderCard(base, [base]);

    const row = (await screen.findByText('Sabbatical')).closest(
      'li',
    ) as HTMLElement;
    expect(within(row).getByText('Scenario-only')).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    await waitFor(() =>
      expect(lastLocation).toBe(
        '/expenses/scenario-entry?scenarioId=scn-base&editLocalId=lid-1&returnTo=%2Fscenarios%2Fscn-base%2Fexpenses',
      ),
    );
  });

  it('an inherited added row (from a parent scenario) renders NO Edit / Move / Delete actions', async () => {
    await seedMember();
    await seedCategory();
    const parent = scenarioAgg('scn-p', {
      name: 'Parent',
      isPrimary: true,
      overrides: {
        expenses: {
          added: [
            {
              _localId: 'lid-parent',
              name: 'Parent Sabbatical',
              amount: 4000,
              frequency: 'yearly',
              classification: 'discretionary',
              categoryId: 'cat-1',
              start: { kind: 'retirementStart' },
              end: { kind: 'lifetime', whose: 'primary' },
            },
          ],
        },
      },
    });
    const child = scenarioAgg('scn-c', {
      name: 'Child',
      parentScenarioId: 'scn-p',
      overrides: {
        expenses: {
          added: [
            {
              _localId: 'lid-child',
              name: 'Child Trip',
              amount: 2000,
              frequency: 'yearly',
              classification: 'discretionary',
              categoryId: 'cat-1',
              start: { kind: 'retirementStart' },
              end: { kind: 'lifetime', whose: 'primary' },
            },
          ],
        },
      },
    });
    renderCard(child, [parent, child]);

    // The inherited (parent-owned) added row resolves into this child card but its actions would mutate only the child's own `added[]`, so they must not render.
    const inheritedRow = (await screen.findByText('Parent Sabbatical')).closest(
      'li',
    ) as HTMLElement;
    expect(within(inheritedRow).getByText('Scenario-only')).toBeInTheDocument();
    expect(within(inheritedRow).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(
      within(inheritedRow).queryByRole('button', {
        name: 'Move to household list',
      }),
    ).toBeNull();
    expect(
      within(inheritedRow).queryByRole('button', { name: 'Delete' }),
    ).toBeNull();

    const ownRow = (await screen.findByText('Child Trip')).closest(
      'li',
    ) as HTMLElement;
    expect(within(ownRow).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(
      within(ownRow).getByRole('button', { name: 'Move to household list' }),
    ).toBeInTheDocument();
    expect(
      within(ownRow).getByRole('button', { name: 'Delete' }),
    ).toBeInTheDocument();
  });

  it('the "Add scenario-only expense" header action navigates to the scenario-entry add URL', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { name: 'Travel' });
    const base = scenarioAgg('scn-base', { name: 'Base', isPrimary: true });
    renderCard(base, [base]);

    await screen.findByText('Travel');
    fireEvent.click(
      screen.getByRole('button', { name: 'Add scenario-only expense' }),
    );
    await waitFor(() =>
      expect(lastLocation).toBe(
        '/expenses/scenario-entry?scenarioId=scn-base&returnTo=%2Fscenarios%2Fscn-base%2Fexpenses',
      ),
    );
  });

  it('renders the foot-note count summary derived from the rendered rows', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { name: 'Travel', amount: 1000 });
    const child = scenarioAgg('scn-a', {
      name: 'Alt',
      parentScenarioId: null,
      overrides: {
        expenses: { patches: { 'aggregate:exp-1': { amount: 5000 } } },
      },
    });
    renderCard(child, [child]);

    // Testing-library collapses whitespace, so the split text nodes normalise to one line.
    expect(
      await screen.findByText('0 disabled · 1 modified · 0 scenario-only.'),
    ).toBeInTheDocument();
  });

  it('hoists the Add scenario-only action into the page header (no in-card heading)', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { name: 'Travel' });
    const base = scenarioAgg('scn-base', { name: 'Base', isPrimary: true });
    renderCard(base, [base]);

    await screen.findByText('Travel');
    expect(
      screen.getByRole('button', { name: 'Add scenario-only expense' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Expenses: Base/ }),
    ).toBeInTheDocument();
  });

  it('has NO per-row "Override amount" button and no amount-only modal', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { name: 'Travel' });
    const base = scenarioAgg('scn-base', { name: 'Base', isPrimary: true });
    renderCard(base, [base]);

    await screen.findByText('Travel');
    expect(
      screen.queryByRole('button', { name: /override amount/i }),
    ).toBeNull();
    // The deleted PatchAmountModal surfaced an "Override amount" dialog; none of that copy may exist.
    expect(screen.queryByText(/override amount/i)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Edit' }),
    ).toBeInTheDocument();
  });
});

describe('ScenarioExpenseOverridesCard — reactive read layer', () => {
  it('re-reads the canonical expense list on WORKSPACE_CHANGED_EVENT without a remount', async () => {
    await seedMember();
    await seedCategory();
    const base = scenarioAgg('scn-base', { name: 'Base', isPrimary: true });
    renderCard(base, [base]);

    expect(
      await screen.findByText(/No expenses to adjust yet/i),
    ).toBeInTheDocument();

    // A bulk fill lands after mount, then the coarse workspace-change event.
    await seedExpense('exp-1', { name: 'Travel' });
    const { notifyWorkspaceChanged } = await import('../lib/workspace-events');
    await act(async () => {
      notifyWorkspaceChanged();
    });

    expect(await screen.findByText('Travel')).toBeInTheDocument();
  });

  it('re-reads on a fine-signal expense write (no coarse event)', async () => {
    await seedMember();
    await seedCategory();
    const base = scenarioAgg('scn-base', { name: 'Base', isPrimary: true });
    renderCard(base, [base]);

    expect(
      await screen.findByText(/No expenses to adjust yet/i),
    ).toBeInTheDocument();

    // A single-row write fires only the per-store signal, no coarse event.
    await act(async () => {
      await seedExpense('exp-1', { name: 'Travel' });
    });

    expect(await screen.findByText('Travel')).toBeInTheDocument();
  });
});
