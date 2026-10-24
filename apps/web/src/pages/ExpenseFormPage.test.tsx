// ExpenseFormPage canonical and scenario-patch flows over fake-indexeddb, with AuthContext and SyncContext mocked.
import 'fake-indexeddb/auto';
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  clearMutationQueue,
  getAggregate,
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

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { withTheme } from '../test/theme-render';
import {
  ExpenseFormPage,
  buildExpensePayload,
  type FormState,
} from './ExpenseFormPage';

const HH = 'hh-test';

function setupContexts() {
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

let lastLocation = '';
const LocationProbe: React.FC = () => {
  const loc = useLocation();
  lastLocation = loc.pathname + loc.search;
  return null;
};

function renderAt(path: string) {
  return render(
    withTheme(
      'light',
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route path="/expenses/new" element={<ExpenseFormPage />} />
          <Route
            path="/expenses/scenario-entry"
            element={<ExpenseFormPage />}
          />
          <Route path="/expenses/:id/edit" element={<ExpenseFormPage />} />
          <Route path="/expenses" element={<div>expenses list</div>} />
          <Route
            path="/scenarios/:id/expenses"
            element={<div>scenario expenses</div>}
          />
          <Route path="/dashboard" element={<div>dashboard</div>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

// Each glide anchor is a collapsible AnchorCard: expand it, pick "In year" and set the year. Default age anchors seed at year 0, which save-time validation rejects.
function setGlideYear(label: 'Glide starts' | 'Glide ends', year: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
  fireEvent.click(
    within(screen.getByRole('radiogroup', { name: label })).getByRole('radio', {
      name: /in year/i,
    }),
  );
  fireEvent.change(screen.getByLabelText(`${label} year`), {
    target: { value: year },
  });
}

function setStartYear(year: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  fireEvent.click(
    within(screen.getByRole('radiogroup', { name: 'Start' })).getByRole('radio', {
      name: /in year/i,
    }),
  );
  fireEvent.change(screen.getByLabelText('Start year'), {
    target: { value: year },
  });
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

async function seedBaseScenario(
  overrides: ScenarioPayload['overrides'] = {},
  version = 1,
): Promise<void> {
  const s: Aggregate<ScenarioPayload> = {
    id: 'scn-base',
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version,
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

const ENABLED_GLIDE: NonNullable<ExpensePayload['discretionaryGlide']> = {
  endMultiplierPct: 60,
  glideStart: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
  glideEnd: { kind: 'age', memberId: 'primary', years: 80, months: 0 },
};

beforeEach(() => {
  setupContexts();
  lastLocation = '';
});

afterEach(async () => {
  await clearAllStores();
  await clearMutationQueue();
  vi.clearAllMocks();
});

describe('ExpenseFormPage — glide section gating', () => {
  it('shows the glide group for ANY classification; persists across an essential↔discretionary flip', async () => {
    await seedMember();
    await seedCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    const essentialRadio = screen.getByRole('radio', { name: 'Essential' });
    const discretionaryRadio = screen.getByRole('radio', { name: 'Discretionary' });
    const glideGroup = screen.getByRole('group', { name: /spending glide/i });
    expect(glideGroup).toBeInTheDocument();

    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    expect(screen.getByLabelText('End percentage')).toBeInTheDocument();

    fireEvent.click(discretionaryRadio);
    expect(
      screen.getByRole('group', { name: /spending glide/i }),
    ).toBeInTheDocument();

    fireEvent.click(essentialRadio);
    expect(
      screen.getByRole('group', { name: /spending glide/i }),
    ).toBeInTheDocument();
  });

  it('hides the glide section for a one-off discretionary expense', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    fireEvent.click(screen.getByRole('radio', { name: 'Discretionary' }));
    expect(
      screen.getByRole('group', { name: /spending glide/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText('Frequency'));
    await user.click(await screen.findByRole('option', { name: 'One-off' }));
    expect(
      screen.queryByRole('group', { name: /spending glide/i }),
    ).toBeNull();

    await user.click(screen.getByLabelText('Frequency'));
    await user.click(await screen.findByRole('option', { name: 'Monthly' }));
    expect(
      screen.getByRole('group', { name: /spending glide/i }),
    ).toBeInTheDocument();
  });

  it('a recurring→oneOff flip leaves any drafted glide unrendered', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    fireEvent.click(screen.getByRole('radio', { name: 'Discretionary' }));
    const glideGroup = screen.getByRole('group', {
      name: /spending glide/i,
    });
    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    expect(screen.getByLabelText('End percentage')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Frequency'));
    await user.click(await screen.findByRole('option', { name: 'One-off' }));
    expect(
      screen.queryByRole('group', { name: /spending glide/i }),
    ).toBeNull();
    expect(screen.queryByLabelText('End percentage')).toBeNull();
  });

  it('the glide section renders for a non-one-off ESSENTIAL expense and the live region announces it', async () => {
    await seedMember();
    await seedCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    expect(
      screen.getByRole('group', { name: /spending glide/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Spending glide options are shown below.')).toBeInTheDocument();
  });
});

describe('ExpenseFormPage — glide Save validation (any classification)', () => {
  it('Save persists a glided ESSENTIAL expense', async () => {
    await seedMember();
    await seedCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Escalating care' },
    });
    const glideGroup = screen.getByRole('group', { name: /spending glide/i });
    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    fireEvent.change(screen.getByLabelText('End percentage'), {
      target: { value: '150' },
    });
    setGlideYear('Glide starts', '2030');
    setGlideYear('Glide ends', '2045');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const pending = await listPendingMutations();
      const m = pending.find((p) => p.aggregateType === 'expense');
      expect(m).toBeDefined();
      const pl = m?.payload as ExpensePayload;
      expect(pl.classification).toBe('essential');
      expect(pl.discretionaryGlide?.endMultiplierPct).toBe(150);
    });
  });

  it('Save rejects an invalid glided ESSENTIAL (glide ends before it starts)', async () => {
    await seedMember();
    await seedCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Bad care' },
    });
    const glideGroup = screen.getByRole('group', { name: /spending glide/i });
    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    setGlideYear('Glide starts', '2045');
    setGlideYear('Glide ends', '2035');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(/must end after it starts/i),
    ).toBeInTheDocument();
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.aggregateType === 'expense')).toBeUndefined();
  });
});

describe('ExpenseFormPage — canonical persist', () => {
  it('canonical create persists discretionaryGlide when configured', async () => {
    await seedMember();
    await seedCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Big trips' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Discretionary' }));
    const glideGroup = screen.getByRole('group', {
      name: /spending glide/i,
    });
    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    fireEvent.change(screen.getByLabelText('End percentage'), {
      target: { value: '60' },
    });
    setGlideYear('Glide starts', '2030');
    setGlideYear('Glide ends', '2045');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const pending = await listPendingMutations();
      const m = pending.find((p) => p.aggregateType === 'expense');
      expect(m).toBeDefined();
      expect(m?.operation).toBe('create');
      const pl = m?.payload as ExpensePayload;
      expect(pl.discretionaryGlide?.endMultiplierPct).toBe(60);
      expect(pl.classification).toBe('discretionary');
    });
  });

  it('enabling the glide on a canonical discretionary expense persists a present object (even at the default 100% End), and reopening shows the toggle ON', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', {
      classification: 'discretionary',
      discretionaryGlide: undefined,
    });
    renderAt('/expenses/exp-1/edit');
    await screen.findByDisplayValue('Travel');

    const glideGroup = screen.getByRole('group', {
      name: /spending glide/i,
    });
    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    setGlideYear('Glide starts', '2030');
    setGlideYear('Glide ends', '2045');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    let saved: NonNullable<ExpensePayload['discretionaryGlide']> | undefined;
    await waitFor(async () => {
      const pending = await listPendingMutations();
      const m = pending.find((p) => p.aggregateId === 'exp-1');
      expect(m?.operation).toBe('update');
      const pl = m?.payload as ExpensePayload;
      // A present object, not undefined, even though End is still 100.
      expect(pl.discretionaryGlide).toBeDefined();
      expect(pl.discretionaryGlide?.endMultiplierPct).toBe(100);
      saved = pl.discretionaryGlide;
    });

    // Canonical absence means off, presence on: a saved glide at 100% must seed the toggle ON.
    await seedExpense('exp-2', {
      classification: 'discretionary',
      discretionaryGlide: saved,
    });
    renderAt('/expenses/exp-2/edit');
    await screen.findByDisplayValue('Travel');
    expect(
      screen.getByRole('switch', { name: /enable spending glide/i }),
    ).toBeChecked();
  });

  it('canonical edit persists an updated discretionaryGlide', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { discretionaryGlide: ENABLED_GLIDE });
    renderAt('/expenses/exp-1/edit');
    await screen.findByDisplayValue('Travel');

    fireEvent.change(screen.getByLabelText('End percentage'), {
      target: { value: '40' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const pending = await listPendingMutations();
      const m = pending.find((p) => p.aggregateId === 'exp-1');
      expect(m?.operation).toBe('update');
      const pl = m?.payload as ExpensePayload;
      expect(pl.discretionaryGlide?.endMultiplierPct).toBe(40);
    });
  });
});

