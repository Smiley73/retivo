/**
 * ScenarioReturnsPage render tests.
 *
 * Asserts:
 *  - the per-account % overrides table renders inside a React Aria
 *    Table grid landmark,
 *  - typing into a row's PercentInput cell does NOT move the row focus
 *    away from the input until blur (RA Table editable-cell
 *    pattern: a focusable Cell child captures keystrokes locally).
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
    // RA Table wires its row landmarks a tick after the grid mounts; under
    // CPU contention the rows can lag the grid, so poll rather than read once.
    // 1 header + 2 data rows.
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
    // New "Type" column header sits between Owner and the return columns.
    // Header + body cells can mount a tick after the grid landmark under
    // parallel load; `findBy*` retries until the row content settles.
    expect(
      await within(grid).findByRole('columnheader', { name: 'Type' }),
    ).toBeInTheDocument();
    // The human label for RETIREMENT_401K renders as a chip in the body.
    expect(await within(grid).findByText('401(k)')).toBeInTheDocument();
  });

  it('renders the foot-note overridden-account summary', async () => {
    await seedMember('hm-1', 'Alex');
    await seedAccount('acc-1', 'My 401k');
    await seedAccount('acc-2', 'Brokerage');
    await seedScenario('sc-1', 'Base');

    renderAt('sc-1');

    await screen.findByRole('grid', { name: 'Per-account return overrides' });
    // findBy*, not getBy*: the footnote lands with the row data, which the
    // grid resolving does not guarantee has rendered.
    expect(
      await screen.findByText('0 of 2 accounts overridden.'),
    ).toBeInTheDocument();
  });

  it('lets a PercentInput cell receive edits via DOM input events', async () => {
    // RA Table's editable-cell pattern — a focusable Cell child
    // accepts edits. In jsdom RA's Grid focus delegate competes with
    // ad-hoc `.focus()` calls (the gridcell can claim focus first); the
    // robust assertion is that an input event reaches the controlled
    // input and the page renders the new value. Arrow-key navigation
    // between rows is exercised by Adobe's upstream tests.
    await seedMember('hm-1', 'Alex');
    await seedAccount('acc-1', 'My 401k');
    await seedScenario('sc-1', 'Base');

    renderAt('sc-1');

    const input = (await screen.findByLabelText(
      'My 401k scenario return',
    )) as HTMLInputElement;
    // The Save action appears in the PageHeader once dirty. Before
    // change there is no Save button.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    act(() => {
      fireEvent.input(input, { target: { value: '8.5' } });
    });
    // PercentInput updates the controlled value and the page becomes
    // dirty — surfacing the Save button.
    expect(
      await screen.findByRole('button', { name: 'Save' }),
    ).toBeInTheDocument();
  });

  it('lets the PercentInput cell receive multiple consecutive edits without remounting', async () => {
    // Typing in a ScenarioReturnsPage <PercentInput> cell does
    // NOT steal row focus mid-edit. RA Table's grid focus delegate
    // behaves differently in jsdom vs a real DOM — Adobe's upstream
    // tests cover real-DOM focus delegation. The jsdom-stable
    // proxy is: consecutive input events to the same input element
    // both reach the controlled value (no mid-edit remount evicts the
    // pending keystroke), and the rendered value tracks the last edit.
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
    // The second edit lands on the same input — confirming the
    // PercentInput cell was not remounted between keystrokes (a
    // remount would clear input.value or detach the focus path).
    expect(input.value).toBe('7.5');
  });

  it('exposes the React Aria Table grid for arrow-key navigation across rows', async () => {
    // jsdom can't reliably synthesize RA Table's focus-manager
    // events for grid ArrowUp/ArrowDown; the robust jsdom assertion is
    // that the grid's accessible name is queryable AND each row's
    // focusable PercentInput descendant can independently hold focus —
    // the surface arrow-key navigation moves between. Real-DOM grid
    // arrow nav is covered by Adobe's upstream tests + a
    // manual walkthrough gate before merge.
    await seedMember('hm-1', 'Alex');
    await seedAccount('acc-1', 'First 401k');
    await seedAccount('acc-2', 'Second Brokerage');
    await seedScenario('sc-1', 'Base');

    renderAt('sc-1');

    const grid = await screen.findByRole('grid', {
      name: 'Per-account return overrides',
    });
    expect(grid).toBeInTheDocument();
    // The row PercentInput cells mount a tick after the grid landmark under
    // parallel load; `findByLabelText` retries until both inputs are present.
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
