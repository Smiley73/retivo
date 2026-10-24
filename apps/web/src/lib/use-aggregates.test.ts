import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  deleteAggregateLocally,
  putAggregate,
  subscribeToStoreChanges,
  withBatchedStoreSignals,
} from '../db/store';
import * as store from '../db/store';
import { notifyWorkspaceChanged } from './workspace-events';
import { useAggregates } from './use-aggregates';
import type { Aggregate, HouseholdMemberPayload } from '../db/types';

const HH = 'hh-use-aggregates';
const DEVICE = 'dev-test';

function memberAgg(
  id: string,
  overrides: Partial<HouseholdMemberPayload> = {},
  base: Partial<Aggregate<HouseholdMemberPayload>> = {},
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: DEVICE,
    payload: {
      isPrimary: true,
      firstName: 'Alex',
      lastName: 'Test',
      email: 'alex@example.test',
      birthdate: '1985-04-15',
      ...overrides,
    },
    ...base,
  };
}

describe('useAggregates', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearAllStores();
  });

  it('returns the current non-deleted aggregates on mount', async () => {
    await clearAllStores();
    await putAggregate('householdMember', memberAgg('hm-1'));
    await putAggregate('householdMember', {
      ...memberAgg('hm-2'),
      deletedAt: '2026-05-01T01:00:00Z',
    });

    const { result } = renderHook(() => useAggregates('householdMember'));

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.aggregates.map((a) => a.id)).toEqual(['hm-1']);
    expect(result.current.error).toBeNull();
  });

  it('re-renders on putAggregate without a remount', async () => {
    await clearAllStores();

    const { result } = renderHook(() => useAggregates('householdMember'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.aggregates).toHaveLength(0);

    await act(async () => {
      await putAggregate('householdMember', memberAgg('hm-1'));
    });

    await waitFor(() => expect(result.current.aggregates).toHaveLength(1));
    expect(result.current.aggregates[0]?.id).toBe('hm-1');
  });

  it('filters out a row tombstoned via putAggregate', async () => {
    await clearAllStores();
    await putAggregate('householdMember', memberAgg('hm-1'));

    const { result } = renderHook(() => useAggregates('householdMember'));
    await waitFor(() => expect(result.current.aggregates).toHaveLength(1));

    await act(async () => {
      await putAggregate('householdMember', {
        ...memberAgg('hm-1'),
        deletedAt: '2026-05-02T00:00:00Z',
      });
    });

    await waitFor(() => expect(result.current.aggregates).toHaveLength(0));
  });

  it('re-renders on deleteAggregateLocally', async () => {
    await clearAllStores();
    await putAggregate('householdMember', memberAgg('hm-1'));

    const { result } = renderHook(() => useAggregates('householdMember'));
    await waitFor(() => expect(result.current.aggregates).toHaveLength(1));

    await act(async () => {
      await deleteAggregateLocally('householdMember', 'hm-1');
    });

    await waitFor(() => expect(result.current.aggregates).toHaveLength(0));
  });

  it('re-renders on clearAllStores', async () => {
    await clearAllStores();
    await putAggregate('householdMember', memberAgg('hm-1'));

    const { result } = renderHook(() => useAggregates('householdMember'));
    await waitFor(() => expect(result.current.aggregates).toHaveLength(1));

    await act(async () => {
      await clearAllStores();
    });

    await waitFor(() => expect(result.current.aggregates).toHaveLength(0));
  });

  it('re-renders on the coarse WORKSPACE_CHANGED_EVENT (bulk-fill path)', async () => {
    await clearAllStores();

    const { result } = renderHook(() => useAggregates('householdMember'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.aggregates).toHaveLength(0);

    // Write the row directly through the IDB handle so no fine put-signal reaches the reader, then fire only the coarse WORKSPACE_CHANGED_EVENT, as a bulk fill does.
    const handle = await store.db();
    await handle.put('householdMembers', memberAgg('hm-1'));
    act(() => {
      notifyWorkspaceChanged();
    });

    await waitFor(() => expect(result.current.aggregates).toHaveLength(1));
  });

  it('settles a burst of writes to one correct final render (cancel-stale)', async () => {
    await clearAllStores();

    const { result } = renderHook(() => useAggregates('householdMember'));
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await putAggregate('householdMember', memberAgg('hm-1'));
      await putAggregate('householdMember', memberAgg('hm-2'));
      await putAggregate('householdMember', memberAgg('hm-3'));
    });

    await waitFor(() => expect(result.current.aggregates).toHaveLength(3));
    expect(result.current.aggregates.map((a) => a.id).sort()).toEqual([
      'hm-1',
      'hm-2',
      'hm-3',
    ]);
  });

  it('settles to one correct final render on a batched bulk fill with a single post-loop wake', async () => {
    await clearAllStores();

    const { result } = renderHook(() => useAggregates('householdMember'));
    await waitFor(() => expect(result.current.ready).toBe(true));

    // Count wakes via the fine-store listener: a batched bulk fill of N rows must wake the reader once on scope exit.
    const wakeSpy = vi.fn();
    const unsubscribe = subscribeToStoreChanges('householdMembers', wakeSpy);

    await act(async () => {
      await withBatchedStoreSignals(async (batch) => {
        await putAggregate('householdMember', memberAgg('hm-1'), batch);
        await putAggregate('householdMember', memberAgg('hm-2'), batch);
        await putAggregate('householdMember', memberAgg('hm-3'), batch);
        expect(wakeSpy).not.toHaveBeenCalled();
      });
    });

    expect(wakeSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.aggregates).toHaveLength(3));
    expect(result.current.aggregates.map((a) => a.id).sort()).toEqual([
      'hm-1',
      'hm-2',
      'hm-3',
    ]);
    unsubscribe();
  });

  it('surfaces an error when the read throws', async () => {
    await clearAllStores();
    const spy = vi
      .spyOn(store, 'listAggregates')
      .mockRejectedValue(new Error('read boom'));

    const { result } = renderHook(() => useAggregates('householdMember'));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('read boom');
    expect(result.current.ready).toBe(true);
    spy.mockRestore();
  });

  it('clears error on recovery after failure', async () => {
    await clearAllStores();
    const recovered = [memberAgg('hm-1')];
    const spy = vi
      .spyOn(store, 'listAggregates')
      .mockRejectedValueOnce(new Error('read boom'))
      .mockResolvedValue(recovered);

    const { result } = renderHook(() => useAggregates('householdMember'));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('read boom');

    await act(async () => {
      await putAggregate('householdMember', memberAgg('hm-1'));
    });

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.aggregates.map((a) => a.id)).toEqual(['hm-1']);
    spy.mockRestore();
  });

  it('unsubscribes from the store on unmount (no leak)', async () => {
    await clearAllStores();

    const unsubscribeSpy = vi.fn();
    const realSubscribe = store.subscribeToStoreChanges;
    const subscribeSpy = vi
      .spyOn(store, 'subscribeToStoreChanges')
      .mockImplementation((s, listener) => {
        realSubscribe(s, listener);
        return unsubscribeSpy;
      });

    const { result, unmount } = renderHook(() =>
      useAggregates('householdMember'),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    unmount();

    expect(unsubscribeSpy).toHaveBeenCalled();
    subscribeSpy.mockRestore();

    await expect(
      putAggregate('householdMember', memberAgg('hm-late')),
    ).resolves.not.toThrow();
  });
});
