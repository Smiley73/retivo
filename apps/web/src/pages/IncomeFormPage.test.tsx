/**
 * IncomeFormPage — tracksInflation toggle tests.
 *
 * Covers: toggle rendered for pension/partTime; toggle on → COLA input
 * disabled (shows scenario rate); toggle off → COLA input editable;
 * Persistence rule (colaPct absent from saved payload when tracking).
 */
import 'fake-indexeddb/auto';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  getAggregate,
  putAggregate,
  listPendingMutations,
} from '../db/store';
import type {
  Aggregate,
  AccountPayload,
  AccountTaxTreatment,
  AccountType,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  ScenarioPayload,
} from '../db/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { IncomeFormPage } from './IncomeFormPage';

const HH = 'hh-income-form-test';

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
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/income/new" element={<IncomeFormPage />} />
        <Route path="/income/scenario-entry" element={<IncomeFormPage />} />
        <Route path="/income/:id/edit" element={<IncomeFormPage />} />
        <Route path="/income" element={<div>income list</div>} />
        <Route
          path="/scenarios/:id/income"
          element={<div>scenario income</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

/** Seeds a parent scenario (4% inflation) + a child scenario (no inflation
 *  override). Returns `{ parentId, childId }`. */
async function seedScenarios(): Promise<{ parentId: string; childId: string }> {
  const parent: Aggregate<ScenarioPayload> = {
    id: 'sc-parent',
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'Parent',
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: { inflation: { ratePct: 4 } },
    },
  };
  const child: Aggregate<ScenarioPayload> = {
    id: 'sc-child',
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'Child',
      description: '',
      parentScenarioId: 'sc-parent',
      isPrimary: false,
      notes: '',
      overrides: {},
    },
  };
  await putAggregate('scenario', parent);
  await putAggregate('scenario', child);
  return { parentId: 'sc-parent', childId: 'sc-child' };
}

async function seedMember(): Promise<void> {
  const m: Aggregate<HouseholdMemberPayload> = {
    id: 'hm-income-1',
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

async function seedPensionStream(overrides: Partial<IncomeStreamPayload> = {}): Promise<void> {
  const stream: Aggregate<IncomeStreamPayload> = {
    id: 'income-pension-1',
    householdId: HH,
    aggregateType: 'incomeStream',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'ACME Pension',
      notes: '',
      memberId: 'hm-income-1',
      kind: 'pension',
      payoutType: 'annuity',
      monthlyBenefit: 1200,
      tracksInflation: true,
      jointAndSurvivorPct: 0,
      start: { kind: 'age', years: 65, months: 0 },
      taxable: true,
      ...overrides,
    },
  };
  await putAggregate('incomeStream', stream);
}

beforeEach(async () => {
  setupContexts();
  lastLocation = '';
  await seedMember();
});

afterEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
});

describe('IncomeFormPage — tracksInflation toggle (pension)', () => {
  it('renders "Use scenario inflation" switch for a new pension stream', async () => {
    renderAt('/income/new');
    await waitFor(() => screen.getByRole('switch', { name: /use scenario inflation/i }));
    // Default kind = pension; switch must be visible.
    expect(screen.getByRole('switch', { name: /use scenario inflation/i })).toBeInTheDocument();
  });

  it('toggle on → Annual COLA input is disabled', async () => {
    renderAt('/income/new');
    await waitFor(() => screen.getByRole('switch', { name: /use scenario inflation/i }));
    const toggle = screen.getByRole('switch', { name: /use scenario inflation/i });
    // New stream defaults to tracking (toggle on).
    expect(toggle).toBeChecked();
    // COLA input is disabled when tracking.
    const colaInput = screen.getByRole('slider', { name: /annual cola/i });
    expect(colaInput).toBeDisabled();
  });

  it('toggle off → Annual COLA input becomes editable', async () => {
    const user = userEvent.setup();
    renderAt('/income/new');
    await waitFor(() => screen.getByRole('switch', { name: /use scenario inflation/i }));
    const toggle = screen.getByRole('switch', { name: /use scenario inflation/i });
    await user.click(toggle);
    // React Aria Switch renders role="switch" on the hidden <input>; use toBeChecked().
    expect(toggle).not.toBeChecked();
    const colaInput = screen.getByRole('slider', { name: /annual cola/i });
    expect(colaInput).not.toBeDisabled();
  });

  it('edit mode with tracksInflation=true shows toggle on + disabled input', async () => {
    await seedPensionStream({ tracksInflation: true });
    renderAt('/income/income-pension-1/edit');
    await waitFor(() => screen.getByDisplayValue('ACME Pension'));
    const toggle = screen.getByRole('switch', { name: /use scenario inflation/i });
    expect(toggle).toBeChecked();
    const colaInput = screen.getByRole('slider', { name: /annual cola/i });
    expect(colaInput).toBeDisabled();
  });

  it('edit mode with tracksInflation=false shows toggle off + enabled input', async () => {
    await seedPensionStream({ tracksInflation: false, colaPct: 2 });
    renderAt('/income/income-pension-1/edit');
    await waitFor(() => screen.getByDisplayValue('ACME Pension'));
    const toggle = screen.getByRole('switch', { name: /use scenario inflation/i });
    expect(toggle).not.toBeChecked();
    const colaInput = screen.getByRole('slider', { name: /annual cola/i });
    expect(colaInput).not.toBeDisabled();
  });

  // Invariant — save path must never persist colaPct when
  // tracksInflation is true (the two fields are mutually exclusive).
  it('save with tracksInflation=true omits colaPct from persisted payload', async () => {
    const user = userEvent.setup();
    // Seed a valid pension stream with tracksInflation true (no colaPct).
    await seedPensionStream({ tracksInflation: true });
    renderAt('/income/income-pension-1/edit');
    await waitFor(() => screen.getByDisplayValue('ACME Pension'));
    // Confirm toggle is on (tracksInflation === true).
    const toggle = screen.getByRole('switch', { name: /use scenario inflation/i });
    expect(toggle).toBeChecked();
    // Click Save without changing anything — existing payload is valid.
    const saveBtn = screen.getByRole('button', { name: /^save$/i });
    await user.click(saveBtn);
    // Wait for navigation to /income (confirms save succeeded).
    await waitFor(() => screen.getByText('income list'));
    // Read back the persisted aggregate.
    const saved = await getAggregate('incomeStream', 'income-pension-1');
    expect(saved).not.toBeNull();
    const payload = saved!.payload as IncomeStreamPayload;
    // tracksInflation must be true and colaPct must be absent.
    expect(payload.tracksInflation).toBe(true);
    expect('colaPct' in payload).toBe(false);
  });
});

