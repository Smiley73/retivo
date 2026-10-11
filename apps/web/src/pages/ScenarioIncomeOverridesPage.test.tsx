/**
 * ScenarioIncomeOverridesPage reactive-read tests.
 *
 * The page reads the `scenario` store via `useAggregates('scenario')` to
 * resolve the scenario at /scenarios/:id/income. These tests prove it
 * re-derives when the scenario lands after mount — via the coarse
 * workspace event AND a fine-signal `scenario` write — without a remount.
 * Drives IndexedDB through fake-indexeddb; AuthContext + SyncContext are
 * mocked at the module boundary like the sibling page tests.
 */
import 'fake-indexeddb/auto';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores, putAggregate } from '../db/store';
import type { Aggregate, ScenarioPayload } from '../db/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { ScenarioIncomeOverridesPage } from './ScenarioIncomeOverridesPage';

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

function renderPage(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/scenarios/${id}/income`]}>
      <Routes>
        <Route
          path="/scenarios/:id/income"
          element={<ScenarioIncomeOverridesPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

async function seedScenario(id: string, name: string): Promise<void> {
  const row: Aggregate<ScenarioPayload> = {
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
  await putAggregate('scenario', row);
}

describe('ScenarioIncomeOverridesPage — reactive read layer', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('re-reads the scenario on WORKSPACE_CHANGED_EVENT without a remount', async () => {
    await clearAllStores();
    renderPage('scn-1');
    // Mounted before the scenario exists: the not-found error renders.
    expect(
      await screen.findByText(/Scenario scn-1 not found/i),
    ).toBeInTheDocument();

    // Bulk fill lands after mount, then the coarse workspace-change event.
    await seedScenario('scn-1', 'Base');
    const { notifyWorkspaceChanged } = await import('../lib/workspace-events');
    await act(async () => {
      notifyWorkspaceChanged();
    });

    // Same page instance now resolves the scenario (card header renders).
    expect(
      await screen.findByRole('heading', { name: /Income: Base/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(/not found/i)).not.toBeInTheDocument(),
    );
  });

  it('re-reads on a fine-signal scenario write (no coarse event)', async () => {
    await clearAllStores();
    renderPage('scn-1');
    expect(
      await screen.findByText(/Scenario scn-1 not found/i),
    ).toBeInTheDocument();

    // Single-row write fires only the per-store fine `scenario` signal.
    await act(async () => {
      await seedScenario('scn-1', 'Base');
    });

    expect(
      await screen.findByRole('heading', { name: /Income: Base/ }),
    ).toBeInTheDocument();
  });
});