async function seedSecondaryMember(): Promise<void> {
  const m: Aggregate<HouseholdMemberPayload> = {
    id: 'hm-2',
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary: false,
      firstName: 'Sam',
      lastName: 'Secondary',
      email: 'sam@example.test',
      birthdate: '1967-06-20',
    },
  };
  await putAggregate('householdMember', m);
}

describe('ExpenseFormPage — Start picker (shared ScheduleAnchorPicker)', () => {
  it('renders the Start picker through the shared collapsible AnchorCard', async () => {
    await seedMember();
    await seedCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(
      screen.getByRole('radiogroup', { name: 'Start' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /start of retirement/i }),
    ).toBeChecked();
  });

  it('single-member household: the age radio reads "At {primary}\'s age"', async () => {
    await seedMember(); // primary "Alex" only
    await seedCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(
      screen.getByRole('radio', { name: "At Alex's age" }),
    ).toBeInTheDocument();
  });

  it('two-member household: the age radio reads the generic "At age"', async () => {
    await seedMember();
    await seedSecondaryMember();
    await seedCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(screen.getByRole('radio', { name: 'At age' })).toBeInTheDocument();
  });

  it('start-anchor "In year" round-trips identically through the bridge', async () => {
    await seedMember();
    await seedCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Travel' },
    });
    setStartYear('2045');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => {
      const pending = await listPendingMutations();
      const m = pending.find((p) => p.aggregateType === 'expense');
      expect(m).toBeDefined();
      const pl = m?.payload as ExpensePayload;
      expect(pl.start).toEqual({ kind: 'year', year: 2045 });
    });
  });

  it('expense keeps an explicit age.memberId after a years-only edit (no owner-implicit omission)', async () => {
    await seedMember();
    await seedSecondaryMember();
    await seedCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Travel' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Start' })).getByRole(
        'radio',
        { name: 'At age' },
      ),
    );
    fireEvent.change(screen.getByLabelText('Start age years'), {
      target: { value: '70' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => {
      const pending = await listPendingMutations();
      const m = pending.find((p) => p.aggregateType === 'expense');
      expect(m).toBeDefined();
      const pl = m?.payload as ExpensePayload;
      // An expense always keeps memberId explicitly.
      expect(pl.start).toEqual({
        kind: 'age',
        memberId: 'primary',
        years: 70,
        months: 0,
      });
    });
  });
});