describe('IncomeFormPage — scenario inflation inheritance', () => {
  // Opening scenario-only-add on a child scenario with no inflation
  // override must walk the parent chain (via resolveScenario) and display
  // the parent's inflation rate in the disabled COLA field.
  it('child scenario with no inflation override inherits parent rate in disabled COLA field', async () => {
    const { childId } = await seedScenarios();
    renderAt(`/income/new?scenarioId=${childId}`);
    // Wait for the form to load (toggle presence confirms data loaded).
    await waitFor(() => screen.getByRole('switch', { name: /use scenario inflation/i }));
    // Default kind = pension, tracksInflation = true → COLA input is disabled.
    const colaInput = screen.getByRole('slider', { name: /annual cola/i });
    expect(colaInput).toBeDisabled();
    // Disabled COLA slider must sit at 4 — the parent's inflation rate
    // (the range input carries the raw number; the badge formats "4.0%").
    expect((colaInput as HTMLInputElement).value).toBe('4');
  });
});

describe('IncomeFormPage — scenario-patch mode', () => {
  it('Save writes only the changed keys into overrides.income.patches[aggregate:<id>]; canonical untouched', async () => {
    const user = userEvent.setup();
    const { parentId } = await seedScenarios();
    await seedPensionStream({ monthlyBenefit: 1200 });
    renderAt(
      `/income/income-pension-1/edit?scenarioId=${parentId}&returnTo=/scenarios/${parentId}/income`,
    );
    await waitFor(() => screen.getByDisplayValue('ACME Pension'));

    // Change only the monthly benefit; everything else stays as resolved.
    fireEvent.change(screen.getByLabelText("Monthly benefit ($)"), {
      target: { value: '2500' },
    });
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(async () => {
      const sc = (await getAggregate(
        'scenario',
        parentId,
      )) as Aggregate<ScenarioPayload> | null;
      const patch = sc?.payload.overrides.income?.patches?.[
        'aggregate:income-pension-1'
      ] as Partial<IncomeStreamPayload> | undefined;
      expect(patch).toBeDefined();
      expect(patch?.monthlyBenefit).toBe(2500);
      // Unchanged keys are NOT written into the sparse patch.
      expect(patch && 'name' in patch).toBe(false);
      expect(patch && 'kind' in patch).toBe(false);
    });
    // Canonical aggregate untouched.
    const canonical = (await getAggregate(
      'incomeStream',
      'income-pension-1',
    )) as Aggregate<IncomeStreamPayload> | null;
    expect(canonical?.payload.monthlyBenefit).toBe(1200);
  });

  it('emits null for off-kind leftovers after a kind switch', async () => {
    // Pension → partTime drops the pension-only keys. The delta emits
    // `null` for each (clear-marker) so the scenario resolves to a clean
    // partTime stream with no stale inert pension keys.
    const user = userEvent.setup();
    const { parentId } = await seedScenarios();
    await seedPensionStream({ monthlyBenefit: 1200 });
    renderAt(
      `/income/income-pension-1/edit?scenarioId=${parentId}&returnTo=/scenarios/${parentId}/income`,
    );
    await waitFor(() => screen.getByDisplayValue('ACME Pension'));

    // Switch to part-time, then enter a valid annual amount.
    await user.click(
      screen.getByRole('radio', { name: /part-time \/ earned income/i }),
    );
    fireEvent.change(screen.getByLabelText(/annual amount/i), {
      target: { value: '20000' },
    });
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(async () => {
      const sc = (await getAggregate(
        'scenario',
        parentId,
      )) as Aggregate<ScenarioPayload> | null;
      const patch = sc?.payload.overrides.income?.patches?.[
        'aggregate:income-pension-1'
      ] as Record<string, unknown> | undefined;
      expect(patch).toBeDefined();
      expect(patch?.kind).toBe('partTime');
      expect(patch?.annualAmount).toBe(20000);
      // Pension-only leftovers cleared via the null marker.
      expect(patch).toHaveProperty('monthlyBenefit', null);
      expect(patch).toHaveProperty('payoutType', null);
    });
  });

  it('clears notes via empty string (not a null key removal)', async () => {
    const user = userEvent.setup();
    const { parentId } = await seedScenarios();
    await seedPensionStream({ monthlyBenefit: 1200, notes: 'inherited note' });
    renderAt(
      `/income/income-pension-1/edit?scenarioId=${parentId}&returnTo=/scenarios/${parentId}/income`,
    );
    await waitFor(() => screen.getByDisplayValue('ACME Pension'));

    fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(async () => {
      const sc = (await getAggregate(
        'scenario',
        parentId,
      )) as Aggregate<ScenarioPayload> | null;
      const patch = sc?.payload.overrides.income?.patches?.[
        'aggregate:income-pension-1'
      ] as Record<string, unknown> | undefined;
      expect(patch).toBeDefined();
      // notes clears via '' — a value-equivalent clear, not a null marker.
      expect(patch?.notes).toBe('');
    });
  });

  it('navigates to the returnTo URL after a scenario-patch Save', async () => {
    const user = userEvent.setup();
    const { parentId } = await seedScenarios();
    await seedPensionStream({ monthlyBenefit: 1200 });
    renderAt(
      `/income/income-pension-1/edit?scenarioId=${parentId}&returnTo=%2Fscenarios%2F${parentId}%2Fincome`,
    );
    await waitFor(() => screen.getByDisplayValue('ACME Pension'));

    fireEvent.change(screen.getByLabelText("Monthly benefit ($)"), {
      target: { value: '3000' },
    });
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(lastLocation).toBe(`/scenarios/${parentId}/income`),
    );
  });
});

