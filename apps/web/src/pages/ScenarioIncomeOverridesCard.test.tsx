// ScenarioIncomeOverridesCard Edit navigation for canonical, patched and scenario-only rows, the "Add scenario-only income" header navigation, and the guard that the old "Override amount" modal is gone. Mirrors ScenarioExpenseOverridesCard.test.tsx.
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
import { clearAllStores, clearMutationQueue, putAggregate } from '../db/store';
import type {
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useSync } from '../sync/SyncContext';
import { IncomeOverridesCard } from './ScenarioIncomeOverridesCard';

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
    <MemoryRouter initialEntries={[`/scenarios/${scenario.id}/income`]}>
      <LocationProbe />
      <Routes>
        <Route
          path="/scenarios/:id/income"
          element={
            <IncomeOverridesCard
              scenario={scenario}
              scenarios={scenarios}
              householdId={HH}
              onChanged={vi.fn()}
            />
          }
        />
        <Route path="/income/:id/edit" element={<div>income editor</div>} />
        <Route path="/income/scenario-entry" element={<div>scenario entry</div>} />
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

async function seedStream(
  id: string,
  payload: Partial<IncomeStreamPayload> = {},
): Promise<void> {
  const s: Aggregate<IncomeStreamPayload> = {
    id,
    householdId: HH,
    aggregateType: 'incomeStream',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'ACME Pension',
      notes: '',
      memberId: 'hm-1',
      kind: 'pension',
      payoutType: 'annuity',
      monthlyBenefit: 1200,
      tracksInflation: true,
      jointAndSurvivorPct: 0,
      start: { kind: 'age', years: 65, months: 0 },
      taxable: true,
      ...payload,
    },
  };
  await putAggregate('incomeStream', s);
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