describe('ExpenseFormPage — scenario-patch mode', () => {
  it('writes a sparse patch of only the changed keys vs opened-resolved', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario({});
    await seedExpense('exp-1', { amount: 1000 });
    renderAt(
      '/expenses/exp-1/edit?scenarioId=scn-base&returnTo=/scenarios/scn-base/expenses',
    );
    await screen.findByDisplayValue('Travel');

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Travel (lean)' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const sc = (await getAggregate(
        'scenario',
        'scn-base',
      )) as Aggregate<ScenarioPayload> | null;
      const patch = sc?.payload.overrides.expenses?.patches?.[
        'aggregate:exp-1'
      ] as Partial<ExpensePayload> | undefined;
      expect(patch).toBeDefined();
      expect(patch?.name).toBe('Travel (lean)');
      expect(patch && 'amount' in patch).toBe(false);
    });
    const canonical = (await getAggregate(
      'expense',
      'exp-1',
    )) as Aggregate<ExpensePayload> | null;
    expect(canonical?.payload.name).toBe('Travel');
  });

  it('editing only the glide preserves a pre-existing {amount} patch key', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario({
      expenses: { patches: { 'aggregate:exp-1': { amount: 5000 } } },
    });
    await seedExpense('exp-1', { amount: 1000 });
    renderAt(
      '/expenses/exp-1/edit?scenarioId=scn-base&returnTo=/scenarios/scn-base/expenses',
    );
    await screen.findByDisplayValue('Travel');

    const glideGroup = screen.getByRole('group', {
      name: /spending glide/i,
    });
    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    fireEvent.change(screen.getByLabelText('End percentage'), {
      target: { value: '70' },
    });
    setGlideYear('Glide starts', '2030');
    setGlideYear('Glide ends', '2045');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const sc = (await getAggregate(
        'scenario',
        'scn-base',
      )) as Aggregate<ScenarioPayload> | null;
      const patch = sc?.payload.overrides.expenses?.patches?.[
        'aggregate:exp-1'
      ] as Partial<ExpensePayload> | undefined;
      expect(patch).toBeDefined();
      expect(patch?.amount).toBe(5000);
      expect(patch?.discretionaryGlide?.endMultiplierPct).toBe(70);
    });
  });

  it('clearing inherited description persists empty string', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario({});
    await seedExpense('exp-1', { description: 'inherited note' });
    renderAt(
      '/expenses/exp-1/edit?scenarioId=scn-base&returnTo=/scenarios/scn-base/expenses',
    );
    await screen.findByDisplayValue('inherited note');

    fireEvent.change(screen.getByLabelText('Description (optional)'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const sc = (await getAggregate(
        'scenario',
        'scn-base',
      )) as Aggregate<ScenarioPayload> | null;
      const patch = sc?.payload.overrides.expenses?.patches?.[
        'aggregate:exp-1'
      ] as Partial<ExpensePayload> | undefined;
      expect(patch?.description).toBe('');
    });
  });

  it('turning glide off in scenario-patch persists a null clear-marker', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario({});
    await seedExpense('exp-1', { discretionaryGlide: ENABLED_GLIDE });
    renderAt(
      '/expenses/exp-1/edit?scenarioId=scn-base&returnTo=/scenarios/scn-base/expenses',
    );
    await screen.findByDisplayValue('Travel');

    const glideGroup = screen.getByRole('group', {
      name: /spending glide/i,
    });
    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const sc = (await getAggregate(
        'scenario',
        'scn-base',
      )) as Aggregate<ScenarioPayload> | null;
      const patch = sc?.payload.overrides.expenses?.patches?.[
        'aggregate:exp-1'
      ] as Record<string, unknown> | undefined;
      // Cleared via the null marker: the resolver strips the key, so the engine default applies.
      expect(patch).toHaveProperty('discretionaryGlide', null);
    });
  });

  it('recurring → oneOff clears the inherited end via null (no save error)', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedCategory();
    await seedBaseScenario({});
    await seedExpense('exp-1', {
      frequency: 'yearly',
      end: { kind: 'lifetime', whose: 'primary' },
    });
    renderAt(
      '/expenses/exp-1/edit?scenarioId=scn-base&returnTo=/scenarios/scn-base/expenses',
    );
    await screen.findByDisplayValue('Travel');

    await user.click(screen.getByLabelText('Frequency'));
    await user.click(await screen.findByRole('option', { name: 'One-off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const sc = (await getAggregate(
        'scenario',
        'scn-base',
      )) as Aggregate<ScenarioPayload> | null;
      const patch = sc?.payload.overrides.expenses?.patches?.[
        'aggregate:exp-1'
      ] as Record<string, unknown> | undefined;
      expect(patch?.frequency).toBe('oneOff');
      expect(patch).toHaveProperty('end', null);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ExpenseFormPage — scenario-only add-edit mode', () => {
  it('replaces the matching added[] entry in place (same _localId, count unchanged)', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario({
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
          {
            _localId: 'lid-2',
            name: 'Boat',
            amount: 2000,
            frequency: 'yearly',
            classification: 'discretionary',
            categoryId: 'cat-1',
            start: { kind: 'retirementStart' },
            end: { kind: 'lifetime', whose: 'primary' },
          },
        ],
      },
    });
    renderAt(
      '/expenses/scenario-entry?scenarioId=scn-base&editLocalId=lid-1&returnTo=/scenarios/scn-base/expenses',
    );
    await screen.findByDisplayValue('Sabbatical');

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Long sabbatical' },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '7000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const sc = (await getAggregate(
        'scenario',
        'scn-base',
      )) as Aggregate<ScenarioPayload> | null;
      const added = sc?.payload.overrides.expenses?.added ?? [];
      expect(added).toHaveLength(2);
      const edited = added.find((a) => a._localId === 'lid-1');
      expect(edited?.name).toBe('Long sabbatical');
      expect(edited?.amount).toBe(7000);
      expect(added.find((a) => a._localId === 'lid-2')?.name).toBe('Boat');
    });
  });

  it('navigates to the returnTo URL after a successful add-edit Save', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario({
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
    });
    renderAt(
      '/expenses/scenario-entry?scenarioId=scn-base&editLocalId=lid-1&returnTo=%2Fscenarios%2Fscn-base%2Fexpenses',
    );
    await screen.findByDisplayValue('Sabbatical');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(lastLocation).toBe('/scenarios/scn-base/expenses'),
    );
  });

  it('surfaces an error state when editLocalId matches no added entry', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario({ expenses: { added: [] } });
    renderAt(
      '/expenses/scenario-entry?scenarioId=scn-base&editLocalId=missing&returnTo=/scenarios/scn-base/expenses',
    );
    expect(
      await screen.findByText('Scenario-only expense not found.'),
    ).toBeInTheDocument();
  });
});