describe('IncomeFormPage — scenario-only add-edit mode', () => {
  async function seedScenarioWithAdded(): Promise<string> {
    const { parentId } = await seedScenarios();
    const sc = (await getAggregate(
      'scenario',
      parentId,
    )) as Aggregate<ScenarioPayload>;
    sc.payload.overrides = {
      ...sc.payload.overrides,
      income: {
        added: [
          {
            _localId: 'lid-1',
            name: 'Side gig',
            notes: '',
            memberId: 'hm-income-1',
            kind: 'partTime',
            annualAmount: 20000,
            tracksInflation: true,
            start: { kind: 'age', years: 67, months: 0 },
            end: { kind: 'durationFromStart', months: 60 },
            taxable: true,
          },
          {
            _localId: 'lid-2',
            name: 'Royalties',
            notes: '',
            memberId: 'hm-income-1',
            kind: 'oneOff',
            oneOffAmount: 5000,
            source: 'other',
            start: { kind: 'year', year: 2035 },
            taxable: true,
          },
        ],
      },
    };
    await putAggregate('scenario', sc);
    return parentId;
  }

  it('replaces the matching added[] entry in place (same _localId, count unchanged)', async () => {
    const scId = await seedScenarioWithAdded();
    renderAt(
      `/income/scenario-entry?scenarioId=${scId}&editLocalId=lid-1&returnTo=/scenarios/${scId}/income`,
    );
    // Seeded with the entry's stored values.
    await waitFor(() => screen.getByDisplayValue('Side gig'));

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Bigger side gig' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(async () => {
      const sc = (await getAggregate(
        'scenario',
        scId,
      )) as Aggregate<ScenarioPayload> | null;
      const added = sc?.payload.overrides.income?.added ?? [];
      // Count unchanged — replaced in place, not appended.
      expect(added).toHaveLength(2);
      expect(added.find((a) => a._localId === 'lid-1')?.name).toBe(
        'Bigger side gig',
      );
      // The sibling entry is untouched.
      expect(added.find((a) => a._localId === 'lid-2')?.name).toBe('Royalties');
    });
  });

  it('navigates to the returnTo URL after an add-edit Save', async () => {
    const scId = await seedScenarioWithAdded();
    renderAt(
      `/income/scenario-entry?scenarioId=${scId}&editLocalId=lid-1&returnTo=%2Fscenarios%2F${scId}%2Fincome`,
    );
    await waitFor(() => screen.getByDisplayValue('Side gig'));

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(lastLocation).toBe(`/scenarios/${scId}/income`));
  });

  it('surfaces an error state when editLocalId matches no added entry', async () => {
    const { parentId } = await seedScenarios();
    renderAt(
      `/income/scenario-entry?scenarioId=${parentId}&editLocalId=missing&returnTo=/scenarios/${parentId}/income`,
    );
    expect(
      await screen.findByText('Scenario-only income source not found.'),
    ).toBeInTheDocument();
  });
});

