/**
 * ExpenseFormPage — canonical + scenario-patch flows.
 *
 * Drives IndexedDB through fake-indexeddb (seeded via `putAggregate`);
 * mocks AuthContext + SyncContext like the sibling page tests. Covers:
 * the glide section gating on classification, canonical persist,
 * scenario-patch sparse delta + pre-existing-key preservation,
 * clear-inherited semantics, Reset-overrides visibility + action,
 * Save validation, the returnTo redirect allow/deny, and the
 * dirty-close guard. Page-level tests don't need axe (components/ only).
 */
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
  // The form's live projection preview embeds a chart that reads
  // useChartColors() → needs a ThemeProvider ancestor.
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

// Each glide anchor is a collapsible AnchorCard: expand it, pick the
// "In year" kind, and set the year. (Default age anchors seed at year 0,
// which save-time validation rejects, so tests pin resolvable years.)
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

// Set the expense's own Start to a calendar year (open the Start card,
// pick "In year", set the year slider).
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

    // Default classification is essential → the glide group now SHOWS
    // (the gate is frequency, not classification).
    const essentialRadio = screen.getByRole('radio', { name: 'Essential' });
    const discretionaryRadio = screen.getByRole('radio', { name: 'Discretionary' });
    const glideGroup = screen.getByRole('group', { name: /spending glide/i });
    expect(glideGroup).toBeInTheDocument();

    // Enable the glide on the essential expense.
    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    expect(screen.getByLabelText('End percentage')).toBeInTheDocument();

    // Flip to discretionary → group still present (no crash, no unmount).
    fireEvent.click(discretionaryRadio);
    expect(
      screen.getByRole('group', { name: /spending glide/i }),
    ).toBeInTheDocument();

    // Back to essential → still present.
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

    // Make it discretionary → glide group shows for the default
    // (recurring) frequency.
    fireEvent.click(screen.getByRole('radio', { name: 'Discretionary' }));
    expect(
      screen.getByRole('group', { name: /spending glide/i }),
    ).toBeInTheDocument();

    // Flip frequency to One-off → the entire glide section is gone (a
    // glide is meaningless for a single lump-sum event).
    await user.click(screen.getByLabelText('Frequency'));
    await user.click(await screen.findByRole('option', { name: 'One-off' }));
    expect(
      screen.queryByRole('group', { name: /spending glide/i }),
    ).toBeNull();

    // Flip back to a recurring frequency → the glide section returns.
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
    // Draft a glide while recurring.
    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    expect(screen.getByLabelText('End percentage')).toBeInTheDocument();

    // Flip to one-off → the whole section (and the drafted glide
    // fields) is unrendered.
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

    // Default classification is essential — the section is present.
    expect(
      screen.getByRole('group', { name: /spending glide/i }),
    ).toBeInTheDocument();
    // The relaxed aria-live announcement no longer ties to "discretionary".
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
    // Leave classification at the default essential.
    const glideGroup = screen.getByRole('group', { name: /spending glide/i });
    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    // A rising glide on an essential.
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
    // Glide-end (2035) before glide-start (2045) → invalid for any
    // classification under the shared `glideProblem`.
    setGlideYear('Glide starts', '2045');
    setGlideYear('Glide ends', '2035');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(/must end after it starts/i),
    ).toBeInTheDocument();
    // No expense mutation was queued.
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
    // Set resolvable year anchors (default age anchors seed at years 0,
    // which save-time validation rejects).
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
    // Enable the glide, change NOTHING else (End stays at default 100).
    fireEvent.click(
      within(glideGroup).getByRole('switch', {
        name: /enable spending glide/i,
      }),
    );
    // Give resolvable anchors so save-time validation passes (the
    // enablement-persistence is the assertion, not anchor validation).
    setGlideYear('Glide starts', '2030');
    setGlideYear('Glide ends', '2045');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    let saved: NonNullable<ExpensePayload['discretionaryGlide']> | undefined;
    await waitFor(async () => {
      const pending = await listPendingMutations();
      const m = pending.find((p) => p.aggregateId === 'exp-1');
      expect(m?.operation).toBe('update');
      const pl = m?.payload as ExpensePayload;
      // A present object — NOT undefined — even though End is still 100.
      expect(pl.discretionaryGlide).toBeDefined();
      expect(pl.discretionaryGlide?.endMultiplierPct).toBe(100);
      saved = pl.discretionaryGlide;
    });

    // Reopen: the saved glide canonically present at 100% must seed the
    // toggle ON (canonical absence = off, presence = on).
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

    // Change the end multiplier from 60 → 40.
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