describe('ExpenseFormPage — mode-state reset on route transition', () => {
  it('clears editingAddedLocalId so a follow-on plain add APPENDS, not replaces', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedCategory();
    await seedBaseScenario({
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
    });

    // Both URLs match the same `/expenses/scenario-entry` route, so React reuses the component instance and only the query (editLocalId) changes; without the reset the stale `editingAddedLocalId` would make the second Save replace lid-1.
    const Navigator: React.FC = () => {
      const navigate = useNavigate();
      return (
        <button
          type="button"
          onClick={() =>
            navigate(
              '/expenses/scenario-entry?scenarioId=scn-base&returnTo=/scenarios/scn-base/expenses',
            )
          }
        >
          go-plain-add
        </button>
      );
    };
    render(
      withTheme(
        'light',
        <MemoryRouter
          initialEntries={[
            '/expenses/scenario-entry?scenarioId=scn-base&editLocalId=lid-1&returnTo=/scenarios/scn-base/expenses',
          ]}
        >
          <LocationProbe />
          <Navigator />
          <Routes>
            <Route
              path="/expenses/scenario-entry"
              element={<ExpenseFormPage />}
            />
            <Route
              path="/scenarios/:id/expenses"
              element={<div>scenario expenses</div>}
            />
          </Routes>
        </MemoryRouter>,
      ),
    );

    await screen.findByDisplayValue('Sabbatical');

    await user.click(screen.getByText('go-plain-add'));
    await waitFor(() =>
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(''),
    );

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'New trip' },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '3000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => screen.getByText('scenario expenses'));
    const after = (await getAggregate(
      'scenario',
      'scn-base',
    )) as Aggregate<ScenarioPayload> | null;
    const added = after?.payload.overrides.expenses?.added ?? [];
    expect(added).toHaveLength(2);
    expect(added.find((a) => a._localId === 'lid-1')?.name).toBe('Sabbatical');
    expect(added.some((a) => a.name === 'New trip')).toBe(true);
  });

  // On a same-component query-only transition `loading` stayed false, so the reseed window rendered the stale add-edit form (Save reachable against the old row) and could leave a stale load `error` visible; the load now re-enters `loading` and clears `error`.
  it('clears stale form/error on transition so a follow-on Save APPENDS, not replaces', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedCategory();
    await seedBaseScenario({
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
    });

    const Navigator: React.FC = () => {
      const navigate = useNavigate();
      return (
        <button
          type="button"
          onClick={() =>
            navigate(
              '/expenses/scenario-entry?scenarioId=scn-base&returnTo=/scenarios/scn-base/expenses',
            )
          }
        >
          go-plain-add
        </button>
      );
    };
    render(
      withTheme(
        'light',
        <MemoryRouter
          initialEntries={[
            '/expenses/scenario-entry?scenarioId=scn-base&editLocalId=lid-1&returnTo=/scenarios/scn-base/expenses',
          ]}
        >
          <LocationProbe />
          <Navigator />
          <Routes>
            <Route
              path="/expenses/scenario-entry"
              element={<ExpenseFormPage />}
            />
            <Route
              path="/scenarios/:id/expenses"
              element={<div>scenario expenses</div>}
            />
          </Routes>
        </MemoryRouter>,
      ),
    );

    await screen.findByDisplayValue('Sabbatical');

    await user.click(screen.getByText('go-plain-add'));

    await waitFor(() =>
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(''),
    );
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'New trip' },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '3000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => screen.getByText('scenario expenses'));
    const after = (await getAggregate(
      'scenario',
      'scn-base',
    )) as Aggregate<ScenarioPayload> | null;
    const added = after?.payload.overrides.expenses?.added ?? [];
    expect(added).toHaveLength(2);
    expect(added.find((a) => a._localId === 'lid-1')?.name).toBe('Sabbatical');
    expect(added.some((a) => a.name === 'New trip')).toBe(true);
  });

  // A query-only transition to a missing editLocalId (browser back/forward against a deleted row) hit the not-found early return, which set `error` but left the old `state` non-null, masking the error branch with a stale form; the load now clears `state`/`baseline` first.
  it('shows the not-found error (not the stale form) on a transition to a missing editLocalId', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedCategory();
    await seedBaseScenario({
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
    });

    // Same route, query-only change to a missing editLocalId: React reuses the component instance.
    const Navigator: React.FC = () => {
      const navigate = useNavigate();
      return (
        <button
          type="button"
          onClick={() =>
            navigate(
              '/expenses/scenario-entry?scenarioId=scn-base&editLocalId=missing&returnTo=/scenarios/scn-base/expenses',
            )
          }
        >
          go-missing
        </button>
      );
    };
    render(
      withTheme(
        'light',
        <MemoryRouter
          initialEntries={[
            '/expenses/scenario-entry?scenarioId=scn-base&editLocalId=lid-1&returnTo=/scenarios/scn-base/expenses',
          ]}
        >
          <LocationProbe />
          <Navigator />
          <Routes>
            <Route
              path="/expenses/scenario-entry"
              element={<ExpenseFormPage />}
            />
            <Route
              path="/scenarios/:id/expenses"
              element={<div>scenario expenses</div>}
            />
          </Routes>
        </MemoryRouter>,
      ),
    );

    await screen.findByDisplayValue('Sabbatical');

    await user.click(screen.getByText('go-missing'));

    await waitFor(() => screen.getByText('Scenario-only expense not found.'));
    expect(screen.queryByDisplayValue('Sabbatical')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

describe('ExpenseFormPage — Reset overrides visibility + action', () => {
  it('hidden in canonical mode', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1');
    renderAt('/expenses/exp-1/edit');
    await screen.findByDisplayValue('Travel');
    expect(
      screen.queryByRole('button', { name: 'Reset overrides in this scenario' }),
    ).toBeNull();
  });

  it('hidden in scenario-patch mode when the scenario does not patch this expense', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario({});
    await seedExpense('exp-1');
    renderAt('/expenses/exp-1/edit?scenarioId=scn-base');
    await screen.findByDisplayValue('Travel');
    expect(
      screen.queryByRole('button', { name: 'Reset overrides in this scenario' }),
    ).toBeNull();
  });

  it('shown and deletes the patch when the scenario currently patches this expense', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario({
      expenses: { patches: { 'aggregate:exp-1': { amount: 9999 } } },
    });
    await seedExpense('exp-1', { amount: 1000 });
    renderAt('/expenses/exp-1/edit?scenarioId=scn-base');
    await screen.findByDisplayValue('Travel');

    const resetBtn = screen.getByRole('button', {
      name: 'Reset overrides in this scenario',
    });
    expect(resetBtn).toBeInTheDocument();
    fireEvent.click(resetBtn);

    await waitFor(async () => {
      const sc = (await getAggregate(
        'scenario',
        'scn-base',
      )) as Aggregate<ScenarioPayload> | null;
      expect(sc?.payload.overrides.expenses?.patches).toBeUndefined();
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('button', {
          name: 'Reset overrides in this scenario',
        }),
      ).toBeNull();
    });
  });

  it('Reset re-seeds the glide editor to the inherited/empty state (no stale glide shown)', async () => {
    // The canonical expense has no glide and the scenario patches one in; after Reset the editor must re-seed from the inherited canonical (toggle OFF), not stay stale.
    await seedMember();
    await seedCategory();
    await seedBaseScenario({
      expenses: {
        patches: {
          'aggregate:exp-1': {
            discretionaryGlide: {
              endMultiplierPct: 60,
              glideStart: { kind: 'year', year: 2030 },
              glideEnd: { kind: 'year', year: 2045 },
            },
          },
        },
      },
    });
    await seedExpense('exp-1', {
      classification: 'discretionary',
      discretionaryGlide: undefined,
    });
    renderAt('/expenses/exp-1/edit?scenarioId=scn-base');
    await screen.findByDisplayValue('Travel');

    expect(
      screen.getByRole('switch', { name: /enable spending glide/i }),
    ).toBeChecked();
    expect(screen.getByLabelText('End percentage')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Reset overrides in this scenario',
      }),
    );

    // The glide config is revealed only while the glide is enabled, so it leaves the DOM when off.
    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: /enable spending glide/i }),
      ).not.toBeChecked();
    });
    expect(screen.queryByLabelText('End percentage')).toBeNull();
    const sc = (await getAggregate(
      'scenario',
      'scn-base',
    )) as Aggregate<ScenarioPayload> | null;
    expect(sc?.payload.overrides.expenses?.patches).toBeUndefined();
  });
});