describe('IncomeFormPage — name uniqueness', () => {
  async function seedSecondPension(): Promise<void> {
    const stream: Aggregate<IncomeStreamPayload> = {
      id: 'income-pension-2',
      householdId: HH,
      aggregateType: 'incomeStream',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'State Pension',
        notes: '',
        memberId: 'hm-income-1',
        kind: 'pension',
        payoutType: 'annuity',
        monthlyBenefit: 800,
        tracksInflation: true,
        jointAndSurvivorPct: 0,
        start: { kind: 'age', years: 65, months: 0 },
        taxable: true,
      },
    };
    await putAggregate('incomeStream', stream);
  }

  it('should_block_save_on_duplicate_income_name', async () => {
    const user = userEvent.setup();
    await seedPensionStream({ name: 'ACME Pension' });
    await seedSecondPension(); // "State Pension"
    renderAt('/income/income-pension-1/edit');
    await waitFor(() => screen.getByDisplayValue('ACME Pension'));

    // Rename to collide (case-folded) with the other canonical stream.
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'state pension' },
    });
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    // Form-level inline error; canonical aggregate not mutated and no
    // mutation queued.
    await screen.findByText(/already exists/i);
    expect(lastLocation).not.toBe('/income');
    const pending = await listPendingMutations();
    expect(
      pending.find((p) => p.aggregateId === 'income-pension-1'),
    ).toBeUndefined();
    const canonical = (await getAggregate(
      'incomeStream',
      'income-pension-1',
    )) as Aggregate<IncomeStreamPayload> | null;
    expect(canonical?.payload.name).toBe('ACME Pension');
  });

  it('saves a unique name (no collision)', async () => {
    const user = userEvent.setup();
    await seedPensionStream({ name: 'ACME Pension' });
    await seedSecondPension();
    renderAt('/income/income-pension-1/edit');
    await waitFor(() => screen.getByDisplayValue('ACME Pension'));

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Renamed Pension' },
    });
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => screen.getByText('income list'));
    const canonical = (await getAggregate(
      'incomeStream',
      'income-pension-1',
    )) as Aggregate<IncomeStreamPayload> | null;
    expect(canonical?.payload.name).toBe('Renamed Pension');
  });

  it('blocks a scenario-only add that duplicates a name in this scenario added[]', async () => {
    const user = userEvent.setup();
    const { parentId } = await seedScenarios();
    const sc = (await getAggregate(
      'scenario',
      parentId,
    )) as Aggregate<ScenarioPayload>;
    sc.payload.overrides = {
      ...sc.payload.overrides,
      income: {
        added: [
          {
            _localId: 'lid-1',
            name: 'Side gig',
            notes: '',
            memberId: 'hm-income-1',
            kind: 'partTime',
            annualAmount: 20000,
            tracksInflation: true,
            start: { kind: 'age', years: 67, months: 0 },
            end: { kind: 'durationFromStart', months: 60 },
            taxable: true,
          },
        ],
      },
    };
    await putAggregate('scenario', sc);

    renderAt(
      `/income/scenario-entry?scenarioId=${parentId}&returnTo=/scenarios/${parentId}/income`,
    );
    await waitFor(() =>
      screen.getByRole('switch', { name: /use scenario inflation/i }),
    );
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'side gig' }, // case-folded collision with added[]
    });
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await screen.findByText(/this scenario already has an income source/i);
    // No new entry appended.
    const after = (await getAggregate(
      'scenario',
      parentId,
    )) as Aggregate<ScenarioPayload> | null;
    expect(after?.payload.overrides.income?.added ?? []).toHaveLength(1);
  });

  // Scenario-PATCH scope of the duplicate-name guard. Renaming the
  // current canonical row (opened in scenario-patch mode) to collide with
  // another row in the scenario-resolved income list must block Save and
  // queue NO scenario mutation.
  it('blocks a scenario-patch rename that collides with another resolved income row', async () => {
    const user = userEvent.setup();
    const { parentId } = await seedScenarios();
    await seedPensionStream({ name: 'ACME Pension' });
    await seedSecondPension(); // "State Pension" — sibling resolved row.

    renderAt(
      `/income/income-pension-1/edit?scenarioId=${parentId}&returnTo=/scenarios/${parentId}/income`,
    );
    await waitFor(() => screen.getByDisplayValue('ACME Pension'));

    // Rename the patched row to collide (case-folded) with the sibling
    // canonical/resolved row "State Pension".
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'state pension' },
    });
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    // Inline scenario-scoped error; no navigation; no scenario mutation
    // queued and the scenario's overrides stay empty.
    await screen.findByText(/this scenario already has an income source/i);
    expect(lastLocation).not.toBe(`/scenarios/${parentId}/income`);
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.aggregateId === parentId)).toBeUndefined();
    const sc = (await getAggregate(
      'scenario',
      parentId,
    )) as Aggregate<ScenarioPayload> | null;
    expect(sc?.payload.overrides.income).toBeUndefined();
  });

  it('allows re-saving the same added row under edit (same _localId)', async () => {
    const user = userEvent.setup();
    const { parentId } = await seedScenarios();
    const sc = (await getAggregate(
      'scenario',
      parentId,
    )) as Aggregate<ScenarioPayload>;
    sc.payload.overrides = {
      ...sc.payload.overrides,
      income: {
        added: [
          {
            _localId: 'lid-1',
            name: 'Side gig',
            notes: '',
            memberId: 'hm-income-1',
            kind: 'partTime',
            annualAmount: 20000,
            tracksInflation: true,
            start: { kind: 'age', years: 67, months: 0 },
            end: { kind: 'durationFromStart', months: 60 },
            taxable: true,
          },
        ],
      },
    };
    await putAggregate('scenario', sc);

    renderAt(
      `/income/scenario-entry?scenarioId=${parentId}&editLocalId=lid-1&returnTo=/scenarios/${parentId}/income`,
    );
    await waitFor(() => screen.getByDisplayValue('Side gig'));
    // Re-save without renaming — the row's own name must NOT collide with
    // itself (excluded by editingAddedLocalId).
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => screen.getByText('scenario income'));
    const after = (await getAggregate(
      'scenario',
      parentId,
    )) as Aggregate<ScenarioPayload> | null;
    const added = after?.payload.overrides.income?.added ?? [];
    expect(added).toHaveLength(1);
    expect(added[0]?._localId).toBe('lid-1');
  });
});

