/**
 * useAggregates reactive read-hook tests.
 *
 * Drives the IndexedDB code paths via fake-indexeddb. Covers the live-query
 * contract: the hook returns the current non-deleted aggregates on mount and
 * re-renders on any write to that type's store (put / tombstone-put / delete /
 * clear), on the coarse `WORKSPACE_CHANGED_EVENT` bulk-fill path, settles a
 * write burst to one correct final render (cancel-stale), surfaces an error,
 * and unsubscribes cleanly on unmount.
 */
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

    // The dominant app delete path writes a `deletedAt` row via putAggregate.
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

    // Isolate the coarse channel: write the row directly through the IDB
    // handle (no fine put-signal reaches this reader), then fire only the
    // coarse `WORKSPACE_CHANGED_EVENT` as a bulk fill does. The hook must
    // re-read off the coarse channel alone.
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

    // Fire a burst of single-row writes back-to-back. The hook must collapse
    // the storm to one settled render reflecting the final store state.
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

    // Spy the subscriber wake count via the fine-store listener (not a raw
    // read count): a batched bulk fill of N rows must wake the reader exactly
    // ONCE on scope exit, then settle to the correct final data — the explicit
    // de-storm guard.
    const wakeSpy = vi.fn();
    const unsubscribe = subscribeToStoreChanges('householdMembers', wakeSpy);

    await act(async () => {
      await withBatchedStoreSignals(async (batch) => {
        await putAggregate('householdMember', memberAgg('hm-1'), batch);
        await putAggregate('householdMember', memberAgg('hm-2'), batch);
        await putAggregate('householdMember', memberAgg('hm-3'), batch);
        // Mid-scope: no signal has fired yet, so the reader hasn't been woken.
        expect(wakeSpy).not.toHaveBeenCalled();
      });
    });

    // Exactly one wake for the three-row bulk fill, and the reader lands on the
    // correct final three rows.
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
    // First read rejects; the next write re-reads and resolves cleanly.
    const spy = vi
      .spyOn(store, 'listAggregates')
      .mockRejectedValueOnce(new Error('read boom'))
      .mockResolvedValue(recovered);

    const { result } = renderHook(() => useAggregates('householdMember'));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('read boom');

    // A subsequent store write signal triggers a fresh read off the now-healthy
    // mock; the hook must clear the error and surface the recovered rows.
    await act(async () => {
      await putAggregate('householdMember', memberAgg('hm-1'));
    });

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.aggregates.map((a) => a.id)).toEqual(['hm-1']);
    spy.mockRestore();
  });

  it('unsubscribes from the store on unmount (no leak)', async () => {
    await clearAllStores();

    // Capture the fine-channel unsubscribe so we can prove the cleanup fn ran.
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

    // The subscription cleanup must have run — the hook released its fine-store
    // listener instead of leaking it past unmount.
    expect(unsubscribeSpy).toHaveBeenCalled();
    subscribeSpy.mockRestore();

    // After unmount a further write must not throw or schedule work that
    // touches the torn-down hook. The afterEach clearAllStores also exercises
    // this; here we assert the write resolves cleanly post-unmount.
    await expect(
      putAggregate('householdMember', memberAgg('hm-late')),
    ).resolves.not.toThrow();
  });
});