describe('ExpenseFormPage — Save validation', () => {
  it('caps the floor% slider at the current end% so a floor above end is unrepresentable', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { discretionaryGlide: ENABLED_GLIDE });
    renderAt('/expenses/exp-1/edit');
    await screen.findByDisplayValue('Travel');

    fireEvent.click(screen.getByRole('switch', { name: /hard floor/i }));

    // The floor can never exceed the glide end: the Floor % slider's max is pinned to the End % value, so floor > end is structurally impossible via the UI.
    const end = screen.getByRole('slider', { name: 'End percentage' });
    const floor = await screen.findByRole('slider', {
      name: 'Floor percentage',
    });
    expect(end).toHaveValue('60');
    expect(floor).toHaveAttribute('max', '60');
  });

  it('blocks save when the floor anchor is not strictly after glide-end', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', {
      discretionaryGlide: {
        endMultiplierPct: 50,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2040 },
        floor: { multiplierPct: 30, anchor: { kind: 'year', year: 2035 } },
      },
    });
    renderAt('/expenses/exp-1/edit');
    await screen.findByDisplayValue('Travel');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(
      /floor must begin after the glide ends/i,
    );
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.aggregateId === 'exp-1')).toBeUndefined();
  });

  it('blocks save for an enabled non-neutral glide with an age-0 anchor', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', {
      discretionaryGlide: {
        endMultiplierPct: 50,
        glideStart: { kind: 'year', year: 2030 },
        // An age anchor left at years 0 resolves to the birth month (a silently wrong full decline), so Save must reject it.
        glideEnd: { kind: 'age', memberId: 'primary', years: 0, months: 0 },
      },
    });
    renderAt('/expenses/exp-1/edit');
    await screen.findByDisplayValue('Travel');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(
      /glide point is missing an age/i,
    );
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.aggregateId === 'exp-1')).toBeUndefined();
  });

  it('blocks save when glide-end resolves at/before glide-start', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', {
      discretionaryGlide: {
        endMultiplierPct: 50,
        glideStart: { kind: 'year', year: 2040 },
        glideEnd: { kind: 'year', year: 2035 }, // before start
      },
    });
    renderAt('/expenses/exp-1/edit');
    await screen.findByDisplayValue('Travel');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(
      /glide must end after it starts/i,
    );
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.aggregateId === 'exp-1')).toBeUndefined();
  });

  it('blocks save for a mixed relative/absolute floor at-or-before glide-end against the real expense start', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', {
      // Absolute start so the probe resolves deterministically, independent of any scenario retirement year.
      start: { kind: 'year', year: 2030 },
      discretionaryGlide: {
        endMultiplierPct: 50,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2045 },
        // A relative floor 12 months after this expense's start (Jan 2031) is before glide-end (2045), so it must be rejected.
        floor: {
          multiplierPct: 30,
          anchor: { kind: 'durationFromExpenseStart', months: 12 },
        },
      },
    });
    renderAt('/expenses/exp-1/edit');
    await screen.findByDisplayValue('Travel');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(
      /floor must begin after the glide ends/i,
    );
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.aggregateId === 'exp-1')).toBeUndefined();
  });

  it('blocks save when glide-end is before glide-start even at the default 100% End (no-op shape)', async () => {
    // Regression: a discretionary expense with glide enabled, start 2050, end 2040 and End % left at the default 100 is isNeutralGlide-shaped, and the gate once skipped validation entirely, so the bad configuration saved silently.
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { discretionaryGlide: undefined });
    renderAt('/expenses/exp-1/edit');
    await screen.findByDisplayValue('Travel');

    const glideGroup = screen.getByRole('group', {
      name: /spending glide/i,
    });
    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    setGlideYear('Glide starts', '2050');
    setGlideYear('Glide ends', '2040');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(
      /glide must end after it starts/i,
    );
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.aggregateId === 'exp-1')).toBeUndefined();
  });

  // buildGlideCtx must carry the resolved retirement month, not 0. Retiring 2025-06-15 means glide `year(2025)` (Jan) → `retirementStart` (June) is valid only when the month is real; with `retirementMonth0: 0` it was falsely rejected.
  it('a mid-year retiree glide year(Y) → retirementStart (resolving to June Y) is NOT rejected', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario({
      retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
    });
    await seedExpense('exp-1', {
      start: { kind: 'year', year: 2025 },
      discretionaryGlide: {
        endMultiplierPct: 50,
        glideStart: { kind: 'year', year: 2025 },
        glideEnd: { kind: 'retirementStart' },
      },
    });
    renderAt('/expenses/exp-1/edit');
    await screen.findByDisplayValue('Travel');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const pending = await listPendingMutations();
      expect(pending.find((p) => p.aggregateId === 'exp-1')).toBeDefined();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a glide ending strictly before a mid-year retirement is still rejected', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario({
      retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
    });
    await seedExpense('exp-1', {
      discretionaryGlide: {
        endMultiplierPct: 50,
        glideStart: { kind: 'retirementStart' },
        glideEnd: { kind: 'year', year: 2025 },
      },
    });
    renderAt('/expenses/exp-1/edit');
    await screen.findByDisplayValue('Travel');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(
      /glide must end after it starts/i,
    );
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.aggregateId === 'exp-1')).toBeUndefined();
  });

  it('blocks save with a duplicate name within the canonical list', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { name: 'Travel' });
    await seedExpense('exp-2', { name: 'Groceries' });
    renderAt('/expenses/exp-1/edit');
    await screen.findByDisplayValue('Travel');

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Groceries' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/already exists/i);
  });
});