// Seeds a second household member so the Start age radio renders the
// generic "At age" label (and the member dropdown can appear).
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
    // The Start picker is the collapsible AnchorCard: its trigger's name
    // is exactly the label "Start".
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
    // Pick the age kind, then move the years slider.
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
      // Expense always keeps memberId explicitly (no ownerRole passed).
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

    // Change only the name; amount untouched.
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
      // Unchanged keys are NOT written into the sparse patch.
      expect(patch && 'amount' in patch).toBe(false);
    });
    // Canonical aggregate untouched.
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

    // Configure a glide (the expense is discretionary by seed default).
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
    // Set resolvable year anchors (the default age anchors seed at
    // years 0, which save-time validation now rejects).
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
      // Pre-existing amount key preserved AND the new glide key added.
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

    // Glide seeds enabled; toggle it OFF.
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
      // Cleared via the null marker (the resolver strips the key → engine
      // default), replacing the former value-equivalent neutral object.
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

    // Frequency is the shared React Aria <Select>: open it
    // and pick "One-off".
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
      // A one-off has no end window → the inherited end is cleared.
      expect(patch).toHaveProperty('end', null);
    });
    // No inline error surfaced.
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
    // Seeded with the entry's stored values.
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
      // Count unchanged — replaced in place, not appended.
      expect(added).toHaveLength(2);
      const edited = added.find((a) => a._localId === 'lid-1');
      expect(edited?.name).toBe('Long sabbatical');
      expect(edited?.amount).toBe(7000);
      // The sibling entry is untouched.
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

    // In-router navigator: both URLs match the SAME `/expenses/scenario-entry`
    // route, so React reuses the component instance — only the query
    // (editLocalId) changes. Without the reset, the stale
    // `editingAddedLocalId` would make the second Save replace lid-1.
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

    // Add-edit mode: seeded with lid-1's stored name.
    await screen.findByDisplayValue('Sabbatical');

    // Transition to plain add (query loses editLocalId) — same component.
    await user.click(screen.getByText('go-plain-add'));
    // The form re-seeds empty (plain add), confirming the load re-ran.
    await waitFor(() =>
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(''),
    );

    // Fill a fresh expense and Save — must APPEND, not replace lid-1.
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
    // Appended: original lid-1 still present + a new entry.
    expect(added).toHaveLength(2);
    expect(added.find((a) => a._localId === 'lid-1')?.name).toBe('Sabbatical');
    expect(added.some((a) => a.name === 'New trip')).toBe(true);
  });

  // On a same-component query-only transition the prior load left
  // `loading` false, so without re-entering the loading state the reseed
  // window would render the stale add-edit form (with Save reachable
  // against the old row) and could leave a stale load `error` visible. The
  // fix re-enters `loading` (gating the form body / Save) and clears
  // `error` at the start of the load. Assert the post-transition form is
  // the freshly re-seeded plain-add form with NO stale error, and that a
  // Save in that window APPENDS (does not replace the old row).
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

    // Add-edit mode: seeded with lid-1's stored name (the load settled).
    await screen.findByDisplayValue('Sabbatical');

    // Transition to plain add — the load effect re-runs. The fix re-enters
    // `loading` (skeleton gates the stale form + Save out of the tree) and
    // clears `error`, so the reseed window never exposes a
    // stale-but-actionable form.
    await user.click(screen.getByText('go-plain-add'));

    // Reseed completes → empty plain-add form, no stale error surfaced.
    await waitFor(() =>
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(''),
    );
    expect(screen.queryByRole('alert')).toBeNull();

    // A Save now must APPEND a fresh entry, never replace the old lid-1
    // row (which the stale `editingAddedLocalId` would have done).
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

  // On a same-component, same-route, query-only transition to a
  // MISSING editLocalId (reachable via browser back/forward against a
  // since-deleted row, or a hand-crafted URL) the load hits its not-found
  // early return — it sets `error` but the `finally` clears `loading`,
  // leaving the OLD `state` non-null. The `!state && error` error branch
  // would then be masked and the stale add-edit form would render (with
  // Save reachable against the stale row through the canonical branch). The
  // fix clears `state`/`baseline` at the start of the load, so the
  // not-found path renders the error, NOT the stale form.
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

    // Same `/expenses/scenario-entry` route, query-only change to a missing
    // editLocalId — React reuses the component instance.
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

    // Add-edit mode: the form settled, seeded with lid-1's stored name.
    await screen.findByDisplayValue('Sabbatical');

    // Transition to a missing editLocalId — the load re-runs and hits the
    // not-found return.
    await user.click(screen.getByText('go-missing'));

    // The error renders (not masked by a stale form).
    await waitFor(() => screen.getByText('Scenario-only expense not found.'));
    // The stale form is gone: no Save against the old row, no stale name.
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
    // Button disappears once the patch is gone (re-seeded from inherited).
    await waitFor(() => {
      expect(
        screen.queryByRole('button', {
          name: 'Reset overrides in this scenario',
        }),
      ).toBeNull();
    });
  });

  it('Reset re-seeds the glide editor to the inherited/empty state (no stale glide shown)', async () => {
    // Canonical expense has NO glide; the scenario patches one in. The
    // form opens in scenario-patch mode with the glide editor seeded
    // from the patched value (toggle ON). After Reset the patch is
    // dropped and the editor must re-seed from the now-inherited
    // canonical (no glide) — toggle OFF, fields collapsed, not stale.
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

    // Patched glide → editor seeds ON with the End % visible.
    expect(
      screen.getByRole('switch', { name: /enable spending glide/i }),
    ).toBeChecked();
    expect(screen.getByLabelText('End percentage')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Reset overrides in this scenario',
      }),
    );

    // After Reset: patch gone, editor re-seeded from inherited (no
    // glide) → toggle OFF. The glide config (End %, anchors) is now
    // revealed only while the glide is enabled, so it's removed from the
    // DOM when off (mockup reveal pattern).
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

    // Reveal the hard-floor fields.
    fireEvent.click(screen.getByRole('switch', { name: /hard floor/i }));

    // The End % is 60 (ENABLED_GLIDE). The floor can never exceed the
    // glide end, so the Floor % slider's max is pinned to the End %
    // value — floor > end is structurally impossible via the UI (which
    // is why the old "blocks save when floor% > end%" path is gone).
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
        // age anchor left at years 0 → resolves to birth month
        // (silently-wrong full decline). Save must reject it.
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
      // Absolute start so the probe resolves deterministically (Jan 2030)
      // independent of any scenario retirement year.
      start: { kind: 'year', year: 2030 },
      discretionaryGlide: {
        endMultiplierPct: 50,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2045 },
        // Relative floor: 12 months after THIS expense's start (Jan 2030)
        // = Jan 2031, before glide-end (2045) → must be rejected.
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
    // The exact user-reported scenario: a canonical discretionary
    // expense, glide enabled, glide-start 2050, glide-end 2040, End
    // percentage left at the default 100. The glide is isNeutralGlide-
    // shaped (end = 100, no floor) — the pre-fix gate skipped validation
    // entirely, so the bad end-before-start configuration saved silently.
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
    // Leave End percentage at its default (100) — do NOT touch it.
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

  // buildGlideCtx must carry the resolved retirement MONTH, not 0.
  // Member born 1965-04-15; retirement age 60y 2m → retires 2025-06-15
  // (June, month0 = 5). Expense itself starts year(2025) (Jan) so the
  // glide-start year(2025) (Jan) is NOT before the expense — isolating
  // the month-carried concern from the separate
  // glide-before-expense-start rule. A glide `year(2025)` (Jan 2025) →
  // `retirementStart` (June 2025) is valid because glide-end resolves
  // *after* glide-start — but only when the retirement month is real.
  // The pre-fix code hardcoded retirementMonth0: 0, so retirement
  // resolved to Jan 2025 == glide-start and it was FALSELY rejected.
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

    // No glide error; the save proceeds and queues the mutation.
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
        // glide-start = retirementStart (June 2025); glide-end =
        // year(2025) (Jan 2025) resolves strictly before it → rejected.
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
  // The canonical list-page Edit link is:
  //   /expenses/<id>/edit?returnTo=<enc('/expenses?focusExpenseId=<id>')>
  // After a successful Save or Cancel the form must navigate to the full
  // returnTo value (including the inner ?focusExpenseId param) so the
  // list page can restore scroll position + focus on return.

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

    // Dirty the form via a glide edit.
    fireEvent.change(screen.getByLabelText('End percentage'), {
      target: { value: '30' },
    });

    // A real in-app pushState to another pathname is intercepted by the
    // page-level guard while dirty (same probe the guard's own tests use).
    window.history.pushState({}, '', '/elsewhere');

    await waitFor(() =>
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument(),
    );

    // Restore the URL so test ordering stays deterministic.
    window.history.replaceState({}, '', '/');
  });
});