describe('ScenarioIncomeOverridesCard', () => {
  it('Edit on a canonical row navigates to the scenario-patch editor URL', async () => {
    await seedMember();
    await seedStream('inc-1', { name: 'ACME Pension' });
    const base = scenarioAgg('scn-base', { name: 'Base', isPrimary: true });
    renderCard(base, [base]);

    const row = (await screen.findByText('ACME Pension')).closest(
      'li',
    ) as HTMLElement;
    expect(within(row).getByText('Default')).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));

    await waitFor(() =>
      expect(lastLocation).toBe(
        '/income/inc-1/edit?scenarioId=scn-base&returnTo=%2Fscenarios%2Fscn-base%2Fincome',
      ),
    );
  });

  it('a patched row shows the "Modified" badge and Edit navigates the same way', async () => {
    await seedMember();
    await seedStream('inc-1', { name: 'ACME Pension', monthlyBenefit: 1200 });
    const child = scenarioAgg('scn-a', {
      name: 'Alt',
      parentScenarioId: null,
      overrides: {
        income: { patches: { 'aggregate:inc-1': { monthlyBenefit: 2500 } } },
      },
    });
    renderCard(child, [child]);

    const row = (await screen.findByText('ACME Pension')).closest(
      'li',
    ) as HTMLElement;
    expect(within(row).getByText('Modified')).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    await waitFor(() =>
      expect(lastLocation).toBe(
        '/income/inc-1/edit?scenarioId=scn-a&returnTo=%2Fscenarios%2Fscn-a%2Fincome',
      ),
    );
  });

  it('a patched row whose patch is ancestor-only renders Edit but NO Reset', async () => {
    await seedMember();
    await seedStream('inc-1', { name: 'ACME Pension', monthlyBenefit: 1200 });
    // The patch lives on the parent; the child inherits the resolution but owns no `patches` key, so Reset (which deletes only the current scenario's key) would be a no-op and must not render.
    const parent = scenarioAgg('scn-p', {
      name: 'Parent',
      isPrimary: true,
      overrides: {
        income: { patches: { 'aggregate:inc-1': { monthlyBenefit: 2500 } } },
      },
    });
    const child = scenarioAgg('scn-c', {
      name: 'Child',
      parentScenarioId: 'scn-p',
    });
    renderCard(child, [parent, child]);

    const row = (await screen.findByText('ACME Pension')).closest(
      'li',
    ) as HTMLElement;
    expect(within(row).getByText('Modified')).toBeInTheDocument();
    expect(
      within(row).getByRole('button', { name: 'Edit' }),
    ).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('a patched row owned by the current scenario renders Reset', async () => {
    await seedMember();
    await seedStream('inc-1', { name: 'ACME Pension', monthlyBenefit: 1200 });
    const child = scenarioAgg('scn-a', {
      name: 'Alt',
      parentScenarioId: null,
      overrides: {
        income: { patches: { 'aggregate:inc-1': { monthlyBenefit: 2500 } } },
      },
    });
    renderCard(child, [child]);

    const row = (await screen.findByText('ACME Pension')).closest(
      'li',
    ) as HTMLElement;
    expect(
      within(row).getByRole('button', { name: 'Reset' }),
    ).toBeInTheDocument();
  });

  it('Edit on a scenario-only added row navigates to the add-edit entry URL', async () => {
    await seedMember();
    const base = scenarioAgg('scn-base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        income: {
          added: [
            {
              _localId: 'lid-1',
              name: 'Side gig',
              notes: '',
              memberId: 'hm-1',
              kind: 'partTime',
              annualAmount: 20000,
              tracksInflation: true,
              start: { kind: 'age', years: 67, months: 0 },
              end: { kind: 'durationFromStart', months: 60 },
              taxable: true,
            },
          ],
        },
      },
    });
    renderCard(base, [base]);

    const row = (await screen.findByText('Side gig')).closest(
      'li',
    ) as HTMLElement;
    expect(within(row).getByText('Scenario-only')).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    await waitFor(() =>
      expect(lastLocation).toBe(
        '/income/scenario-entry?scenarioId=scn-base&editLocalId=lid-1&returnTo=%2Fscenarios%2Fscn-base%2Fincome',
      ),
    );
  });

  it('an inherited added row (from a parent scenario) renders NO Edit / Move / Delete actions', async () => {
    await seedMember();
    const parent = scenarioAgg('scn-p', {
      name: 'Parent',
      isPrimary: true,
      overrides: {
        income: {
          added: [
            {
              _localId: 'lid-parent',
              name: 'Parent gig',
              notes: '',
              memberId: 'hm-1',
              kind: 'partTime',
              annualAmount: 20000,
              tracksInflation: true,
              start: { kind: 'age', years: 67, months: 0 },
              end: { kind: 'durationFromStart', months: 60 },
              taxable: true,
            },
          ],
        },
      },
    });
    const child = scenarioAgg('scn-c', {
      name: 'Child',
      parentScenarioId: 'scn-p',
      overrides: {
        income: {
          added: [
            {
              _localId: 'lid-child',
              name: 'Child gig',
              notes: '',
              memberId: 'hm-1',
              kind: 'partTime',
              annualAmount: 12000,
              tracksInflation: true,
              start: { kind: 'age', years: 67, months: 0 },
              end: { kind: 'durationFromStart', months: 60 },
              taxable: true,
            },
          ],
        },
      },
    });
    renderCard(child, [parent, child]);

    // The inherited (parent-owned) added row resolves into this child card but its actions would mutate only the child's own `added[]`, so they must not render.
    const inheritedRow = (await screen.findByText('Parent gig')).closest(
      'li',
    ) as HTMLElement;
    expect(within(inheritedRow).getByText('Scenario-only')).toBeInTheDocument();
    expect(
      within(inheritedRow).queryByRole('button', { name: 'Edit' }),
    ).toBeNull();
    expect(
      within(inheritedRow).queryByRole('button', {
        name: 'Move to household list',
      }),
    ).toBeNull();
    expect(
      within(inheritedRow).queryByRole('button', { name: 'Delete' }),
    ).toBeNull();

    const ownRow = (await screen.findByText('Child gig')).closest(
      'li',
    ) as HTMLElement;
    expect(
      within(ownRow).getByRole('button', { name: 'Edit' }),
    ).toBeInTheDocument();
    expect(
      within(ownRow).getByRole('button', { name: 'Move to household list' }),
    ).toBeInTheDocument();
    expect(
      within(ownRow).getByRole('button', { name: 'Delete' }),
    ).toBeInTheDocument();
  });

  it('the "Add scenario-only income" header action navigates to the scenario-entry add URL', async () => {
    await seedMember();
    await seedStream('inc-1', { name: 'ACME Pension' });
    const base = scenarioAgg('scn-base', { name: 'Base', isPrimary: true });
    renderCard(base, [base]);

    await screen.findByText('ACME Pension');
    fireEvent.click(
      screen.getByRole('button', { name: 'Add scenario-only income' }),
    );
    await waitFor(() =>
      expect(lastLocation).toBe(
        '/income/scenario-entry?scenarioId=scn-base&returnTo=%2Fscenarios%2Fscn-base%2Fincome',
      ),
    );
  });

  it('has NO per-row "Override amount" button and no amount-only modal', async () => {
    await seedMember();
    await seedStream('inc-1', { name: 'ACME Pension' });
    const base = scenarioAgg('scn-base', { name: 'Base', isPrimary: true });
    renderCard(base, [base]);

    await screen.findByText('ACME Pension');
    // The deleted PatchAmountModal surfaced an "Override amount" dialog; none of that copy may exist.
    expect(
      screen.queryByRole('button', { name: /override amount/i }),
    ).toBeNull();
    expect(screen.queryByText(/override amount/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });
});

describe('ScenarioIncomeOverridesCard — reactive read layer', () => {
  it('re-reads the canonical income list on WORKSPACE_CHANGED_EVENT without a remount', async () => {
    await seedMember();
    const base = scenarioAgg('scn-base', { name: 'Base', isPrimary: true });
    renderCard(base, [base]);

    expect(
      await screen.findByText(/No income to adjust yet/i),
    ).toBeInTheDocument();

    // A bulk fill lands after mount, then the coarse workspace-change event.
    await seedStream('inc-1', { name: 'ACME Pension' });
    const { notifyWorkspaceChanged } = await import('../lib/workspace-events');
    await act(async () => {
      notifyWorkspaceChanged();
    });

    expect(await screen.findByText('ACME Pension')).toBeInTheDocument();
  });

  it('re-reads on a fine-signal incomeStream write (no coarse event)', async () => {
    await seedMember();
    const base = scenarioAgg('scn-base', { name: 'Base', isPrimary: true });
    renderCard(base, [base]);

    expect(
      await screen.findByText(/No income to adjust yet/i),
    ).toBeInTheDocument();

    // A single-row write fires only the per-store signal, no coarse event.
    await act(async () => {
      await seedStream('inc-1', { name: 'ACME Pension' });
    });

    expect(await screen.findByText('ACME Pension')).toBeInTheDocument();
  });
});