describe('ExpenseFormPage — returnTo redirect validation', () => {
  it.each([
    ['//evil.example'],
    ['/\\evil'],
    ['https://evil.example'],
  ])('navigates to /expenses (not off-site) for returnTo=%s', async (bad) => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { discretionaryGlide: undefined });
    renderAt(
      `/expenses/exp-1/edit?returnTo=${encodeURIComponent(bad)}`,
    );
    await screen.findByDisplayValue('Travel');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(lastLocation).toBe('/expenses'));
  });

  it('honours a valid relative returnTo on Cancel', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { discretionaryGlide: undefined });
    renderAt('/expenses/exp-1/edit?returnTo=%2Fscenarios%2Fscn-base%2Fexpenses');
    await screen.findByDisplayValue('Travel');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(lastLocation).toBe('/scenarios/scn-base/expenses'),
    );
  });
});

describe('ExpenseFormPage — returnTo with focusExpenseId survives Save and Cancel', () => {
  // The list-page Edit link carries `returnTo=<enc('/expenses?focusExpenseId=<id>')>`; Save or Cancel must navigate to the full returnTo, inner param included, so the list restores scroll and focus.

  const ENCODED_RETURN_TO = encodeURIComponent('/expenses?focusExpenseId=exp-1');
  const EXPECTED_LOCATION = '/expenses?focusExpenseId=exp-1';

  it('Save navigates to the full returnTo URL including focusExpenseId', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { discretionaryGlide: undefined });

    renderAt(`/expenses/exp-1/edit?returnTo=${ENCODED_RETURN_TO}`);
    await screen.findByDisplayValue('Travel');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(lastLocation).toBe(EXPECTED_LOCATION));
  });

  it('Cancel navigates to the full returnTo URL including focusExpenseId', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { discretionaryGlide: undefined });

    renderAt(`/expenses/exp-1/edit?returnTo=${ENCODED_RETURN_TO}`);
    await screen.findByDisplayValue('Travel');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(lastLocation).toBe(EXPECTED_LOCATION));
  });
});

describe('ExpenseFormPage — dirty-close guard', () => {
  it('surfaces the Unsaved changes prompt on a blocked in-app nav after a dirty glide edit', async () => {
    await seedMember();
    await seedCategory();
    await seedExpense('exp-1', { discretionaryGlide: ENABLED_GLIDE });
    renderAt('/expenses/exp-1/edit');
    await screen.findByDisplayValue('Travel');

    fireEvent.change(screen.getByLabelText('End percentage'), {
      target: { value: '30' },
    });

    // A real in-app pushState to another pathname is intercepted by the page-level guard while dirty.
    window.history.pushState({}, '', '/elsewhere');

    await waitFor(() =>
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument(),
    );

    // Restore the URL so test ordering stays deterministic.
    window.history.replaceState({}, '', '/');
  });
});

const fs = (o: Partial<FormState> = {}): FormState => ({
  name: 'Travel',
  description: '',
  amount: 1000,
  frequency: 'monthly',
  classification: 'essential',
  categoryId: 'cat-1',
  startKind: 'retirementStart',
  startMemberId: 'primary',
  startYears: 65,
  startMonths: 0,
  startYear: 2030,
  endKind: 'lifetime',
  endMemberId: 'primary',
  endYears: 95,
  endMonths: 0,
  endYear: 2060,
  endLifetimeWhose: 'primary',
  endOffsetYears: 0,
  endDurationValue: 12,
  endDurationUnit: 'months',
  discretionaryGlide: undefined,
  hsaQualified: false,
  ...o,
});

describe('buildExpensePayload — optional-field branches', () => {
  it('omits description / end / glide for a minimal one-off essential; trims the name', () => {
    const p = buildExpensePayload(
      fs({
        name: '  Trip  ',
        description: '   ',
        frequency: 'oneOff',
        classification: 'essential',
        discretionaryGlide: undefined,
      }),
    );
    expect(p.name).toBe('Trip');
    expect(p.frequency).toBe('oneOff');
    expect('description' in p).toBe(false);
    expect('end' in p).toBe(false); // one-off → buildEnd undefined
    expect('discretionaryGlide' in p).toBe(false);
  });

  it('includes a trimmed description, the resolved end, and the glide when set', () => {
    const p = buildExpensePayload(
      fs({
        description: '  beach money  ',
        frequency: 'monthly',
        classification: 'discretionary',
        endKind: 'lifetime',
        endLifetimeWhose: 'last',
        discretionaryGlide: ENABLED_GLIDE,
      }),
    );
    expect(p.description).toBe('beach money');
    expect(p.end).toEqual({ kind: 'lifetime', whose: 'last' });
    expect(p.discretionaryGlide).toEqual(ENABLED_GLIDE);
    expect(p.classification).toBe('discretionary');
  });
});

const RA_OVERRIDE = { retirementAge: { primary: { ageYears: 60, ageMonths: 2 } } };

async function seedChildScenario(): Promise<void> {
  const s: Aggregate<ScenarioPayload> = {
    id: 'scn-add',
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'Add target',
      description: '',
      parentScenarioId: 'scn-base',
      isPrimary: false,
      notes: '',
      overrides: RA_OVERRIDE,
    },
  };
  await putAggregate('scenario', s);
}

describe('ExpenseFormPage — projection preview', () => {
  it('renders the preview section with the no-amount guard on create', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario(RA_OVERRIDE);
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    expect(
      screen.getByRole('heading', { name: 'Projection preview' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Enter an amount to preview this expense.'),
    ).toBeInTheDocument();
  });

  it('projects the loaded expense on edit (no Save needed)', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario(RA_OVERRIDE);
    await seedExpense('exp-1', { amount: 1000, classification: 'essential' });
    renderAt('/expenses/exp-1/edit');
    await screen.findByDisplayValue('Travel');

    expect(
      screen.getByRole('heading', { name: 'Projection preview' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByText('Enter an amount to preview this expense.'),
      ).not.toBeInTheDocument(),
    );
  });

  it('updates the preview live as the amount changes, without saving', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario(RA_OVERRIDE);
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');
    expect(
      screen.getByText('Enter an amount to preview this expense.'),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '1500' },
    });
    // The ~200 ms debounce fires within waitFor's window.
    await waitFor(() =>
      expect(
        screen.queryByText('Enter an amount to preview this expense.'),
      ).not.toBeInTheDocument(),
    );
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.aggregateType === 'expense')).toBeUndefined();
  });

  it('resolves the preview under the scenario-add target, not the primary', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario({}); // primary, NO retirement age
    await seedChildScenario(); // scn-add carries the retirement age
    renderAt('/expenses/new?scenarioId=scn-add');
    await screen.findByLabelText('Name');

    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '1500' },
    });
    // scn-add resolves a retirement date; if the wiring used the primary scenario (no retirement age) the unresolvable guard would show instead.
    await waitFor(() =>
      expect(
        screen.queryByText('Enter an amount to preview this expense.'),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByText('Add a retirement age and birthdate to preview.'),
    ).not.toBeInTheDocument();
  });
});

