/**
 * ScenarioInflationPage render + save tests.
 *
 * Covers: renders every category, Medical pre-shows the elevated default
 * (+2pp) and stays uncapped when general > 8%, per-row reset drops
 * the override, Save persists a sparse `categoryRates` + always-present
 * `ratePct`, an orphan key is preserved verbatim, the
 * inheritance-snapshot behavior holds, and the page has no jest-axe WCAG
 * violations.
 */
import 'fake-indexeddb/auto';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores, getAggregate, putAggregate } from '../db/store';
import { expectNoA11yViolations } from '../test/a11y';
import type {
  Aggregate,
  ExpenseCategoryPayload,
  ScenarioPayload,
} from '../db/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { ScenarioInflationPage } from './ScenarioInflationPage';

const HH = 'hh-test';
const SCENARIO_ID = 'sc-1';

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

function renderAt(scenarioId: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/scenarios/${scenarioId}/inflation`]}>
      <Routes>
        <Route path="/scenarios/:id/inflation" element={<ScenarioInflationPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function seedCategory(
  id: string,
  name: string,
  isMedical = false,
): Promise<void> {
  const c: Aggregate<ExpenseCategoryPayload> = {
    id,
    householdId: HH,
    aggregateType: 'expenseCategory',
    schemaVersion: 2,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: isMedical ? { name, isMedical: true } : { name },
  };
  await putAggregate('expenseCategory', c);
}

async function seedScenario(
  overrides: ScenarioPayload['overrides'] = {},
  opts: { id?: string; parentScenarioId?: string | null; isPrimary?: boolean } = {},
): Promise<void> {
  const sc: Aggregate<ScenarioPayload> = {
    id: opts.id ?? SCENARIO_ID,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'Baseline',
      description: '',
      parentScenarioId: opts.parentScenarioId ?? null,
      isPrimary: opts.isPrimary ?? true,
      notes: '',
      overrides,
    },
  };
  await putAggregate('scenario', sc);
}

async function seedDefaultCategories(): Promise<void> {
  await seedCategory('cat-food', 'Food');
  await seedCategory('cat-housing', 'Housing');
  await seedCategory('cat-medical', 'Medical', true);
}

describe('ScenarioInflationPage', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders every category and Medical pre-shows the +2pp default; no a11y violations', async () => {
    await seedDefaultCategories();
    await seedScenario({ inflation: { ratePct: 3 } });
    const { container } = renderAt(SCENARIO_ID);

    await waitFor(() => expect(screen.getByText('Food')).toBeInTheDocument());
    expect(screen.getByText('Housing')).toBeInTheDocument();
    expect(screen.getByText('Medical')).toBeInTheDocument();

    // Medical defaults to general + 2pp = 5%.
    const medicalInput = screen.getByLabelText(
      'Medical inflation rate',
    ) as HTMLInputElement;
    expect(medicalInput.value).toBe('5.0');
    // A non-medical category defaults to the general rate.
    const foodInput = screen.getByLabelText('Food inflation rate') as HTMLInputElement;
    expect(foodInput.value).toBe('3.0');

    await expectNoA11yViolations(container);
  });

  it('renders the gross-ACA-premium disclosure on the Medical row', async () => {
    await seedDefaultCategories();
    await seedScenario({ inflation: { ratePct: 3 } });
    renderAt(SCENARIO_ID);
    await waitFor(() => expect(screen.getByText('Medical')).toBeInTheDocument());
    // The Medical-row disclosure carries the ACA gross-premium guidance line
    // alongside the existing IRMAA double-count note.
    expect(
      screen.getByText(
        /the subsidy is sized from a benchmark plan and credited separately, so enter the full \(unsubsidized\) premium/i,
      ),
    ).toBeInTheDocument();
  });

  it('a second flagged-medical category drives the +2pp default and renders the disclosure', async () => {
    await seedDefaultCategories();
    // A second, non-cat-medical category flagged isMedical.
    await seedCategory('cat-dental', 'Dental', true);
    await seedScenario({ inflation: { ratePct: 3 } });
    renderAt(SCENARIO_ID);
    await waitFor(() => expect(screen.getByText('Dental')).toBeInTheDocument());
    // Flag-derived default = general + 2pp = 5%.
    const dentalInput = screen.getByLabelText(
      'Dental inflation rate',
    ) as HTMLInputElement;
    expect(dentalInput.value).toBe('5.0');
    // The IRMAA/ACA disclosure renders on EVERY isMedical row, so both
    // Medical and Dental carry the gross-premium guidance.
    const disclosures = screen.getAllByText(
      /the subsidy is sized from a benchmark plan and credited separately/i,
    );
    expect(disclosures.length).toBe(2);
  });

  it('shows the Medical default uncapped when general > 8%', async () => {
    await seedDefaultCategories();
    // General 9% → Medical default = 11% (uncapped).
    await seedScenario({ inflation: { ratePct: 9 } });
    renderAt(SCENARIO_ID);
    await waitFor(() => expect(screen.getByText('Medical')).toBeInTheDocument());
    const medicalInput = screen.getByLabelText(
      'Medical inflation rate',
    ) as HTMLInputElement;
    expect(medicalInput.value).toBe('11.0');
  });

  it('Save persists a sparse categoryRates + always-present ratePct', async () => {
    await seedDefaultCategories();
    await seedScenario({ inflation: { ratePct: 3 } });
    renderAt(SCENARIO_ID);
    await waitFor(() => expect(screen.getByText('Food')).toBeInTheDocument());

    // Override Food to 6% (≠ its default of 3); leave Medical + Housing.
    const foodInput = screen.getByLabelText('Food inflation rate') as HTMLInputElement;
    act(() => {
      fireEvent.focus(foodInput);
      fireEvent.change(foodInput, { target: { value: '6' } });
      fireEvent.blur(foodInput);
    });

    const saveButton = await screen.findByRole('button', { name: /save/i });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      const inflation = saved?.payload.overrides.inflation;
      expect(inflation?.ratePct).toBe(3); // always co-persisted
      // Sparse: only the non-default Food entry persists (Medical at its
      // default + Housing at general are omitted).
      expect(inflation?.categoryRates).toEqual({ 'cat-food': 6 });
    });
  });

  it('per-row reset drops the override (back to default, omitted on save)', async () => {
    await seedDefaultCategories();
    await seedScenario({
      inflation: { ratePct: 3, categoryRates: { 'cat-food': 6 } },
    });
    renderAt(SCENARIO_ID);
    await waitFor(() => expect(screen.getByText('Food')).toBeInTheDocument());

    // Food row is custom → a Reset button is present.
    const foodRow = screen.getByText('Food').closest('li')!;
    const reset = within(foodRow).getByRole('button', {
      name: /reset food inflation rate/i,
    });
    act(() => {
      fireEvent.click(reset);
    });
    // Food snaps back to the general default (3.0).
    const foodInput = screen.getByLabelText('Food inflation rate') as HTMLInputElement;
    await waitFor(() => expect(foodInput.value).toBe('3.0'));

    const saveButton = await screen.findByRole('button', { name: /save/i });
    await act(async () => {
      fireEvent.click(saveButton);
    });
    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      // Food dropped → no categoryRates at all (sparse + ratePct stays).
      expect(saved?.payload.overrides.inflation?.ratePct).toBe(3);
      expect(saved?.payload.overrides.inflation?.categoryRates).toBeUndefined();
    });
  });

  it('preserves an orphan categoryRates key verbatim on save', async () => {
    await seedDefaultCategories();
    // Stored override references a category that no longer exists.
    await seedScenario({
      inflation: { ratePct: 3, categoryRates: { 'cat-deleted': 7 } },
    });
    renderAt(SCENARIO_ID);
    await waitFor(() => expect(screen.getByText('Food')).toBeInTheDocument());

    // Make any live edit so the Save button appears, then save.
    const foodInput = screen.getByLabelText('Food inflation rate') as HTMLInputElement;
    act(() => {
      fireEvent.focus(foodInput);
      fireEvent.change(foodInput, { target: { value: '4' } });
      fireEvent.blur(foodInput);
    });
    const saveButton = await screen.findByRole('button', { name: /save/i });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      const rates = saved?.payload.overrides.inflation?.categoryRates;
      // The orphan key survives verbatim alongside the new live override.
      expect(rates?.['cat-deleted']).toBe(7);
      expect(rates?.['cat-food']).toBe(4);
    });
  });

  it('inheritance-snapshot: a child overriding only a category co-persists ratePct', async () => {
    await seedDefaultCategories();
    // Parent sets general 4%.
    await seedScenario(
      { inflation: { ratePct: 4 } },
      { id: 'parent', isPrimary: true },
    );
    // Child inherits (no own inflation override).
    await seedScenario(
      {},
      { id: 'child', parentScenarioId: 'parent', isPrimary: false },
    );
    renderAt('child');
    await waitFor(() => expect(screen.getByText('Food')).toBeInTheDocument());

    // Override only Housing on the child.
    const housingInput = screen.getByLabelText(
      'Housing inflation rate',
    ) as HTMLInputElement;
    act(() => {
      fireEvent.focus(housingInput);
      fireEvent.change(housingInput, { target: { value: '8' } });
      fireEvent.blur(housingInput);
    });
    const saveButton = await screen.findByRole('button', { name: /save/i });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', 'child')) as
        | Aggregate<ScenarioPayload>
        | null;
      // The child snapshots the resolved general rate (4) even though it
      // only meant to override Housing — the inheritance-snapshot behavior.
      expect(saved?.payload.overrides.inflation?.ratePct).toBe(4);
      expect(saved?.payload.overrides.inflation?.categoryRates).toEqual({
        'cat-housing': 8,
      });
    });
  });

  it('save-path: Medical at uncapped default (general=9%) is omitted, not persisted as custom override', async () => {
    await seedDefaultCategories();
    // Medical uncapped default = 9 + 2 = 11%. The uncapped rule permits > 10%.
    await seedScenario({ inflation: { ratePct: 9 } });
    renderAt(SCENARIO_ID);
    await waitFor(() => expect(screen.getByText('Medical')).toBeInTheDocument());

    // Medical shows 11.0 (uncapped). Make the page dirty by editing Food.
    const foodInput = screen.getByLabelText('Food inflation rate') as HTMLInputElement;
    act(() => {
      fireEvent.focus(foodInput);
      fireEvent.change(foodInput, { target: { value: '6' } });
      fireEvent.blur(foodInput);
    });

    const saveButton = await screen.findByRole('button', { name: /save/i });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      const rates = saved?.payload.overrides.inflation?.categoryRates;
      // Medical at uncapped default (11) must NOT be persisted (key absent).
      expect(rates?.['cat-medical']).toBeUndefined();
      // Food custom override (6) persists.
      expect(rates?.['cat-food']).toBe(6);
    });
  });

  it('changing the general rate recomputes inherited drafts; saving does not persist them as custom overrides', async () => {
    await seedDefaultCategories();
    await seedScenario({ inflation: { ratePct: 3 } });
    renderAt(SCENARIO_ID);
    await waitFor(() => expect(screen.getByText('Food')).toBeInTheDocument());

    // Initial drafts: Food=3 (=general), Medical=5 (=general+2pp).
    const foodInput = screen.getByLabelText('Food inflation rate') as HTMLInputElement;
    const medicalInput = screen.getByLabelText(
      'Medical inflation rate',
    ) as HTMLInputElement;
    expect(foodInput.value).toBe('3.0');
    expect(medicalInput.value).toBe('5.0');

    // Move the general-rate slider to 4%.
    const slider = screen.getByRole('slider', {
      name: /general annual inflation rate/i,
    });
    act(() => {
      fireEvent.change(slider, { target: { value: '4' } });
    });

    // Inherited drafts must recompute: Food → 4.0, Medical → 6.0.
    await waitFor(() => expect(foodInput.value).toBe('4.0'));
    expect(medicalInput.value).toBe('6.0');

    // Save and verify no inherited category is persisted as a custom override.
    const saveButton = await screen.findByRole('button', { name: /save/i });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      const rates = saved?.payload.overrides.inflation?.categoryRates;
      // Every category was at its new default — no categoryRates stored.
      expect(rates).toBeUndefined();
    });
  });
});
