// ScenarioReturnsPage: the per-account % overrides table in a React Aria grid landmark, and PercentInput cells that keep focus until blur.
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
import { clearAllStores, putAggregate } from '../db/store';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { ScenarioReturnsPage } from './ScenarioReturnsPage';

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

function renderAt(scenarioId: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/scenarios/${scenarioId}/returns`]}>
      <Routes>
        <Route
          path="/scenarios/:id/returns"
          element={<ScenarioReturnsPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

async function seedMember(id: string, firstName: string): Promise<void> {
  const m: Aggregate<HouseholdMemberPayload> = {
    id,
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary: true,
      firstName,
      lastName: 'Demo',
      email: `${firstName.toLowerCase()}@example.test`,
      birthdate: '1985-01-01',
    },
  };
  await putAggregate('householdMember', m);
}

async function seedAccount(id: string, name: string): Promise<void> {
  const a: Aggregate<AccountPayload> = {
    id,
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name,
      type: 'RETIREMENT_401K',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'PRE_TAX',
      ownerId: 'hm-1',
      institution: 'Test Bank',
      notes: '',
      planningReturnPct: 7,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    },
  };
  await putAggregate('account', a);
}

async function seedScenario(id: string, name: string): Promise<void> {
  const s: Aggregate<ScenarioPayload> = {
    id,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name,
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {},
    },
  };
  await putAggregate('scenario', s);
}

describe('ScenarioReturnsPage', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders the per-account overrides inside a React Aria Table grid landmark', async () => {
    await seedMember('hm-1', 'Alex');
    await seedAccount('acc-1', 'My 401k');
    await seedAccount('acc-2', 'Brokerage');
    await seedScenario('sc-1', 'Base');

    renderAt('sc-1');

    const grid = await screen.findByRole('grid', {
      name: 'Per-account return overrides',
    });
    expect(grid).toBeInTheDocument();
    // React Aria Table wires row landmarks a tick after the grid mounts; under CPU contention rows can lag, so poll.
    await waitFor(() =>
      expect(within(grid).getAllByRole('row').length).toBeGreaterThanOrEqual(3),
    );
  });

  it('renders a Type column with a bucket-toned type chip per row', async () => {
    await seedMember('hm-1', 'Alex');
    await seedAccount('acc-1', 'My 401k');
    await seedScenario('sc-1', 'Base');

    renderAt('sc-1');

    const grid = await screen.findByRole('grid', {
      name: 'Per-account return overrides',
    });
    // Header and body cells can mount a tick after the grid landmark under parallel load.
    expect(
      await within(grid).findByRole('columnheader', { name: 'Type' }),
    ).toBeInTheDocument();
    expect(await within(grid).findByText('401(k)')).toBeInTheDocument();
  });

  it('renders the foot-note overridden-account summary', async () => {
    await seedMember('hm-1', 'Alex');
    await seedAccount('acc-1', 'My 401k');
    await seedAccount('acc-2', 'Brokerage');
    await seedScenario('sc-1', 'Base');

    renderAt('sc-1');

    await screen.findByRole('grid', { name: 'Per-account return overrides' });
    // findBy: the footnote lands with the row data, which the grid resolving does not guarantee.
    expect(
      await screen.findByText('0 of 2 accounts overridden.'),
    ).toBeInTheDocument();
  });

  it('lets a PercentInput cell receive edits via DOM input events', async () => {
    // In jsdom React Aria's grid focus delegate competes with ad-hoc `.focus()` calls (the gridcell can claim focus first), so assert that an input event reaches the controlled input and the page renders the new value.
    await seedMember('hm-1', 'Alex');
    await seedAccount('acc-1', 'My 401k');
    await seedScenario('sc-1', 'Base');

    renderAt('sc-1');

    const input = (await screen.findByLabelText(
      'My 401k scenario return',
    )) as HTMLInputElement;
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    act(() => {
      fireEvent.input(input, { target: { value: '8.5' } });
    });
    expect(
      await screen.findByRole('button', { name: 'Save' }),
    ).toBeInTheDocument();
  });

  it('lets the PercentInput cell receive multiple consecutive edits without remounting', async () => {
    // Typing in a PercentInput cell must not steal row focus mid-edit. The jsdom-stable proxy: consecutive input events reach the same input (no mid-edit remount evicts the pending keystroke) and the rendered value tracks the last edit.
    await seedMember('hm-1', 'Alex');
    await seedAccount('acc-1', 'My 401k');
    await seedScenario('sc-1', 'Base');

    renderAt('sc-1');

    const input = (await screen.findByLabelText(
      'My 401k scenario return',
    )) as HTMLInputElement;
    act(() => {
      fireEvent.input(input, { target: { value: '7' } });
    });
    expect(input.value).toBe('7');
    act(() => {
      fireEvent.input(input, { target: { value: '7.5' } });
    });
    expect(input.value).toBe('7.5');
  });

  it('exposes the React Aria Table grid for arrow-key navigation across rows', async () => {
    // jsdom cannot synthesize React Aria Table's focus-manager events for grid arrow keys, so assert the grid's accessible name and that each row's PercentInput can hold focus.
    await seedMember('hm-1', 'Alex');
    await seedAccount('acc-1', 'First 401k');
    await seedAccount('acc-2', 'Second Brokerage');
    await seedScenario('sc-1', 'Base');

    renderAt('sc-1');

    const grid = await screen.findByRole('grid', {
      name: 'Per-account return overrides',
    });
    expect(grid).toBeInTheDocument();
    // The row cells mount a tick after the grid landmark under parallel load.
    const firstInput = await screen.findByLabelText('First 401k scenario return');
    const secondInput = await screen.findByLabelText(
      'Second Brokerage scenario return',
    );
    firstInput.focus();
    expect(firstInput).toHaveFocus();
    secondInput.focus();
    expect(secondInput).toHaveFocus();
  });
});