describe('ExpenseFormPage — glide Save validation (shared validator)', () => {
  it('blocks Save when the glide starts before the expense does', async () => {
    await seedMember();
    await seedCategory();
    await seedBaseScenario(RA_OVERRIDE); // resolvable retirement ~2025
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Big trips' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Discretionary' }));
    const glideGroup = screen.getByRole('group', {
      name: /spending glide/i,
    });
    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    fireEvent.change(screen.getByLabelText('End percentage'), {
      target: { value: '60' },
    });
    // Year sliders floor at the current year, so put the expense's own start in the future; a glide start before it is the "glide starts before the expense" violation.
    setStartYear('2045');
    setGlideYear('Glide starts', '2030');
    setGlideYear('Glide ends', '2050');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(
        screen.getByText(/spending glide starts before the expense/i),
      ).toBeInTheDocument(),
    );
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.aggregateType === 'expense')).toBeUndefined();
  });

  it('a recurring glide that would block Save no longer blocks once frequency is One-off', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedCategory();
    await seedBaseScenario(RA_OVERRIDE); // resolvable retirement ~2025
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Home renovation' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Discretionary' }));
    const glideGroup = screen.getByRole('group', {
      name: /spending glide/i,
    });
    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    fireEvent.change(screen.getByLabelText('End percentage'), {
      target: { value: '60' },
    });
    setGlideYear('Glide starts', '1990');
    setGlideYear('Glide ends', '2050');

    // A one-off hides the glide section and is never glided, so a retained invalid glide must not block Save (it would be unfixable).
    await user.click(screen.getByLabelText('Frequency'));
    await user.click(await screen.findByRole('option', { name: 'One-off' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const pending = await listPendingMutations();
      const m = pending.find((p) => p.aggregateType === 'expense');
      expect(m).toBeDefined();
      expect(m?.operation).toBe('create');
      const pl = m?.payload as ExpensePayload;
      expect(pl.frequency).toBe('oneOff');
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('scenario-only-add Save validates the glide under the add-target scenario, not primary', async () => {
    await seedMember(); // primary born 1965-04-15
    await seedCategory();
    // The primary retires at 65 (~2030) but the add-target at 50 (~2015). Glide start 2020 is valid under the add-target and would be rejected under primary; Save must thread the add-target (parity with the live preview).
    await seedBaseScenario({
      retirementAge: { primary: { ageYears: 65, ageMonths: 0 } },
    });
    const addTarget: Aggregate<ScenarioPayload> = {
      id: 'scn-add',
      householdId: HH,
      aggregateType: 'scenario',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Add target',
        description: '',
        parentScenarioId: 'scn-base',
        isPrimary: false,
        notes: '',
        overrides: {
          retirementAge: { primary: { ageYears: 50, ageMonths: 0 } },
        },
      },
    };
    await putAggregate('scenario', addTarget);

    renderAt('/expenses/new?scenarioId=scn-add');
    await screen.findByLabelText('Name');

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Add-target trips' },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '500' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Discretionary' }));
    const glideGroup = screen.getByRole('group', {
      name: /spending glide/i,
    });
    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    fireEvent.change(screen.getByLabelText('End percentage'), {
      target: { value: '60' },
    });
    setGlideYear('Glide starts', '2020');
    setGlideYear('Glide ends', '2060');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const sc = (await getAggregate(
        'scenario',
        'scn-add',
      )) as Aggregate<ScenarioPayload> | null;
      const added = sc?.payload.overrides.expenses?.added ?? [];
      expect(added.length).toBe(1);
      expect(added[0].discretionaryGlide?.endMultiplierPct).toBe(60);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Regression: a `lifetime`-ended expense with an `expenseEnd` glide-end must resolve at the scenario's life expectancy (70, so April 2035) on the Save path, like the live preview, not at DEFAULT_LIFE_EXPECTANCY_AGE (95); `buildGlideCtx` once omitted `lifeExpectancy` and falsely accepted what the preview rejects.
  it('a lifetime-ended + expenseEnd glide-end resolves at the scenario life expectancy on Save (preview↔Save parity)', async () => {
    await seedMember(); // primary born 1965-04-15
    await seedCategory();
    // Only `lifeExpectancy: { primary: 70 }` matters; a resolvable retirement age is needed for the context to resolve at all.
    await seedBaseScenario({
      retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
      lifeExpectancy: { primary: 70 },
    });
    await seedExpense('exp-le', {
      amount: 1000,
      frequency: 'monthly',
      classification: 'discretionary',
      start: { kind: 'year', year: 2030 },
      end: { kind: 'lifetime', whose: 'primary' },
      discretionaryGlide: {
        endMultiplierPct: 60,
        glideStart: { kind: 'year', year: 2050 },
        glideEnd: { kind: 'expenseEnd' },
      },
    });
    renderAt('/expenses/exp-le/edit');
    await screen.findByDisplayValue('Travel');

    await waitFor(() =>
      expect(
        screen.getByText(/glide must end after it starts/i),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(
      /glide must end after it starts/i,
    );
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.aggregateId === 'exp-le')).toBeUndefined();
  });
});

describe('ExpenseFormPage — workspace-change does not clobber an in-progress draft (exclusion)', () => {
  it('preserves the typed draft when WORKSPACE_CHANGED_EVENT fires', async () => {
    await seedMember();
    await seedCategory();
    renderAt('/expenses/new');
    const nameInput = (await screen.findByLabelText('Name')) as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: 'Greece trip' } });
    expect(nameInput.value).toBe('Greece trip');

    // A sync pull, demo fill or bootstrap dispatches the workspace-change event mid-edit; the form page is mount-only by design, so its load effect must not re-run and reset the draft.
    const { notifyWorkspaceChanged } = await import('../lib/workspace-events');
    await act(async () => {
      notifyWorkspaceChanged();
    });

    expect(
      (screen.getByLabelText('Name') as HTMLInputElement).value,
    ).toBe('Greece trip');
  });
});