describe('IncomeFormPage — mode-state reset on route transition', () => {
  it('clears editingAddedLocalId so a follow-on plain add APPENDS, not replaces', async () => {
    const user = userEvent.setup();
    const { parentId } = await seedScenarios();
    const sc = (await getAggregate(
      'scenario',
      parentId,
    )) as Aggregate<ScenarioPayload>;
    sc.payload.overrides = {
      ...sc.payload.overrides,
      income: {
        added: [
          {
            _localId: 'lid-1',
            name: 'Side gig',
            notes: '',
            memberId: 'hm-income-1',
            kind: 'partTime',
            annualAmount: 20000,
            tracksInflation: true,
            start: { kind: 'age', years: 67, months: 0 },
            end: { kind: 'durationFromStart', months: 60 },
            taxable: true,
          },
        ],
      },
    };
    await putAggregate('scenario', sc);

    // In-router navigator: both URLs match the SAME `/income/scenario-entry`
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
              `/income/scenario-entry?scenarioId=${parentId}&returnTo=/scenarios/${parentId}/income`,
            )
          }
        >
          go-plain-add
        </button>
      );
    };
    render(
      <MemoryRouter
        initialEntries={[
          `/income/scenario-entry?scenarioId=${parentId}&editLocalId=lid-1&returnTo=/scenarios/${parentId}/income`,
        ]}
      >
        <LocationProbe />
        <Navigator />
        <Routes>
          <Route path="/income/scenario-entry" element={<IncomeFormPage />} />
          <Route
            path="/scenarios/:id/income"
            element={<div>scenario income</div>}
          />
        </Routes>
      </MemoryRouter>,
    );

    // Add-edit mode: seeded with lid-1's stored name.
    await waitFor(() => screen.getByDisplayValue('Side gig'));

    // Transition to plain add (query loses editLocalId) — same component.
    await user.click(screen.getByText('go-plain-add'));
    // The form re-seeds empty (plain add), confirming the load re-ran.
    await waitFor(() =>
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(''),
    );

    // Fill a fresh pension stream (the plain-add default kind) and Save —
    // must APPEND, not replace lid-1.
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'New gig' },
    });
    fireEvent.change(screen.getByLabelText('Monthly benefit ($)'), {
      target: { value: '1500' },
    });
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => screen.getByText('scenario income'));
    const after = (await getAggregate(
      'scenario',
      parentId,
    )) as Aggregate<ScenarioPayload> | null;
    const added = after?.payload.overrides.income?.added ?? [];
    // Appended: original lid-1 still present + a new entry.
    expect(added).toHaveLength(2);
    expect(added.find((a) => a._localId === 'lid-1')?.name).toBe('Side gig');
    expect(added.some((a) => a.name === 'New gig')).toBe(true);
  });

  // On a same-component query-only transition the prior load left
  // `loading` false, so without re-entering the loading state the reseed
  // window would render the stale add-edit draft (with Save reachable
  // against the old row) and could leave a stale load `error` visible. The
  // fix re-enters `loading` (gating the form body / Save) and clears
  // `error` at the start of the load. Assert the post-transition form is
  // the freshly re-seeded plain-add form with NO stale error, and that a
  // Save in that window APPENDS (does not replace the old row).
  it('clears stale draft/error on transition so a follow-on Save APPENDS, not replaces', async () => {
    const user = userEvent.setup();
    const { parentId } = await seedScenarios();
    const sc = (await getAggregate(
      'scenario',
      parentId,
    )) as Aggregate<ScenarioPayload>;
    sc.payload.overrides = {
      ...sc.payload.overrides,
      income: {
        added: [
          {
            _localId: 'lid-1',
            name: 'Side gig',
            notes: '',
            memberId: 'hm-income-1',
            kind: 'partTime',
            annualAmount: 20000,
            tracksInflation: true,
            start: { kind: 'age', years: 67, months: 0 },
            end: { kind: 'durationFromStart', months: 60 },
            taxable: true,
          },
        ],
      },
    };
    await putAggregate('scenario', sc);

    const Navigator: React.FC = () => {
      const navigate = useNavigate();
      return (
        <button
          type="button"
          onClick={() =>
            navigate(
              `/income/scenario-entry?scenarioId=${parentId}&returnTo=/scenarios/${parentId}/income`,
            )
          }
        >
          go-plain-add
        </button>
      );
    };
    render(
      <MemoryRouter
        initialEntries={[
          `/income/scenario-entry?scenarioId=${parentId}&editLocalId=lid-1&returnTo=/scenarios/${parentId}/income`,
        ]}
      >
        <LocationProbe />
        <Navigator />
        <Routes>
          <Route path="/income/scenario-entry" element={<IncomeFormPage />} />
          <Route
            path="/scenarios/:id/income"
            element={<div>scenario income</div>}
          />
        </Routes>
      </MemoryRouter>,
    );

    // Add-edit mode: seeded with lid-1's stored name (the load settled).
    await waitFor(() => screen.getByDisplayValue('Side gig'));

    // Transition to plain add — the load effect re-runs. The fix re-enters
    // `loading` (skeleton gates the stale draft + Save out of the tree)
    // and clears `error`, so the reseed window never exposes a
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
      target: { value: 'New gig' },
    });
    fireEvent.change(screen.getByLabelText('Monthly benefit ($)'), {
      target: { value: '1500' },
    });
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => screen.getByText('scenario income'));
    const after = (await getAggregate(
      'scenario',
      parentId,
    )) as Aggregate<ScenarioPayload> | null;
    const added = after?.payload.overrides.income?.added ?? [];
    expect(added).toHaveLength(2);
    expect(added.find((a) => a._localId === 'lid-1')?.name).toBe('Side gig');
    expect(added.some((a) => a.name === 'New gig')).toBe(true);
  });

  // On a same-component, same-route, query-only transition to a
  // MISSING editLocalId (reachable via browser back/forward against a
  // since-deleted row, or a hand-crafted URL) the load hits its not-found
  // early return — it sets `error` but the `finally` clears `loading`,
  // leaving the OLD `draft` non-null. The `!draft && error` error branch
  // would then be masked and the stale add-edit form would render (with
  // Save reachable against the stale row through the canonical branch). The
  // fix clears `draft`/`baseline` at the start of the load, so the
  // not-found path renders the error, NOT the stale form.
  it('shows the not-found error (not the stale form) on a transition to a missing editLocalId', async () => {
    const user = userEvent.setup();
    const { parentId } = await seedScenarios();
    const sc = (await getAggregate(
      'scenario',
      parentId,
    )) as Aggregate<ScenarioPayload>;
    sc.payload.overrides = {
      ...sc.payload.overrides,
      income: {
        added: [
          {
            _localId: 'lid-1',
            name: 'Side gig',
            notes: '',
            memberId: 'hm-income-1',
            kind: 'partTime',
            annualAmount: 20000,
            tracksInflation: true,
            start: { kind: 'age', years: 67, months: 0 },
            end: { kind: 'durationFromStart', months: 60 },
            taxable: true,
          },
        ],
      },
    };
    await putAggregate('scenario', sc);

    // Same `/income/scenario-entry` route, query-only change to a missing
    // editLocalId — React reuses the component instance.
    const Navigator: React.FC = () => {
      const navigate = useNavigate();
      return (
        <button
          type="button"
          onClick={() =>
            navigate(
              `/income/scenario-entry?scenarioId=${parentId}&editLocalId=missing&returnTo=/scenarios/${parentId}/income`,
            )
          }
        >
          go-missing
        </button>
      );
    };
    render(
      <MemoryRouter
        initialEntries={[
          `/income/scenario-entry?scenarioId=${parentId}&editLocalId=lid-1&returnTo=/scenarios/${parentId}/income`,
        ]}
      >
        <LocationProbe />
        <Navigator />
        <Routes>
          <Route path="/income/scenario-entry" element={<IncomeFormPage />} />
          <Route
            path="/scenarios/:id/income"
            element={<div>scenario income</div>}
          />
        </Routes>
      </MemoryRouter>,
    );

    // Add-edit mode: the form settled, seeded with lid-1's stored name.
    await waitFor(() => screen.getByDisplayValue('Side gig'));

    // Transition to a missing editLocalId — the load re-runs and hits the
    // not-found return.
    await user.click(screen.getByText('go-missing'));

    // The error renders (not masked by a stale draft).
    await waitFor(() =>
      screen.getByText('Scenario-only income source not found.'),
    );
    // The stale form is gone: no Save against the old row, no stale name.
    expect(screen.queryByDisplayValue('Side gig')).toBeNull();
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
  });
});

