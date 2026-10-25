// ScenarioWithdrawalStrategyPage route tests over seeded IndexedDB: editor, title, subtitle and breadcrumb; save→remount re-disables Save; round trip to the detail card; and the failure paths (save throws, reload-after-save throws).
import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  clearMutationQueue,
  listPendingMutations,
  putAggregate,
} from '../db/store';
import * as store from '../db/store';
import type { Aggregate, ScenarioPayload } from '../db/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { ScenarioWithdrawalStrategyPage } from './ScenarioWithdrawalStrategyPage';
import { ScenarioDetailPage } from './ScenarioDetailPage';

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

async function seedScenario(
  id: string,
  overrides: ScenarioPayload['overrides'] = {},
  name = id,
): Promise<void> {
  const a: Aggregate<ScenarioPayload> = {
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
      overrides,
    },
  };
  await putAggregate('scenario', a);
}

function renderPage(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/scenarios/${id}/withdrawal-strategy`]}>
      <Routes>
        <Route
          path="/scenarios/:id/withdrawal-strategy"
          element={<ScenarioWithdrawalStrategyPage />}
        />
        <Route path="/scenarios/:id" element={<ScenarioDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setupContexts();
});

afterEach(async () => {
  await clearAllStores();
  await clearMutationQueue();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('ScenarioWithdrawalStrategyPage — chrome', () => {
  it('renders the editor, the PageHeader title + intro subtitle, and the breadcrumb', async () => {
    await seedScenario('sc-1', { withdrawalStrategy: { kind: 'taxEfficient' } }, 'Base');
    renderPage('sc-1');

    await screen.findByRole('tab', { name: /Strategy/ });
    expect(screen.getByRole('heading', { name: /Withdrawal strategy: Base/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Decide the order your accounts are tapped/i),
    ).toBeInTheDocument();
    const crumb = screen.getByRole('link', { name: /Back to scenario/i });
    expect(crumb).toHaveAttribute('href', '/scenarios/sc-1');
  });

  it('shows a not-found error for an unknown scenario', async () => {
    renderPage('missing');
    expect(
      await screen.findByText(/Scenario missing not found\./i),
    ).toBeInTheDocument();
  });
});

describe('ScenarioWithdrawalStrategyPage — strategy picker', () => {
  it('offers exactly the four named strategies and no Combined pot option', async () => {
    await seedScenario('sc-1', { withdrawalStrategy: { kind: 'taxEfficient' } }, 'Base');
    renderPage('sc-1');
    await screen.findByRole('tab', { name: /Strategy/ });

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(screen.getByRole('radio', { name: /Tax-efficient/i })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Proportional/i })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Roth first/i })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Custom order/i })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Combined pot/i })).toBeNull();
  });
});

describe('ScenarioWithdrawalStrategyPage — save lifecycle', () => {
  it('save persists, stays on the page, and Save re-disables after the reload version bump', async () => {
    await seedScenario('sc-1', { withdrawalStrategy: { kind: 'taxEfficient' } }, 'Base');
    renderPage('sc-1');

    await screen.findByRole('tab', { name: /Strategy/ });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await userEvent.click(screen.getByRole('radio', { name: /Roth first/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled(),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    await waitFor(async () => {
      const pending = await listPendingMutations();
      expect(pending.find((p) => p.aggregateId === 'sc-1')).toBeTruthy();
    });

    // Save re-disables after the save-triggered reload remounts the editor clean.
    await screen.findByRole('tab', { name: /Strategy/ });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled(),
    );
    expect(screen.getByRole('radio', { name: /Roth first/i })).toBeChecked();
  });

  it('Cancel returns to the detail page where the saved summary is reflected', async () => {
    await seedScenario('sc-1', { withdrawalStrategy: { kind: 'taxEfficient' } }, 'Base');
    renderPage('sc-1');

    await screen.findByRole('tab', { name: /Strategy/ });
    await userEvent.click(screen.getByRole('radio', { name: /Roth first/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled(),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    const card = await screen.findByRole('region', { name: /Withdrawal strategy/i });
    expect(within(card).getByText(/Roth first/i)).toBeInTheDocument();
  });

  it('a save failure keeps the draft dirty, shows the error, and does not remount', async () => {
    await seedScenario('sc-1', { withdrawalStrategy: { kind: 'taxEfficient' } }, 'Base');
    renderPage('sc-1');
    await screen.findByRole('tab', { name: /Strategy/ });

    const spy = vi
      .spyOn(store, 'putAggregate')
      .mockRejectedValue(new Error('boom-save'));

    await userEvent.click(screen.getByRole('radio', { name: /Roth first/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    expect(await screen.findByText(/boom-save/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/Saved, but refreshing failed/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
    spy.mockRestore();
  });

  it('a reload failure after a durable save surfaces "saved; refresh failed", not "Failed to save"', async () => {
    await seedScenario('sc-1', { withdrawalStrategy: { kind: 'taxEfficient' } }, 'Base');
    renderPage('sc-1');
    await screen.findByRole('tab', { name: /Strategy/ });

    await userEvent.click(screen.getByRole('radio', { name: /Roth first/i }));

    // The save itself succeeds; only the post-save reload throws: make every list reject so reload() rejects after the durable save committed.
    const spy = vi
      .spyOn(store, 'listAggregates')
      .mockRejectedValue(new Error('boom-reload'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    expect(
      await screen.findByText(/Saved, but refreshing failed/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Failed to save\./i)).not.toBeInTheDocument();
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.aggregateId === 'sc-1')).toBeTruthy();
    spy.mockRestore();
  });
});
