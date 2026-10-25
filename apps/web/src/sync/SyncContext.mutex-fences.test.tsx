// SyncProvider sync mutex, batched store signals and the destructive-operation fence.
import 'fake-indexeddb/auto';
import { screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getStoreVersion, listAggregates, readDeviceMetadata, listPendingMutations, subscribeToStoreChanges, writeDeviceMetadata } from '../db/store';
import * as storeModule from '../db/store';
import { useSync } from './SyncContext';
import { fake, renderProvider, seedMutation, useSyncTestHooks } from './sync-context.test-harness';

vi.mock('./mock-sync', async () => (await import('./sync-context.test-fake')).mockSyncModule);


// A promise-chain mutex serializes pull / bootstrap / flush / restore, and every `deviceMetadata` write is a field-level
// functional update in one IDB transaction, which closes the lost-update class between a pull's cursor and a flush's counter.
describe('SyncProvider — sync mutex + transactional metadata writes', () => {
  useSyncTestHooks('hh-1');

  it('flush queued behind an in-flight pull runs after it; pull cursor is preserved (no revert)', async () => {
    // Holds the pull open, fires the flush, and asserts the push starts only after the pull resolves.
    function OrderProbe() {
      const sync = useSync();
      return (
        <div>
          <div data-testid="state">{sync.state.kind}</div>
          <button onClick={() => void sync.syncRoundTrip()}>roundtrip</button>
          <button onClick={() => void sync.notifyPending()}>notify</button>
        </div>
      );
    }
    const renderOrderProvider = () => renderProvider({ probe: <OrderProbe /> });
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'seed-cursor',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({
      changes: [],
      newCursor: 'seed-cursor',
      hasMore: false,
    });
    renderOrderProvider();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );

    // The round-trip starts with an empty queue; the mutation is added during the gated pull so the notify-flush has work that must wait for the mutex.
    const events: string[] = [];
    let releasePull: () => void = () => {};
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    let seededDuringPull = false;
    fake.pullImpl = async () => {
      events.push('pull:start');
      if (!seededDuringPull) {
        seededDuringPull = true;
        await seedMutation({ id: 'order-mut', aggregateId: 'order-agg' });
      }
      await pullGate;
      events.push('pull:resolve');
      return { changes: [], newCursor: 'fresh-pull-cursor', hasMore: false };
    };
    fake.pushImpl = async (args) => {
      events.push('push:start');
      return {
        applied: args.mutations.map((m) => ({
          status: 'applied' as const,
          mutationId: m.id,
          aggregateId: m.aggregateId,
          newVersion: m.expectedVersion + 1,
          newUpdatedAt: new Date().toISOString(),
        })),
        rejected: [],
        syncCursor: '0',
      };
    };

    await act(async () => {
      fireEvent.click(screen.getByText('roundtrip'));
    });
    await waitFor(() => expect(events).toContain('pull:start'));
    await act(async () => {
      fireEvent.click(screen.getByText('notify'));
      await Promise.resolve();
    });
    expect(events).not.toContain('push:start');

    await act(async () => {
      releasePull();
    });
    await waitFor(() => expect(events).toContain('push:start'));

    expect(events.indexOf('pull:resolve')).toBeLessThan(
      events.indexOf('push:start'),
    );
    await waitFor(async () => {
      expect((await readDeviceMetadata())?.syncCursor).toBe('fresh-pull-cursor');
    });
  });

  it('a freshness-pin persist concurrent with a pull metadata write loses neither field (transactional RMW)', async () => {
    // A pull-style write (syncCursor) and a flush-style write (freshnessCounter) run concurrently through updateDeviceMetadata;
    // as functional updates in one transaction both must survive, which the old read-spread-write pair would not.
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'before',
      lastSyncedAt: null,
      displayName: 'This device',
    });
    await Promise.all([
      storeModule.updateDeviceMetadata((current) => ({
        ...(current ?? { deviceId: 'dev-test', syncCursor: '0', lastSyncedAt: null, displayName: 'This device' }),
        deviceId: 'dev-test',
        syncCursor: 'cursor-from-pull',
      })),
      storeModule.updateDeviceMetadata((current) => ({
        ...(current ?? { deviceId: 'dev-test', syncCursor: '0', lastSyncedAt: null, displayName: 'This device' }),
        deviceId: 'dev-test',
        freshnessCounter: 7,
      })),
    ]);
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('cursor-from-pull');
    expect(meta?.freshnessCounter).toBe(7);
  });

  it('a notifyPending burst during an in-flight flush still coalesces into one push (mutex does not multiply pushes)', async () => {
    // A burst of notifyPending calls must collapse into one flush (plus at most one rerun for work that arrived mid-flight), not N sequential lock acquisitions.
    await seedMutation({ id: 'burst-1', aggregateId: 'burst-agg' });
    let inFlight = 0;
    let maxInFlight = 0;
    let pushCalls = 0;
    fake.pushImpl = async (args) => {
      inFlight += 1;
      pushCalls += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return {
        applied: args.mutations.map((m) => ({
          status: 'applied' as const,
          mutationId: m.id,
          aggregateId: m.aggregateId,
          newVersion: m.expectedVersion + 1,
          newUpdatedAt: new Date().toISOString(),
        })),
        rejected: [],
        syncCursor: '0',
      };
    };
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );
    for (let i = 0; i < 10; i += 1) {
      fireEvent.click(screen.getByText('notifyPending'));
    }
    await waitFor(
      async () => {
        expect(await listPendingMutations()).toHaveLength(0);
      },
      { timeout: 2000 },
    );
    expect(maxInFlight).toBe(1);
    expect(pushCalls).toBeLessThanOrEqual(2);
  });
});