// ---------------------------------------------------------------------
// buildExpensePayload — pure FormState→ExpensePayload assembly.
// The existing save-path tests above are the behaviour-preservation
// guard for the extraction; these add direct coverage of the optional
// description / end / discretionaryGlide branches.
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Live single-expense projection preview wiring.
// ---------------------------------------------------------------------

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
    // Default amount is 0 → wrapper guard, no chart.
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
    // First paint is immediate (amount 1000 + resolvable scenario) →
    // the no-amount guard must NOT be showing.
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
    // The ~200 ms debounce fires within waitFor's window; the guard is
    // replaced by the chart subtree — no Save click.
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
    // scn-add resolves a retirement date → the chart renders. If the
    // wiring wrongly used the primary scenario (no retirement age) the
    // unresolvable guard would show instead.
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
    // Put the expense's own start in the future (year sliders floor at
    // the current year, so the old past-year glide-start setup is no
    // longer reachable). A glide-start before that future expense start
    // reproduces the same "glide starts before the expense" violation.
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
    // Same invalid shape the prior test proves blocks Save: glide-start
    // (year 1990) resolves well before the expense's ~2025 start.
    setGlideYear('Glide starts', '1990');
    setGlideYear('Glide ends', '2050');

    // Flip frequency to One-off → the glide section is hidden and a
    // one-off is never glided. The retained, otherwise-invalid glide
    // must NOT block Save (it would be an unfixable error).
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
    // Primary (base) retires at 65 → ~2030-04. The add-target
    // overrides retirement to 50 → ~2015-04. A glide whose start is
    // year 2020 is valid under the add-target (2020 ≥ the 2015 expense
    // start) but the primary scenario's later 2030 start would reject
    // it ("glide starts before the expense"). Previously the Save path
    // resolved the glide under primary and wrongly blocked; Save now threads
    // the add-target so Save succeeds (parity with the live preview).
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
    // Glide-start year 2020 — after the add-target's ~2015 retirement
    // start, before the primary's ~2030 start.
    setGlideYear('Glide starts', '2020');
    setGlideYear('Glide ends', '2060');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Save succeeds: the add-target context makes the glide valid, so
    // the expense is written into the add-target's added[] (no inline
    // error, despite the primary scenario's context rejecting it).
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

  // A-r3-1 regression: a `lifetime`-ended expense with an `expenseEnd`
  // glide-end must resolve its glide-end at the SCENARIO's life
  // expectancy on the Save path, exactly as the live preview/engine
  // does — not at DEFAULT_LIFE_EXPECTANCY_AGE (95). Member born
  // 1965-04-15; the base scenario overrides primary life expectancy to
  // 70 → `lifetime(primary)` resolves to April 2035. Glide-start
  // year(2050) (Jan 2050) is AFTER the expense's own year(2030) start
  // (so the before-expense rule is not the cause) but AFTER the
  // life-expectancy-70 end → the ordering rule must reject it. Without
  // the fix `buildGlideCtx` omits `lifeExpectancy`, so the Save path
  // falls back to age 95 (end April 2060 > glide-start) and FALSELY
  // accepts while the preview (which threads life expectancy 70)
  // rejects — the non-neutral preview↔Save parity invariant is broken.
  it('A-r3-1: a lifetime-ended + expenseEnd glide-end resolves at the scenario life expectancy on Save (preview↔Save parity)', async () => {
    await seedMember(); // primary born 1965-04-15
    await seedCategory();
    // A resolvable retirement age is required so the preview/engine
    // context resolves at all; the absolute year(2030)/year(2050)
    // anchors below don't depend on the retirement date, so its value
    // is immaterial — only `lifeExpectancy: { primary: 70 }` matters.
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

    // Parity reference: the live preview always threads the scenario's
    // resolved life expectancy (70) via buildExpenseProjectionContext,
    // so it resolves the glide-end to April 2035 (< the year-2050
    // glide-start) and surfaces the shared ordering message as visible
    // error text. This is the verdict the Save path must agree with.
    await waitFor(() =>
      expect(
        screen.getByText(/glide must end after it starts/i),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Post-fix: the Save path's buildGlideCtx now also carries life
    // expectancy 70, so it resolves the glide-end identically and
    // BLOCKS the save with the same message — no mutation queued.
    // (Pre-fix it would fall back to age 95, accept, and queue.)
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

    // Begin an in-progress edit.
    fireEvent.change(nameInput, { target: { value: 'Greece trip' } });
    expect(nameInput.value).toBe('Greece trip');

    // A sync pull / demo fill / bootstrap commits and dispatches the
    // workspace-change event while the user is mid-edit. The form page is
    // mount-only by design — its load effect must NOT
    // re-run and reset the draft.
    const { notifyWorkspaceChanged } = await import('../lib/workspace-events');
    await act(async () => {
      notifyWorkspaceChanged();
    });

    // The draft survives — the Name still holds the user's input.
    expect(
      (screen.getByLabelText('Name') as HTMLInputElement).value,
    ).toBe('Greece trip');
  });
});

