// SyncProvider workspace clear, snapshot restore and household-switch freshness-pin handling.
import 'fake-indexeddb/auto';
import { useState } from 'react';
import { render, screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listAggregates, putAggregate, readDeviceMetadata, listPendingMutations, writeDeviceMetadata } from '../db/store';
import * as storeModule from '../db/store';
import { SyncApiError } from './sync-client';
import { SyncProvider, useSync } from './SyncContext';
import { fake, Probe, renderProvider, seedMutation, renderSettled, useSyncTestHooks } from './sync-context.test-harness';

vi.mock('./mock-sync', async () => (await import('./sync-context.test-fake')).mockSyncModule);


// A 2xx full clear resets the persisted freshness pin and the cursor to '0'; a `purgeHistoryOnly` retry (which never sweeps)
// and a non-2xx both leave local sync state untouched.
describe('SyncProvider — clearWorkspace', () => {
  const seedMeta = {
    deviceId: 'dev-test',
    syncCursor: 'seed-cursor',
    lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
    displayName: 'This device',
    freshnessCounter: 7,
  } as const;

  useSyncTestHooks();

  beforeEach(async () => {
    fake.pullImpl = async () => ({ changes: [], newCursor: 'seed-cursor', hasMore: false });
    fake.clearWorkspaceImpl = async () => ({ ok: true, historyErased: true });
  });

  function ClearProbe() {
    const sync = useSync();
    const [result, setResult] = useState('');
    const run = async (args: {
      currentPassword: string;
      eraseHistory: boolean;
      purgeHistoryOnly?: boolean;
    }) => {
      try {
        setResult(JSON.stringify(await sync.clearWorkspace(args)));
      } catch (err) {
        setResult(`error:${err instanceof Error ? err.message : 'unknown'}`);
      }
    };
    return (
      <div>
        <div data-testid="state">{sync.state.kind}</div>
        <div data-testid="clear-result">{result}</div>
        <button onClick={() => void run({ currentPassword: 'pw', eraseHistory: false })}>
          clearFull
        </button>
        <button
          onClick={() =>
            void run({ currentPassword: 'pw', eraseHistory: true, purgeHistoryOnly: true })
          }
        >
          clearPurgeOnly
        </button>
        <button onClick={() => void sync.syncRoundTrip()}>syncRoundTrip</button>
        <button onClick={() => void sync.notifyPending()}>notifyPending</button>
      </div>
    );
  }

  const renderClearProvider = () => renderProvider({ probe: <ClearProbe /> });

  it('a full clear (2xx) resets the cursor to 0 and clears the persisted ZK freshness pin', async () => {
    await renderSettled(renderClearProvider);
    await writeDeviceMetadata({ ...seedMeta });
    await act(async () => {
      fireEvent.click(screen.getByText('clearFull'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('clear-result')).toHaveTextContent('"ok":true'),
    );
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('0');
    expect(meta?.freshnessCounter).toBeUndefined();
  });

  it('a purgeHistoryOnly retry (2xx) leaves the cursor + ZK pin untouched (no sweep)', async () => {
    await renderSettled(renderClearProvider);
    await writeDeviceMetadata({ ...seedMeta });
    await act(async () => {
      fireEvent.click(screen.getByText('clearPurgeOnly'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('clear-result')).toHaveTextContent('"ok":true'),
    );
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('seed-cursor');
    expect(meta?.freshnessCounter).toBe(7);
  });

  it('a non-2xx (transport throws) rejects and leaves local sync state untouched', async () => {
    fake.clearWorkspaceImpl = async () => {
      throw new SyncApiError('INVALID_CREDENTIALS', 'wrong password', 401);
    };
    await renderSettled(renderClearProvider);
    await writeDeviceMetadata({ ...seedMeta });
    await act(async () => {
      fireEvent.click(screen.getByText('clearFull'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('clear-result')).toHaveTextContent('error:'),
    );
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('seed-cursor');
    expect(meta?.freshnessCounter).toBe(7);
  });

  // A full clear must drop the local mutation queue inside the destructive fence: a surviving stale `create` would be pushed
  // onto the freshly swept server by the next poll, resurrecting the deleted data.
  it('a full clear (2xx) drops the local mutation queue inside the fence so a stale create cannot survive to re-push', async () => {
    await renderSettled(renderClearProvider);
    await writeDeviceMetadata({ ...seedMeta });
    await seedMutation({ id: 'stale-create', operation: 'create' });
    expect(await listPendingMutations()).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByText('clearFull'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('clear-result')).toHaveTextContent('"ok":true'),
    );

    expect(await listPendingMutations()).toEqual([]);
  });

  // A transient IDB blip in the post-commit cleanup is retried (the steps are idempotent) and converges without surfacing an error.
  it('a full clear (2xx) retries a transient post-commit cleanup failure and converges (queue cleared, cursor reset)', async () => {
    await renderSettled(renderClearProvider);
    await writeDeviceMetadata({ ...seedMeta });
    await seedMutation({ id: 'stale-create', operation: 'create' });
    expect(await listPendingMutations()).toHaveLength(1);

    const realClearMutationQueue = storeModule.clearMutationQueue;
    let clearCalls = 0;
    const clearSpy = vi
      .spyOn(storeModule, 'clearMutationQueue')
      .mockImplementation(async () => {
        clearCalls += 1;
        if (clearCalls === 1) throw new Error('IDB blocked (transient)');
        return realClearMutationQueue();
      });

    await act(async () => {
      fireEvent.click(screen.getByText('clearFull'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('clear-result')).toHaveTextContent('"ok":true'),
    );

    expect(clearSpy.mock.calls.length).toBeGreaterThan(1);
    expect(await listPendingMutations()).toEqual([]);
    expect((await readDeviceMetadata())?.syncCursor).toBe('0');
  });

  // If the post-commit cleanup fails on every attempt, clearWorkspace rejects with the typed `WorkspaceClearCleanupError` and
  // keeps the poll suspended so the stale `create` is never re-pushed.
  it('a full clear (2xx) whose post-commit cleanup fails on every attempt throws WorkspaceClearCleanupError and suspends the poll (no re-push)', async () => {
    await renderSettled(renderClearProvider);
    await writeDeviceMetadata({ ...seedMeta });
    await seedMutation({ id: 'stale-create', operation: 'create' });
    expect(await listPendingMutations()).toHaveLength(1);

    vi.spyOn(storeModule, 'clearMutationQueue').mockRejectedValue(
      new Error('IDB blocked (persistent)'),
    );
    const pushSpy = vi.spyOn(fake, 'push');

    await act(async () => {
      fireEvent.click(screen.getByText('clearFull'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('clear-result')).toHaveTextContent(
        /local sync-state cleanup could not be completed/i,
      ),
    );
    expect(screen.getByTestId('clear-result')).not.toHaveTextContent('IDB blocked');

    pushSpy.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(await listPendingMutations()).toHaveLength(1);
  });

  // An ambiguous clear failure (abort or network drop, no HTTP response) may still have swept the server; the next poll's
  // CURSOR_EXPIRED handler must then skip its flush-before-wipe, which would re-push the deleted `create`s.
  it('an ambiguous clearWorkspace failure makes the next CURSOR_EXPIRED poll re-bootstrap WITHOUT re-pushing the stale pre-delete queue', async () => {
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);
    await renderSettled(renderClearProvider);
    await seedMutation({ id: 'stale-create', operation: 'create' });
    expect(await listPendingMutations()).toHaveLength(1);

    fake.clearWorkspaceImpl = async () => {
      throw new TypeError('Failed to fetch');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('clearFull'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('clear-result')).toHaveTextContent('error:'),
    );
    expect(await listPendingMutations()).toHaveLength(1);

    fake.pullImpl = async () => {
      throw new SyncApiError('CURSOR_EXPIRED', 'Cursor expired', 409, 'trace-1');
    };
    let bootstrapCalls = 0;
    fake.bootstrapImpl = async () => {
      bootstrapCalls += 1;
      return {
        snapshotId: 'snap-empty',
        workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
        postSnapshotMutations: [],
        syncCursor: 'fresh-cursor',
        timestamp: new Date().toISOString(),
      };
    };
    const pushSpy = vi.spyOn(fake, 'push');

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    nowSpy.mockReturnValue(baseTime + 6_000);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 10));
    });

    await waitFor(() => expect(bootstrapCalls).toBeGreaterThan(0));
    await waitFor(async () => {
      expect((await readDeviceMetadata())?.syncCursor).toBe('fresh-cursor');
      expect(await listPendingMutations()).toEqual([]);
    });
    expect(pushSpy).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  // The ambiguity marker is transient: a normal pull proves the clear did not land and lifts it, so a later unrelated
  // CURSOR_EXPIRED flushes before the wipe again instead of discarding a fresh offline edit.
  it('a normal pull lifts the ambiguity marker so a later CURSOR_EXPIRED flushes-first again', async () => {
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);
    await renderSettled(renderClearProvider);

    fake.clearWorkspaceImpl = async () => {
      throw new TypeError('Failed to fetch');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('clearFull'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('clear-result')).toHaveTextContent('error:'),
    );

    fake.pullImpl = async () => ({
      changes: [],
      newCursor: 'seed-cursor',
      hasMore: false,
    });
    await act(async () => {
      fireEvent.click(screen.getByText('syncRoundTrip'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );

    await seedMutation({ id: 'offline-edit', operation: 'create' });
    const events: string[] = [];
    fake.pushImpl = async (args) => {
      events.push('push');
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
    fake.pullImpl = async () => {
      throw new SyncApiError('CURSOR_EXPIRED', 'Cursor expired', 409, 'trace-1');
    };
    fake.bootstrapImpl = async () => {
      events.push('bootstrap');
      return {
        snapshotId: 'snap-recovered',
        workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
        postSnapshotMutations: [],
        syncCursor: 'fresh-cursor',
        timestamp: new Date().toISOString(),
      };
    };

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    nowSpy.mockReturnValue(baseTime + 6_000);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 10));
    });

    await waitFor(() => expect(events).toContain('bootstrap'));
    expect(events.indexOf('push')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('push')).toBeLessThan(events.indexOf('bootstrap'));
    nowSpy.mockRestore();
  });
});


// Restore must clear the persisted `freshnessCounter` and the in-memory pin before the bootstrap: `applyBootstrap` only
// sets the counter for a non-null freshnessHead, so a stale-high value would resurrect on reload and trip a false rollback.
describe('SyncProvider — restore clears ZK freshness pin', () => {
  useSyncTestHooks();

  beforeEach(async () => {
    fake.bootstrapImpl = async () => ({
      snapshotId: 'restored-snap',
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: 'restored-cursor',
      timestamp: new Date().toISOString(),
    });
    fake.restoreImpl = async () => ({ ok: true });
  });

  function RestoreProbe() {
    const sync = useSync();
    const [result, setResult] = useState<string>('');
    return (
      <div>
        <div data-testid="state">{sync.state.kind}</div>
        <div data-testid="restore-result">{result}</div>
        <button
          onClick={async () => {
            try {
              const r = await sync.restoreSnapshot('restored-snap');
              setResult(JSON.stringify(r));
            } catch (err) {
              setResult(`error:${err instanceof Error ? err.message : 'unknown'}`);
            }
          }}
        >
          restoreSnapshot
        </button>
        <button onClick={() => void sync.notifyPending()}>notifyPending</button>
        <button onClick={() => void sync.syncRoundTrip()}>syncRoundTrip</button>
      </div>
    );
  }

  const renderRestoreProvider = () => renderProvider({ probe: <RestoreProbe /> });

  it('clears persisted freshnessCounter on restore so a reload re-hydrates a 0 pin and the next push does not roll back', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'old-cursor',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
      freshnessCounter: 5,
    });
    await renderSettled(renderRestoreProvider);

    await act(async () => {
      fireEvent.click(screen.getByText('restoreSnapshot'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('restore-result')).toHaveTextContent('{"ok":true'),
    );

    const meta = await readDeviceMetadata();
    expect(meta?.freshnessCounter).toBeUndefined();
    expect(meta?.syncCursor).toBe('restored-cursor');

    // A reload re-hydrates the pin from persisted metadata; the cleared pin must accept a mismatched counter.
    cleanup();
    fake.pullImpl = async () => ({
      changes: [],
      newCursor: 'restored-cursor',
      hasMore: false,
    });
    renderRestoreProvider();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );
    expect(screen.getByTestId('state')).not.toHaveTextContent('rollback-detected');
  });

  // A failed server restore must leave the persisted counter and in-memory pin unchanged, so rollback detection stays armed,
  // and must not run the bootstrap.
  it('leaves the persisted + in-memory freshness pin unchanged and does not bootstrap when the server restore fails', async () => {
    fake.restoreImpl = async () => {
      throw new Error('restore failed');
    };
    const bootstrapSpy = vi.fn(async () => ({
      snapshotId: 'restored-snap',
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: 'restored-cursor',
      timestamp: new Date().toISOString(),
    }));
    fake.bootstrapImpl = bootstrapSpy;

    await renderSettled(renderRestoreProvider);

    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'seed-cursor',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
      freshnessCounter: 7,
    });

    await act(async () => {
      fireEvent.click(screen.getByText('restoreSnapshot'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('restore-result')).toHaveTextContent(
        'error:restore failed',
      ),
    );

    const meta = await readDeviceMetadata();
    expect(meta?.freshnessCounter).toBe(7);
    expect(meta?.syncCursor).toBe('seed-cursor');
    expect(bootstrapSpy).not.toHaveBeenCalled();
  });

  // When the restore succeeds but the bootstrap fetch fails, restoreSnapshot has already reset the cursor to '0', cleared the
  // queue and wiped the aggregate stores, and reports `wiped:true` so the modal's reload branch engages.
  it('clears the queue, wipes the aggregate stores, resets syncCursor to 0, and reports wiped:true even when the post-restore bootstrap fails', async () => {
    await renderSettled(renderRestoreProvider);
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'old-cursor',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
      freshnessCounter: 9,
    });
    await seedMutation({ id: 'pre-restore-1', aggregateId: 'a-1' });
    await putAggregate('account', {
      id: 'stale-agg',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 3,
      updatedAt: new Date(Date.now() - 1000).toISOString(),
      deviceId: 'dev-test',
      payload: { name: 'Stale pre-restore account' },
    });
    expect(await listPendingMutations()).toHaveLength(1);
    expect(await listAggregates('account')).toHaveLength(1);

    fake.restoreImpl = async () => ({ ok: true });
    fake.bootstrapImpl = async () => {
      throw new Error('bootstrap fetch failed');
    };

    await act(async () => {
      fireEvent.click(screen.getByText('restoreSnapshot'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('restore-result')).toHaveTextContent(
        JSON.stringify({ ok: false, wiped: true }),
      ),
    );

    expect(await listPendingMutations()).toHaveLength(0);
    expect(await listAggregates('account')).toHaveLength(0);
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('0');
  });

  // restoreSnapshot must await any in-flight flush before calling transport.restore and block new flushes meanwhile: a push
  // committed after the sweep would recreate data the confirm dialog said was lost.
  it('awaits an in-flight push before telling the server to restore, and blocks new flushes during the restore', async () => {
    await renderSettled(renderRestoreProvider);

    const events: string[] = [];
    let releasePush: () => void = () => {};
    const pushGate = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    fake.pushImpl = async (args) => {
      events.push('push:start');
      await pushGate;
      events.push('push:resolve');
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
    fake.restoreImpl = async () => {
      events.push('restore:server');
      return { ok: true };
    };

    await seedMutation({ id: 'mut-inflight' });
    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
    });
    await waitFor(() => expect(events).toContain('push:start'));

    await act(async () => {
      fireEvent.click(screen.getByText('restoreSnapshot'));
    });
    expect(events).not.toContain('restore:server');

    await act(async () => {
      releasePush();
    });
    await waitFor(() =>
      expect(screen.getByTestId('restore-result')).toHaveTextContent('{"ok":true'),
    );

    expect(events.indexOf('push:resolve')).toBeLessThan(
      events.indexOf('restore:server'),
    );
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('restored-cursor');
  });

  // A poll pull during a restore must be suppressed (`restoreInProgressRef`), or its read-modify-write on DeviceMetadata could
  // overwrite the reset cursor and pin with stale metadata.
  it('suppresses a concurrent pull while a restore is in progress (no stale metadata write)', async () => {
    await renderSettled(renderRestoreProvider);

    let releaseRestore: () => void = () => {};
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let pullDuringRestore = 0;
    fake.restoreImpl = async () => {
      await restoreGate;
      return { ok: true };
    };
    fake.pullImpl = async () => {
      pullDuringRestore += 1;
      return { changes: [], newCursor: 'stale-pull-cursor', hasMore: false };
    };

    await act(async () => {
      fireEvent.click(screen.getByText('restoreSnapshot'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('syncRoundTrip'));
      await Promise.resolve();
    });

    await act(async () => {
      releaseRestore();
    });
    await waitFor(() =>
      expect(screen.getByTestId('restore-result')).toHaveTextContent('{"ok":true'),
    );

    expect(pullDuringRestore).toBe(0);
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('restored-cursor');
  });
});


// SyncProvider is not remounted when the household changes, so a stale-high freshness pin would carry into the new household
// and trip a false rollback-detected; the switch resets it and initialSync hydrates it with `?? 0`.
describe('SyncProvider — freshness pin reset on household switch', () => {
  useSyncTestHooks();

  function SwitchableProvider({ initial }: { initial: string }) {
    const [hh, setHh] = useState(initial);
    return (
      <SyncProvider
        householdId={hh}
        deviceId="dev-test"
        apiBaseUrl=""
        getAccessToken={() => 'tok'}
        getCsrfToken={() => 'csrf'}
        mock
      >
        <Probe />
        <button onClick={() => setHh('hh-B')}>switch</button>
      </SyncProvider>
    );
  }

  it('starts the new household TOFU (synced, not rollback-detected) after a switch from a pinned household', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-A',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({
      changes: [],
      newCursor: 'cursor-A',
      hasMore: false,
      freshnessHead: { freshnessCounter: 5, cursorTag: 'tag-5' },
    });
    render(<SwitchableProvider initial="hh-1" />);
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );
    expect((await readDeviceMetadata())?.freshnessCounter).toBe(5);

    // Household B's metadata has no counter and its bootstrap echoes no head (TOFU); a leaked pin of 5 would reject it.
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: '0',
      lastSyncedAt: null,
      displayName: 'This device',
    });
    fake.bootstrapImpl = async () => ({
      snapshotId: null,
      workspaceSnapshot: { householdId: 'hh-B', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: 'cursor-B',
      timestamp: new Date().toISOString(),
    });
    await act(async () => {
      fireEvent.click(screen.getByText('switch'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );
    expect(screen.getByTestId('state')).not.toHaveTextContent('rollback-detected');
    const metaB = await readDeviceMetadata();
    expect(metaB?.syncCursor).toBe('cursor-B');
    expect(metaB?.freshnessCounter).toBeUndefined();
  });

  it('hydrates the pin to 0 (not the prior value) when the new household metadata has no counter', async () => {
    // A household whose metadata lacks a counter hydrates to 0 (TOFU), so a no-head pull resolves to synced.
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-A',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
      freshnessCounter: 9,
    });
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: '0',
      lastSyncedAt: null,
      displayName: 'This device',
    });
    fake.bootstrapImpl = async () => ({
      snapshotId: null,
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: 'cursor-1',
      timestamp: new Date().toISOString(),
    });
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );
    expect(screen.getByTestId('state')).not.toHaveTextContent('rollback-detected');
    expect((await readDeviceMetadata())?.freshnessCounter).toBeUndefined();
  });
});