// The bootstrap and pull bulk-fill loops thread the `withBatchedStoreSignals` batch through, so N rows of one type give one
// fine `notifyStoreChanged` per store; the coarse tail would mask a dropped batch, so the fine count is pinned.
describe('SyncProvider — batched fine store signals', () => {
  useSyncTestHooks('hh-1');

  function accountSnapshotRow(i: number) {
    return {
      id: `agg-${i}`,
      householdId: 'hh-1',
      aggregateType: 'account' as const,
      schemaVersion: 1,
      version: 1,
      updatedAt: new Date().toISOString(),
      deviceId: 'dev-server',
      payload: { name: `Account ${i}` },
    };
  }

  function accountPullChange(i: number) {
    return {
      aggregateId: `agg-${i}`,
      aggregateType: 'account' as const,
      operation: 'create' as const,
      payload: { name: `Account ${i}` },
      version: 1,
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      deviceId: 'dev-other',
    };
  }

  it('bootstrap snapshot of N accounts wakes the fine accounts listener exactly once (one per touched store, not per row)', async () => {
    const N = 5;
    // Cursor '0' makes initialSync bootstrap with clearFirst=false, so no clearAllStores fires and the only fine signal is the batched flush.
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-bulk',
      workspaceSnapshot: {
        householdId: 'hh-1',
        aggregates: Array.from({ length: N }, (_, i) => accountSnapshotRow(i)),
      },
      postSnapshotMutations: [],
      syncCursor: '7',
      timestamp: new Date().toISOString(),
    });

    const accountsListener = vi.fn();
    const unsubscribe = subscribeToStoreChanges('accounts', accountsListener);
    try {
      renderProvider();
      await waitFor(() =>
        expect(screen.getByTestId('state')).toHaveTextContent('synced'),
      );
      expect((await listAggregates('account')).length).toBe(N);
      expect(accountsListener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('pull of N accounts wakes the fine accounts listener exactly once across the page (one per touched store, not per row)', async () => {
    const N = 5;
    // A non-zero cursor makes initialSync pull (no wipe); the store version is bumped before subscribing so the seed write does not count.
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-0',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({
      changes: Array.from({ length: N }, (_, i) => accountPullChange(i)),
      newCursor: 'cursor-1',
      hasMore: false,
    });

    const before = getStoreVersion('accounts');
    const accountsListener = vi.fn();
    const unsubscribe = subscribeToStoreChanges('accounts', accountsListener);
    try {
      renderProvider();
      await waitFor(() =>
        expect(screen.getByTestId('state')).toHaveTextContent('synced'),
      );
      expect((await listAggregates('account')).length).toBe(N);
      expect(accountsListener).toHaveBeenCalledTimes(1);
      expect(getStoreVersion('accounts')).toBe(before + 1);
    } finally {
      unsubscribe();
    }
  });
});