describe('IncomeFormPage — returnTo redirect validation', () => {
  it.each(['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', 'data:text/html,x'])(
    'rejects returnTo=%s and falls back to /income on Save',
    async (bad) => {
      const user = userEvent.setup();
      await seedPensionStream({ tracksInflation: true });
      renderAt(
        `/income/income-pension-1/edit?returnTo=${encodeURIComponent(bad)}`,
      );
      await waitFor(() => screen.getByDisplayValue('ACME Pension'));
      await user.click(screen.getByRole('button', { name: /^save$/i }));
      await waitFor(() => expect(lastLocation).toBe('/income'));
    },
  );
});

describe('IncomeFormPage — returnTo with focusIncomeId survives Save and Cancel', () => {
  // The canonical list-page Edit link is:
  //   /income/<id>/edit?returnTo=<enc('/income?focusIncomeId=<id>')>
  // After a successful Save or Cancel the form must navigate to the full
  // returnTo value (including the inner ?focusIncomeId param) so the
  // list page can restore scroll position + focus on return.

  const ENCODED_RETURN_TO = encodeURIComponent('/income?focusIncomeId=income-pension-1');
  const EXPECTED_LOCATION = '/income?focusIncomeId=income-pension-1';

  it('Save navigates to the full returnTo URL including focusIncomeId', async () => {
    const user = userEvent.setup();
    await seedPensionStream({ tracksInflation: true });

    renderAt(`/income/income-pension-1/edit?returnTo=${ENCODED_RETURN_TO}`);
    await waitFor(() => screen.getByDisplayValue('ACME Pension'));

    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(lastLocation).toBe(EXPECTED_LOCATION));
  });

  it('Cancel navigates to the full returnTo URL including focusIncomeId', async () => {
    const user = userEvent.setup();
    await seedPensionStream({ tracksInflation: true });

    renderAt(`/income/income-pension-1/edit?returnTo=${ENCODED_RETURN_TO}`);
    await waitFor(() => screen.getByDisplayValue('ACME Pension'));

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(lastLocation).toBe(EXPECTED_LOCATION));
  });
});

