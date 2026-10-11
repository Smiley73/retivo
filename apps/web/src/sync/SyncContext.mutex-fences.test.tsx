/**
 * SyncProvider sync mutex, batched store signals and the destructive-operation fence.
 *
 * Split out of the former single SyncContext.test.tsx; shared setup lives in
 * `sync-context.test-harness.tsx`.
 */
import 'fake-indexeddb/auto';
import { screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getStoreVersion, listAggregates, readDeviceMetadata, listPendingMutations, subscribeToStoreChanges, writeDeviceMetadata } from '../db/store';
import * as storeModule from '../db/store';
import { useSync } from './SyncContext';
import { fake, renderProvider, seedMutation, useSyncTestHooks } from './sync-context.test-harness';

vi.mock('./mock-sync', async () => (await import('./sync-context.test-fake')).mockSyncModule);


// Sync mutex + transactional DeviceMetadata writes. A single
// promise-chain mutex serializes the top-level sync entry points so
// pull / bootstrap / flush / restore can never interleave their
// `deviceMetadata` read-modify-writes, and every metadata write is a
// field-level functional update inside one IDB transaction. Together these
// close the lost-update class (a concurrent flush reverting a pull's
// syncCursor, or a pull dropping a flush's just-persisted freshnessCounter).
describe('SyncProvider — sync mutex + transactional metadata writes', () => {
  useSyncTestHooks('hh-1');

  it('flush queued behind an in-flight pull runs after it; pull cursor is preserved (no revert)', async () => {
    // Drive pull + flush through a single probe that exposes syncRoundTrip
    // (pull) and notifyPending (flush). Hold the pull open, fire the flush,
    // assert the push starts only after the pull resolves and the persisted
    // cursor is the pull's newCursor.
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
    // Settle the mount-time sync first (seed cursor → pull branch).
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

    // Start the round-trip with an EMPTY queue so its flush leg pushes
    // nothing; the queued mutation is added DURING the gated pull, so the
    // separate notify-flush genuinely has work that must wait for the mutex.
    const events: string[] = [];
    let releasePull: () => void = () => {};
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    let seededDuringPull = false;
    fake.pullImpl = async () => {
      events.push('pull:start');
      // Queue a mutation while the pull holds the mutex. A concurrent flush
      // (fired below via notify) must NOT push it until the pull releases.
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

    // Start a round-trip: empty queue → no push, then it pulls (gated open,
    // holding the mutex). Fire the flush (notify) once the pull has started.
    await act(async () => {
      fireEvent.click(screen.getByText('roundtrip'));
    });
    await waitFor(() => expect(events).toContain('pull:start'));
    await act(async () => {
      fireEvent.click(screen.getByText('notify'));
      await Promise.resolve();
    });
    // The notify-driven flush must NOT have pushed yet — it is queued behind
    // the still-open pull on the mutex even though a mutation is now pending.
    expect(events).not.toContain('push:start');

    // Release the pull. It resolves, writes its cursor, releases the mutex,
    // and only then does the queued flush run and push.
    await act(async () => {
      releasePull();
    });
    await waitFor(() => expect(events).toContain('push:start'));

    // Ordering proof: the pull resolved before the flush pushed.
    expect(events.indexOf('pull:resolve')).toBeLessThan(
      events.indexOf('push:start'),
    );
    // The persisted cursor is the pull's newCursor — never reverted by the
    // concurrent flush's metadata write.
    await waitFor(async () => {
      expect((await readDeviceMetadata())?.syncCursor).toBe('fresh-pull-cursor');
    });
  });

  it('a freshness-pin persist concurrent with a pull metadata write loses neither field (transactional RMW)', async () => {
    // Simulate the lost-update race directly at the store layer: a pull-style
    // write that sets syncCursor and a flush-style write that sets
    // freshnessCounter run concurrently through updateDeviceMetadata. Because
    // each is a functional update inside ONE IDB transaction touching only
    // its own field, both values must survive — the old read→spread→write
    // pair would drop whichever wrote first.
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
    // Both fields landed — neither write clobbered the other's field.
    expect(meta?.syncCursor).toBe('cursor-from-pull');
    expect(meta?.freshnessCounter).toBe(7);
  });

  it('a notifyPending burst during an in-flight flush still coalesces into one push (mutex does not multiply pushes)', async () => {
    // The mutex must not turn a burst of notifyPending calls into N
    // sequential lock acquisitions each running a full push. The
    // flushScheduled/flushInFlight guards collapse the burst into one flush
    // (plus at most one rerun for work that genuinely arrived mid-flight).
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


// Batched fine-signal consolidation — the bootstrap and pull bulk-fill
// loops thread the `withBatchedStoreSignals` batch into every
// `applyPulledChange` / `putAggregate`, so N rows of ONE type collapse to
// exactly ONE fine `notifyStoreChanged` per touched store on scope exit, not
// one per row. SyncContext keeps its coarse `notifyWorkspaceChanged()` tail, so
// a dropped batch wouldn't strand readers — but the fine count (one per store,
// not one per row) would silently regress. These tests pin the fine count for
// both bulk paths so a `batch?`-omission can't pass unnoticed.
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
    // Cursor '0' (clean DB after dropLocalDatabase) → mount initialSync takes
    // the bootstrap branch with clearFirst=false, so NO clearAllStores fires
    // on the accounts store during our subscription window — the only fine
    // accounts signal is the batched flush on scope exit.
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
      // All N rows landed in one store…
      expect((await listAggregates('account')).length).toBe(N);
      // …but the fine accounts signal fired exactly ONCE — the batched flush,
      // not once per row. A `batch?`-omission would make this N.
      expect(accountsListener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('pull of N accounts wakes the fine accounts listener exactly once across the page (one per touched store, not per row)', async () => {
    const N = 5;
    // Seed a non-zero cursor so mount initialSync takes the incremental pull
    // branch (no wipe), and pre-bump the store version so the seed write below
    // doesn't count — we subscribe AFTER seeding.
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
      // One batched flush for the whole pulled page, not N per-row signals.
      expect(accountsListener).toHaveBeenCalledTimes(1);
      // The store version advanced by exactly one across all N rows.
      expect(getStoreVersion('accounts')).toBe(before + 1);
    } finally {
      unsubscribe();
    }
  });
});


// Destructive-op fence. A demo-overwrite (wipe→load over existing data)
// runs inside `runDestructive`, which sets `destructiveOpInProgressRef` BEFORE
// acquiring the mutex and clears it in a `finally`. While set, a background
// poll's flush/pull early-returns so it can't push half-queued wipe/load
// mutations during the window. The success path reloads the page (discarding
// the ref); a throw-without-reload must still release the fence so the
// surviving poll resumes.
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

    // Open the destructive window: hold `fn` on a gate so the fence stays set.
    let releaseFn: () => void = () => {};
    const fnGate = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    let destructivePromise!: Promise<void>;
    await act(async () => {
      destructivePromise = runDestructiveFn!(async () => {
        // Queue a mutation INSIDE the window (the wipe's delete mutations
        // stand in for this) so a concurrent flush would have work to push.
        await seedMutation({ id: 'fenced-mut', aggregateId: 'fenced-agg' });
        await fnGate;
      });
      await Promise.resolve();
    });

    // A poll-style flush fired while the window is open must early-return
    // (fenced) — it must NOT push the queued mutation.
    await act(async () => {
      notifyPendingFn!();
      await Promise.resolve();
    });
    expect(pushCalls).toBe(0);

    // Release the window. The fence clears in the `finally`, so a subsequent
    // flush is free to push the queued mutation.
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

    // The destructive fn throws (e.g. loadDemoData failed before the reload).
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

    // The fence was released in the `finally` (no reload on this branch), so a
    // poll flush can now push — proving the poll is not wedged.
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
    // The mount-time initialSync pulls once; reset so we only count pulls
    // raised after the window opens.
    pullCalls = 0;

    // Open the destructive window: hold `fn` on a gate so the fence stays set.
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

    // A round-trip raised while the window is open must bail at the fence
    // (before touching the mutex) and surface the neutral reason — it must
    // NOT pull.
    let result!: Awaited<ReturnType<NonNullable<typeof syncRoundTripFn>>>;
    await act(async () => {
      result = await syncRoundTripFn!();
    });
    expect(result).toEqual({
      ok: false,
      reason: 'A workspace operation is in progress. Try again once it finishes.',
    });
    expect(pullCalls).toBe(0);

    // Release the window so the destructive promise settles (cleanup).
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

    // Fake timers BEFORE render so the mount-armed poll timer is a fake timer
    // we can drive. `advanceTimersByTimeAsync` flushes the intervening
    // microtasks (fake-indexeddb promises + the async pull/flush chain).
    vi.useFakeTimers();
    try {
      renderFenceProvider();
      // Settle the mount-time initialSync (pull ok → synced). Assert via the
      // pull counter (not waitFor, which polls on real timers and stalls under
      // fake timers).
      await vi.advanceTimersByTimeAsync(50);
      expect(pullCalls).toBeGreaterThanOrEqual(1);
      // Only count pulls raised after the destructive window opens.
      pullCalls = 0;

      // Open the destructive window: hold `fn` on a gate so the fence stays set
      // (and the mutex is held) for the duration of the poll-tick advance.
      let releaseFn: () => void = () => {};
      const fnGate = new Promise<void>((resolve) => {
        releaseFn = resolve;
      });
      const destructivePromise = runDestructiveFn!(async () => {
        await fnGate;
      });
      // Let the destructive call arm the fence + acquire the mutex.
      await vi.advanceTimersByTimeAsync(0);

      // Advance past the mount-armed idle poll (5 min). The poll tick must not
      // pull while the window is open — the fence early-returns.
      await vi.advanceTimersByTimeAsync(POLL_IDLE_MS + 5_000);
      expect(pullCalls).toBe(0);

      // Release the window so the destructive promise settles (cleanup).
      releaseFn!();
      await destructivePromise;
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      // Unmount BEFORE restoring real timers so any in-flight provider timer is
      // cleared by the effect cleanup, then drop the DB cleanly.
      cleanup();
      vi.useRealTimers();
    }
  });
});