// `runDestructive` sets `destructiveOpInProgressRef` before taking the mutex and clears it in a `finally`; while set, a
// background flush or pull early-returns. A throw without reload must still release the fence.
describe('SyncProvider — destructive-op fence (runDestructive)', () => {
  useSyncTestHooks('hh-1');

  let runDestructiveFn: ReturnType<typeof useSync>['runDestructive'] | null = null;
  let notifyPendingFn: (() => void) | null = null;
  let syncRoundTripFn: ReturnType<typeof useSync>['syncRoundTrip'] | null = null;

  function FenceProbe() {
    const sync = useSync();
    runDestructiveFn = sync.runDestructive;
    notifyPendingFn = sync.notifyPending;
    syncRoundTripFn = sync.syncRoundTrip;
    return <div data-testid="state">{sync.state.kind}</div>;
  }

  const renderFenceProvider = () => renderProvider({ probe: <FenceProbe /> });

  it('blocks a concurrent flush from pushing while the destructive window is open, then releases on the finally', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'seed-cursor',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'seed-cursor', hasMore: false });
    let pushCalls = 0;
    fake.pushImpl = async (args) => {
      pushCalls += 1;
      return {
        applied: args.mutations.map((m) => ({
          status: 'applied' as const,
          mutationId: m.id,
          aggregateId: m.aggregateId,
          newVersion: m.expectedVersion + 1,
          newUpdatedAt: new Date().toISOString(),
        })),
        rejected: [],
        syncCursor: '0',
      };
    };

    renderFenceProvider();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );

    let releaseFn: () => void = () => {};
    const fnGate = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    let destructivePromise!: Promise<void>;
    await act(async () => {
      destructivePromise = runDestructiveFn!(async () => {
        await seedMutation({ id: 'fenced-mut', aggregateId: 'fenced-agg' });
        await fnGate;
      });
      await Promise.resolve();
    });

    await act(async () => {
      notifyPendingFn!();
      await Promise.resolve();
    });
    expect(pushCalls).toBe(0);

    await act(async () => {
      releaseFn();
      await destructivePromise;
    });
    await act(async () => {
      notifyPendingFn!();
      await Promise.resolve();
    });
    await waitFor(() => expect(pushCalls).toBeGreaterThanOrEqual(1));
  });

  it('releases the fence in the finally when the destructive fn throws (throw-without-reload branch)', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'seed-cursor',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({ changes: [], newCursor: 'seed-cursor', hasMore: false });
    let pushCalls = 0;
    fake.pushImpl = async (args) => {
      pushCalls += 1;
      return {
        applied: args.mutations.map((m) => ({
          status: 'applied' as const,
          mutationId: m.id,
          aggregateId: m.aggregateId,
          newVersion: m.expectedVersion + 1,
          newUpdatedAt: new Date().toISOString(),
        })),
        rejected: [],
        syncCursor: '0',
      };
    };

    renderFenceProvider();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );

    let caught: unknown = null;
    await act(async () => {
      await seedMutation({ id: 'throw-mut', aggregateId: 'throw-agg' });
      try {
        await runDestructiveFn!(async () => {
          throw new Error('demo load failed');
        });
      } catch (err) {
        caught = err;
      }
    });
    expect(caught).toBeInstanceOf(Error);

    await act(async () => {
      notifyPendingFn!();
      await Promise.resolve();
    });
    await waitFor(() => expect(pushCalls).toBeGreaterThanOrEqual(1));
  });

  it('syncRoundTrip returns { ok: false } without calling pullImpl when the destructive window is open', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'seed-cursor',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    let pullCalls = 0;
    fake.pullImpl = async () => {
      pullCalls += 1;
      return { changes: [], newCursor: 'seed-cursor', hasMore: false };
    };

    renderFenceProvider();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );
    pullCalls = 0;

    let releaseFn: () => void = () => {};
    const fnGate = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    let destructivePromise!: Promise<void>;
    await act(async () => {
      destructivePromise = runDestructiveFn!(async () => {
        await fnGate;
      });
      await Promise.resolve();
    });

    let result!: Awaited<ReturnType<NonNullable<typeof syncRoundTripFn>>>;
    await act(async () => {
      result = await syncRoundTripFn!();
    });
    expect(result).toEqual({
      ok: false,
      reason: 'A workspace operation is in progress. Try again once it finishes.',
    });
    expect(pullCalls).toBe(0);

    await act(async () => {
      releaseFn();
      await destructivePromise;
    });
  });

  it('pull early-returns without calling pullImpl when the destructive window is open', async () => {
    const POLL_IDLE_MS = 5 * 60 * 1000;

    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'seed-cursor',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    let pullCalls = 0;
    fake.pullImpl = async () => {
      pullCalls += 1;
      return { changes: [], newCursor: 'seed-cursor', hasMore: false };
    };

    // Fake timers go on before render so the mount-armed poll timer is drivable.
    vi.useFakeTimers();
    try {
      renderFenceProvider();
      // Assert via the pull counter, not waitFor, which polls on real timers and stalls under fake timers.
      await vi.advanceTimersByTimeAsync(50);
      expect(pullCalls).toBeGreaterThanOrEqual(1);
      pullCalls = 0;

      let releaseFn: () => void = () => {};
      const fnGate = new Promise<void>((resolve) => {
        releaseFn = resolve;
      });
      const destructivePromise = runDestructiveFn!(async () => {
        await fnGate;
      });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(POLL_IDLE_MS + 5_000);
      expect(pullCalls).toBe(0);

      releaseFn!();
      await destructivePromise;
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      // Unmount before restoring real timers so the provider clears its in-flight timer.
      cleanup();
      vi.useRealTimers();
    }
  });
});