// ---------------------------------------------------------------------------
// HSA-qualified toggle — UI tests.
// The toggle shows only for medical categories; its value is retained on a
// non-medical detour; a new expense defaults to qualified=true;
// a legacy absent row loads as not-qualified (false); payload round-trip.
// ---------------------------------------------------------------------------
describe('ExpenseFormPage — hsaQualified toggle', () => {
  /** Seed a medical category alongside the default non-medical one. */
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

  /** Select the Medical category using the React Aria Select pattern. */
  async function selectMedicalCategory(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByLabelText('Category'));
    await user.click(await screen.findByRole('option', { name: 'Medical' }));
  }

  it('toggle does NOT appear for a non-medical category', async () => {
    await seedMember();
    await seedCategory(); // only Leisure (non-medical)
    renderAt('/expenses/new');
    // Form renders after data loads.
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
      // React Aria Switch renders role="switch" on a hidden input;
      // toBeChecked() checks the underlying input checked state.
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
      // React Aria Switch renders role="switch" on a hidden input;
      // toBeChecked() / not.toBeChecked() checks the underlying state.
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

    // Switch to Medical — toggle appears and defaults ON.
    await selectMedicalCategory(user);
    // React Aria Switch renders role="switch" on a hidden input;
    // toBeChecked() / not.toBeChecked() checks the underlying state.
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: /can be paid tax-free from an hsa/i }),
      ).toBeChecked(),
    );

    // Turn the toggle OFF.
    fireEvent.click(
      screen.getByRole('switch', { name: /can be paid tax-free from an hsa/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: /can be paid tax-free from an hsa/i }),
      ).not.toBeChecked(),
    );

    // Switch to Leisure (non-medical) — toggle disappears.
    await user.click(screen.getByLabelText('Category'));
    await user.click(await screen.findByRole('option', { name: 'Leisure' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('switch', { name: /can be paid tax-free from an hsa/i }),
      ).not.toBeInTheDocument(),
    );

    // Switch back to Medical — toggle reappears; value is retained as OFF.
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
    // Keyboard operability: pressing the trigger button should open the dialog.
    await user.click(trigger);

    await waitFor(() =>
      expect(
        screen.getByRole('dialog', { name: /what an hsa can pay for tax-free/i }),
      ).toBeInTheDocument(),
    );
    // The disclaimer footer carries role="note".
    expect(screen.getByRole('note')).toBeInTheDocument();
  });

  it('the explainer footer names no profession in its consult instruction', async () => {
    // Every consult-a-professional instruction in current copy reads "an
    // appropriately qualified professional" — no profession is enumerated.
    // Nothing else catches a revert here: no other check bans
    // profession names.
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

    // Fill required fields.
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Doctor visits' },
    });
    await selectMedicalCategory(user);

    // Toggle should default to ON; leave it.
    // React Aria Switch renders role="switch" on a hidden input;
    // toBeChecked() checks the underlying input checked state.
    await waitFor(() => {
      const toggle = screen.getByRole('switch', {
        name: /can be paid tax-free from an hsa/i,
      });
      expect(toggle).toBeChecked();
    });

    // Set start year to resolve Start anchor.
    setStartYear('2035');

    // Save.
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

    // Toggle defaults ON; turn it OFF.
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
        // Sparse-optional: false is NOT stored (absent ≡ false).
        expect(payload.hsaQualified).toBeUndefined();
      }
    });
  });
});
