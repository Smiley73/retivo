// useBalanceProjectionData re-read regression: the hook mounted against a half-synced (empty) workspace never re-read when the sync layer finished filling IndexedDB and dispatched `WORKSPACE_CHANGED_EVENT`, so the page showed stale partial data until a manual reload. It now reads through the reactive `useAggregates(type)` layer, so a store write or a coarse bulk fill re-reads without a remount.
import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAllStores, db, putAggregate } from '../db/store';
import { notifyWorkspaceChanged } from '../lib/workspace-events';
import type { AccountPayload, Aggregate, ScenarioPayload } from '../db/types';
import { useBalanceProjectionData } from './use-balance-projection-data';

const HH = 'hh-bpp-reload';

function wrapper({ children }: { children: ReactNode }) {
  return createElement(MemoryRouter, null, children);
}

async function seedAccount(): Promise<void> {
  const acc: Aggregate<AccountPayload> = {
    id: 'acc-1',
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'My 401k',
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
  await putAggregate('account', acc);
}

async function seedBaseScenario(): Promise<string> {
  const id = 'scn-base';
  const scn: Aggregate<ScenarioPayload> = {
    id,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'Base',
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {},
    },
  };
  await putAggregate('scenario', scn);
  return id;
}

describe('useBalanceProjectionData re-read on workspace change', () => {
  afterEach(async () => {
    await clearAllStores();
  });

  it('re-reads aggregates on WORKSPACE_CHANGED_EVENT without a remount', async () => {
    await clearAllStores();

    const { result } = renderHook(() => useBalanceProjectionData(), {
      wrapper,
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.accounts).toHaveLength(0);

    // Simulate the sync layer committing a bulk fill after mount, then dispatching the workspace-change event.
    await seedAccount();
    act(() => {
      notifyWorkspaceChanged();
    });

    await waitFor(() => expect(result.current.accounts).toHaveLength(1));
    expect(result.current.accounts[0]?.payload.name).toBe('My 401k');
  });

  it('resolves selectedScenarioId on WORKSPACE_CHANGED_EVENT after an empty-workspace mount', async () => {
    await clearAllStores();

    const { result } = renderHook(() => useBalanceProjectionData(), {
      wrapper,
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.selectedScenarioId).toBeNull();

    // The sync layer fills the workspace (a base scenario) after mount, then dispatches the event.
    const baseId = await seedBaseScenario();
    act(() => {
      notifyWorkspaceChanged();
    });

    await waitFor(() =>
      expect(result.current.selectedScenarioId).toBe(baseId),
    );
  });

  it('resolves the base scenario from a coarse-event-only bulk fill', async () => {
    await clearAllStores();

    const { result } = renderHook(() => useBalanceProjectionData(), {
      wrapper,
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.selectedScenarioId).toBeNull();

    // A bulk fill writes scenario rows into IDB with no per-row fine signal and dispatches the coarse event once; selected-scenario resolution must re-run off the reactive scenarios list and fall back to the base scenario (the stale-mount bug: selectedScenarioId staying null while scenarios populate).
    const handle = await db();
    await handle.put('scenarios', {
      id: 'scn-base-bulk',
      householdId: HH,
      aggregateType: 'scenario',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Base',
        description: '',
        parentScenarioId: null,
        isPrimary: true,
        notes: '',
        overrides: {},
      },
    } as Aggregate<ScenarioPayload>);
    act(() => {
      notifyWorkspaceChanged();
    });

    await waitFor(() =>
      expect(result.current.selectedScenarioId).toBe('scn-base-bulk'),
    );
  });
});