describe('ExpenseFormPage — hsaQualified toggle', () => {
  async function seedMedicalCategory() {
    const c: Aggregate<ExpenseCategoryPayload> = {
      id: 'cat-med',
      householdId: HH,
      aggregateType: 'expenseCategory',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: { name: 'Medical', isMedical: true },
    };
    await putAggregate('expenseCategory', c);
  }

  async function selectMedicalCategory(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByLabelText('Category'));
    await user.click(await screen.findByRole('option', { name: 'Medical' }));
  }

  it('toggle does NOT appear for a non-medical category', async () => {
    await seedMember();
    await seedCategory(); // only Leisure (non-medical)
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');
    expect(
      screen.queryByRole('switch', { name: /HSA/i }),
    ).not.toBeInTheDocument();
  });

  it('toggle APPEARS when a medical category is selected', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedCategory();
    await seedMedicalCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    await selectMedicalCategory(user);

    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: /can be paid tax-free from an hsa/i }),
      ).toBeInTheDocument(),
    );
  });

  it('new medical expense defaults the toggle to ON (qualified=true)', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedCategory();
    await seedMedicalCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    await selectMedicalCategory(user);

    await waitFor(() => {
      const toggle = screen.getByRole('switch', {
        name: /can be paid tax-free from an hsa/i,
      });
      // React Aria Switch renders role="switch" on a hidden input; toBeChecked() reads its checked state.
      expect(toggle).toBeChecked();
    });
  });

  it('a saved expense with absent hsaQualified loads toggle as OFF (absent ⇒ not qualified)', async () => {
    await seedMember();
    await seedCategory();
    await seedMedicalCategory();
    await seedExpense('exp-legacy', {
      name: 'Legacy Medical',
      categoryId: 'cat-med',
      // hsaQualified intentionally absent
    });
    await seedBaseScenario();
    renderAt('/expenses/exp-legacy/edit');
    await screen.findByLabelText('Name');

    await waitFor(() => {
      const toggle = screen.getByRole('switch', {
        name: /can be paid tax-free from an hsa/i,
      });
      expect(toggle).not.toBeChecked();
    });
  });

  it('hsaQualified value is retained when user briefly switches to a non-medical category then back', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedCategory(); // Leisure, non-medical, id=cat-1
    await seedMedicalCategory(); // Medical, isMedical, id=cat-med
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    await selectMedicalCategory(user);
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: /can be paid tax-free from an hsa/i }),
      ).toBeChecked(),
    );

    fireEvent.click(
      screen.getByRole('switch', { name: /can be paid tax-free from an hsa/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: /can be paid tax-free from an hsa/i }),
      ).not.toBeChecked(),
    );

    await user.click(screen.getByLabelText('Category'));
    await user.click(await screen.findByRole('option', { name: 'Leisure' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('switch', { name: /can be paid tax-free from an hsa/i }),
      ).not.toBeInTheDocument(),
    );

    await selectMedicalCategory(user);
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: /can be paid tax-free from an hsa/i }),
      ).not.toBeChecked(),
    );
  });

  it('(i) affordance trigger is keyboard-operable and opens explainer (a11y)', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedCategory();
    await seedMedicalCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    await selectMedicalCategory(user);

    await waitFor(() =>
      screen.getByRole('button', { name: /what an hsa can pay for tax-free/i }),
    );

    const trigger = screen.getByRole('button', {
      name: /what an hsa can pay for tax-free/i,
    });
    await user.click(trigger);

    await waitFor(() =>
      expect(
        screen.getByRole('dialog', { name: /what an hsa can pay for tax-free/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('note')).toBeInTheDocument();
  });

  it('the explainer footer names no profession in its consult instruction', async () => {
    // Nothing else catches a revert: no other check bans profession names; every consult-a-professional instruction reads "an appropriately qualified professional".
    const user = userEvent.setup();
    await seedMember();
    await seedCategory();
    await seedMedicalCategory();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    await selectMedicalCategory(user);

    await waitFor(() =>
      screen.getByRole('button', { name: /what an hsa can pay for tax-free/i }),
    );
    await user.click(
      screen.getByRole('button', { name: /what an hsa can pay for tax-free/i }),
    );
    await waitFor(() => expect(screen.getByRole('note')).toBeInTheDocument());

    const noteText = (screen.getByRole('note').textContent ?? '').replace(/\s+/g, ' ');
    expect(noteText).toContain(
      'Verify against official IRS guidance (Publications 969 and 502) or check with an appropriately qualified professional.',
    );
    expect(noteText).not.toContain('tax professional');
  });

  it('payload round-trip: saving qualified=true persists hsaQualified=true in the store', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedCategory();
    await seedMedicalCategory();
    await seedBaseScenario();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Doctor visits' },
    });
    await selectMedicalCategory(user);

    await waitFor(() => {
      const toggle = screen.getByRole('switch', {
        name: /can be paid tax-free from an hsa/i,
      });
      expect(toggle).toBeChecked();
    });

    setStartYear('2035');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const pending = await listPendingMutations();
      const mutation = pending.find((p) => p.aggregateType === 'expense');
      expect(mutation).toBeDefined();
      if (mutation) {
        const payload = mutation.payload as ExpensePayload;
        expect(payload.hsaQualified).toBe(true);
      }
    });
  });

  it('payload round-trip: saving qualified=false does NOT persist hsaQualified in the store (sparse)', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedCategory();
    await seedMedicalCategory();
    await seedBaseScenario();
    renderAt('/expenses/new');
    await screen.findByLabelText('Name');

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'ACA Premium' },
    });
    await selectMedicalCategory(user);

    await waitFor(() =>
      screen.getByRole('switch', {
        name: /can be paid tax-free from an hsa/i,
      }),
    );
    fireEvent.click(
      screen.getByRole('switch', { name: /can be paid tax-free from an hsa/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('switch', {
          name: /can be paid tax-free from an hsa/i,
        }),
      ).not.toBeChecked(),
    );

    setStartYear('2035');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const pending = await listPendingMutations();
      const mutation = pending.find((p) => p.aggregateType === 'expense');
      expect(mutation).toBeDefined();
      if (mutation) {
        const payload = mutation.payload as ExpensePayload;
        // Sparse-optional: false is not stored (absent is false).
        expect(payload.hsaQualified).toBeUndefined();
      }
    });
  });
});