describe('IncomeFormPage — Start picker (shared ScheduleAnchorPicker)', () => {
  async function seedSecondaryMember(): Promise<void> {
    const m: Aggregate<HouseholdMemberPayload> = {
      id: 'hm-income-2',
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
        birthdate: '1987-06-20',
      },
    };
    await putAggregate('householdMember', m);
  }

  async function seedPartTimeStream(
    overrides: Partial<IncomeStreamPayload> = {},
  ): Promise<void> {
    const stream: Aggregate<IncomeStreamPayload> = {
      id: 'income-pt-1',
      householdId: HH,
      aggregateType: 'incomeStream',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Side gig',
        notes: '',
        memberId: 'hm-income-1', // owner = primary
        kind: 'partTime',
        annualAmount: 20000,
        tracksInflation: true,
        colaPct: 0,
        start: { kind: 'age', years: 67, months: 0 }, // owner-implicit
        end: { kind: 'durationFromStart', months: 60 },
        taxable: true,
        ...overrides,
      },
    };
    await putAggregate('incomeStream', stream);
  }

  it('renders the Start picker always-expanded (no disclosure trigger)', async () => {
    renderAt('/income/new');
    await screen.findByLabelText('Name');
    // Income has no collapsible sections: the radiogroup is immediately
    // queryable (it is NOT behind an AnchorCard disclosure trigger).
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(
      screen.getByRole('radiogroup', { name: 'Start' }),
    ).toBeInTheDocument();
  });

  it('member <select> shows for part-time + secondary, hidden for pension', async () => {
    const user = userEvent.setup();
    await seedSecondaryMember();
    renderAt('/income/new');
    await screen.findByLabelText('Name');
    // Default kind is pension → owner-implicit, no member select even
    // though a secondary exists.
    expect(screen.queryByLabelText('Start age member')).toBeNull();
    // Switch to part-time → the member select appears.
    await user.click(
      screen.getByRole('radio', { name: 'Part-time / earned income' }),
    );
    expect(screen.getByLabelText('Start age member')).toBeInTheDocument();
  });

  it('member <select> stays hidden for part-time in a single-member household', async () => {
    const user = userEvent.setup();
    renderAt('/income/new'); // only the primary seeded in beforeEach
    await screen.findByLabelText('Name');
    await user.click(
      screen.getByRole('radio', { name: 'Part-time / earned income' }),
    );
    expect(screen.queryByLabelText('Start age member')).toBeNull();
  });

  it('owner-implicit partTime age start stays owner-implicit after a years-only edit', async () => {
    const user = userEvent.setup();
    await seedSecondaryMember();
    await seedPartTimeStream(); // owner = primary, start age owner-implicit
    renderAt('/income/income-pt-1/edit');
    await screen.findByDisplayValue('Side gig');
    // Owner-implicit + owner = primary ⇒ the member select defaults to
    // primary; edit only the years.
    fireEvent.change(screen.getByLabelText('Start age years'), {
      target: { value: '68' },
    });
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(async () => {
      const m = (await getAggregate(
        'incomeStream',
        'income-pt-1',
      )) as Aggregate<IncomeStreamPayload> | null;
      // memberId stays omitted (owner-implicit shape preserved).
      expect(m?.payload.start).toEqual({ kind: 'age', years: 68, months: 0 });
    });
  });

  // Regression: on a secondary-owned partTime stream, switching the
  // Start kind radio to 'age' must default the new anchor to the owner
  // (secondary), so the bridge's omit rule (role === ownerRole) drops the
  // memberId. A hardcoded 'primary' default would survive the omit rule and
  // silently anchor to the wrong member.
  it('switching the Start kind to age on a secondary-owned partTime stream does not anchor to primary', async () => {
    const user = userEvent.setup();
    await seedSecondaryMember();
    // owner = secondary (hm-income-2); start is retirementStart so clicking
    // 'At age' exercises the switch-to-age default path.
    await seedPartTimeStream({
      memberId: 'hm-income-2',
      start: { kind: 'retirementStart' },
    });
    renderAt('/income/income-pt-1/edit');
    await screen.findByDisplayValue('Side gig');
    // Switch the Start picker to the age kind. PartTime renders both a
    // Start and an End picker (each with an "At age" radio), so scope the
    // click to the Start radiogroup.
    const startGroup = screen.getByRole('radiogroup', { name: 'Start' });
    await user.click(within(startGroup).getByRole('radio', { name: 'At age' }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(async () => {
      const m = (await getAggregate(
        'incomeStream',
        'income-pt-1',
      )) as Aggregate<IncomeStreamPayload> | null;
      const start = m?.payload.start as
        | Extract<IncomeStreamPayload['start'], { kind: 'age' }>
        | undefined;
      expect(start?.kind).toBe('age');
      // Owner is secondary ⇒ the default anchored to secondary and the
      // bridge omitted it (owner-implicit). It must NOT be 'primary'.
      expect(start?.memberId).not.toBe('primary');
      // Concretely: owner-implicit ⇒ memberId omitted.
      expect(start?.memberId).toBeUndefined();
    });
  });

  it('explicitly choosing the non-owner persists that role on a partTime age start', async () => {
    const user = userEvent.setup();
    await seedSecondaryMember();
    await seedPartTimeStream(); // owner = primary
    renderAt('/income/income-pt-1/edit');
    await screen.findByDisplayValue('Side gig');
    // Pick the non-owner (secondary) in the member select.
    await user.click(screen.getByLabelText('Start age member'));
    await user.click(await screen.findByRole('option', { name: 'Sam' }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(async () => {
      const m = (await getAggregate(
        'incomeStream',
        'income-pt-1',
      )) as Aggregate<IncomeStreamPayload> | null;
      // Explicit non-owner ⇒ memberId kept.
      expect(m?.payload.start).toEqual({
        kind: 'age',
        memberId: 'secondary',
        years: 67,
        months: 0,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Deposit-target eligibility
// ---------------------------------------------------------------------------

describe('IncomeFormPage — deposit-target eligibility', () => {
  let acctSeq = 0;
  async function seedAccount(
    type: AccountType,
    taxTreatment: AccountTaxTreatment,
    name: string,
  ): Promise<string> {
    acctSeq += 1;
    const id = `acct-${acctSeq}`;
    const account: Aggregate<AccountPayload> = {
      id,
      householdId: HH,
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name,
        type,
        ownershipType: 'INDIVIDUAL',
        taxTreatment,
        ownerId: 'hm-income-1',
        institution: 'Test Bank',
        notes: '',
        planningReturnPct: 6,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
      },
    };
    await putAggregate('account', account);
    return id;
  }

  async function seedLumpSumStream(targetAccountId: string): Promise<void> {
    const stream: Aggregate<IncomeStreamPayload> = {
      id: 'income-lump-1',
      householdId: HH,
      aggregateType: 'incomeStream',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Pension Lump Sum',
        notes: '',
        memberId: 'hm-income-1',
        kind: 'pension',
        payoutType: 'lumpSum',
        lumpSumAmount: 100_000,
        targetAccountId,
        tracksInflation: false,
        jointAndSurvivorPct: 0,
        start: { kind: 'age', years: 65, months: 0 },
        taxable: true,
      },
    };
    await putAggregate('incomeStream', stream);
  }

  async function seedOneOffStream(targetAccountId: string): Promise<void> {
    const stream: Aggregate<IncomeStreamPayload> = {
      id: 'income-oneoff-1',
      householdId: HH,
      aggregateType: 'incomeStream',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Windfall',
        notes: '',
        memberId: 'hm-income-1',
        kind: 'oneOff',
        oneOffAmount: 50_000,
        source: 'inheritance',
        targetAccountId,
        start: { kind: 'year', year: 2030 },
        taxable: true,
      },
    };
    await putAggregate('incomeStream', stream);
  }

  // -- Pension lump-sum rollover target ------------------------------

  it('accepts a pension lump-sum rolling into a pre-tax retirement account', async () => {
    const user = userEvent.setup();
    const iraId = await seedAccount('RETIREMENT_IRA', 'PRE_TAX', 'Rollover IRA');
    await seedLumpSumStream(iraId);
    renderAt('/income/income-lump-1/edit');
    await screen.findByDisplayValue('Pension Lump Sum');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(lastLocation).toBe('/income'));
  });

  it('accepts a pension lump-sum rolling into a mixed retirement account', async () => {
    const user = userEvent.setup();
    const mixedId = await seedAccount('RETIREMENT_401K', 'MIXED', 'Mixed 401k');
    await seedLumpSumStream(mixedId);
    renderAt('/income/income-lump-1/edit');
    await screen.findByDisplayValue('Pension Lump Sum');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(lastLocation).toBe('/income'));
  });

  it.each([
    ['a taxable brokerage', 'BROKERAGE', 'POST_TAX'],
    ['a Roth IRA', 'RETIREMENT_ROTH_IRA', 'ROTH'],
    ['an HSA', 'HSA', 'HSA'],
    ['a non-qualified OTHER shell marked pre-tax', 'OTHER', 'PRE_TAX'],
  ] as const)(
    'blocks a pension lump-sum rolling into %s',
    async (_label, type, treatment) => {
      const user = userEvent.setup();
      const targetId = await seedAccount(type, treatment, `Bad ${type}`);
      await seedLumpSumStream(targetId);
      renderAt('/income/income-lump-1/edit');
      await screen.findByDisplayValue('Pension Lump Sum');
      await user.click(screen.getByRole('button', { name: /^save$/i }));
      await screen.findByText(/Pick a pre-tax retirement account/i);
      expect(lastLocation).not.toBe('/income');
    },
  );

  // -- One-off windfall deposit target ------------------------------

  it('accepts a one-off windfall landing in a taxable account', async () => {
    const user = userEvent.setup();
    const brokId = await seedAccount('BROKERAGE', 'POST_TAX', 'Brokerage');
    await seedOneOffStream(brokId);
    renderAt('/income/income-oneoff-1/edit');
    await screen.findByDisplayValue('Windfall');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(lastLocation).toBe('/income'));
  });

  it.each([
    ['a pre-tax IRA', 'RETIREMENT_IRA', 'PRE_TAX'],
    ['a mixed 401k', 'RETIREMENT_401K', 'MIXED'],
    ['a Roth IRA', 'RETIREMENT_ROTH_IRA', 'ROTH'],
    ['an HSA', 'HSA', 'HSA'],
  ] as const)(
    'blocks a one-off windfall landing in %s',
    async (_label, type, treatment) => {
      const user = userEvent.setup();
      const targetId = await seedAccount(type, treatment, `Bad ${type}`);
      await seedOneOffStream(targetId);
      renderAt('/income/income-oneoff-1/edit');
      await screen.findByDisplayValue('Windfall');
      await user.click(screen.getByRole('button', { name: /^save$/i }));
      await screen.findByText(/Pick a taxable account/i);
      expect(lastLocation).not.toBe('/income');
    },
  );

  // -- Picker option filtering ----------------------------------------------

  it('filters the lump-sum target picker to eligible pre-tax retirement accounts', async () => {
    const user = userEvent.setup();
    const iraId = await seedAccount('RETIREMENT_IRA', 'PRE_TAX', 'Eligible IRA');
    await seedAccount('BROKERAGE', 'POST_TAX', 'Hidden Brokerage');
    await seedAccount('RETIREMENT_ROTH_IRA', 'ROTH', 'Hidden Roth');
    await seedLumpSumStream(iraId);
    renderAt('/income/income-lump-1/edit');
    await screen.findByDisplayValue('Pension Lump Sum');
    await user.click(screen.getByRole('button', { name: /target account/i }));
    const options = await screen.findAllByRole('option');
    const labels = options.map((o) => o.textContent ?? '');
    expect(labels.some((l) => /Eligible IRA/.test(l))).toBe(true);
    expect(labels.some((l) => /Hidden Brokerage/.test(l))).toBe(false);
    expect(labels.some((l) => /Hidden Roth/.test(l))).toBe(false);
  });

  it('filters the windfall target picker to eligible taxable accounts', async () => {
    const user = userEvent.setup();
    const brokId = await seedAccount('BROKERAGE', 'POST_TAX', 'Eligible Brokerage');
    await seedAccount('RETIREMENT_IRA', 'PRE_TAX', 'Hidden IRA');
    await seedOneOffStream(brokId);
    renderAt('/income/income-oneoff-1/edit');
    await screen.findByDisplayValue('Windfall');
    await user.click(screen.getByRole('button', { name: /target account/i }));
    const options = await screen.findAllByRole('option');
    const labels = options.map((o) => o.textContent ?? '');
    expect(labels.some((l) => /Eligible Brokerage/.test(l))).toBe(true);
    expect(labels.some((l) => /Hidden IRA/.test(l))).toBe(false);
  });

  // -- Spendable (no-target) windfall unaffected ----------------------------

  it('does not fire the eligibility validator on a spendable windfall path', async () => {
    const user = userEvent.setup();
    renderAt('/income/new');
    await screen.findByLabelText('Name');
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Spendable windfall' },
    });
    await user.click(
      screen.getByRole('radio', { name: /one-off \/ windfall/i }),
    );
    fireEvent.change(screen.getByLabelText(/Amount/i), {
      target: { value: '5000' },
    });
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    // No target chosen → the existing "Pick the account" prompt fires, NOT the
    // new eligibility message — proving the eligibility gate is target-scoped.
    await waitFor(() =>
      expect(screen.queryByText(/taxable account \(brokerage/i)).toBeNull(),
    );
  });

  // -- Edit-flow legacy ineligible target ----------------------------

  it('keeps a now-ineligible saved lump-sum target visible and blocks Save', async () => {
    const user = userEvent.setup();
    const brokId = await seedAccount('BROKERAGE', 'POST_TAX', 'Legacy Brokerage');
    await seedLumpSumStream(brokId);
    renderAt('/income/income-lump-1/edit');
    await screen.findByDisplayValue('Pension Lump Sum');
    // The saved (ineligible) value stays visible, flagged not eligible.
    expect(
      screen.getAllByText(/Legacy Brokerage.*not eligible/i).length,
    ).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await screen.findByText(/Pick a pre-tax retirement account/i);
    expect(lastLocation).not.toBe('/income');
    // Saved value not silently dropped (no auto-migration).
    const canonical = (await getAggregate(
      'incomeStream',
      'income-lump-1',
    )) as Aggregate<IncomeStreamPayload> | null;
    expect(canonical?.payload.targetAccountId).toBe(brokId);
  });
});

