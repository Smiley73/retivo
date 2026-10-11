/**
 * SyncProvider workspace clear, snapshot restore and household-switch freshness-pin handling.
 *
 * Split out of the former single SyncContext.test.tsx; shared setup lives in
 * `sync-context.test-harness.tsx`.
 */
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


// Delete workspace data — the SyncContext `clearWorkspace` contract. A 2xx
// FULL clear must clear the persisted ZK freshness pin AND reset the cursor to
// '0' (so the post-reload bootstrap force-loads the empty snapshot),
// while a `purgeHistoryOnly` RETRY (which never sweeps) must leave BOTH
// untouched so resumed post-reload work is never discarded. A non-2xx
// (transport throws) must leave local sync state untouched.
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
    // Persist a stale ZK pin + cursor post-settle to prove the clear wipes them.
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

  // Regression: a full clear (2xx) must drop the local mutation queue
  // INSIDE `clearWorkspace`'s destructive fence — not leave it for the card to
  // clear after the fence releases. A stale local `create` that survived the
  // clear would be pushed by the next background poll onto the freshly-swept
  // (empty) server, resurrecting the just-deleted data. Mirrors how
  // `restoreSnapshot` clears the queue inside its own fenced critical section.
  it('a full clear (2xx) drops the local mutation queue inside the fence so a stale create cannot survive to re-push', async () => {
    await renderSettled(renderClearProvider);
    await writeDeviceMetadata({ ...seedMeta });
    // Queue a local `create` — the exact kind a post-clear flushPending would
    // re-push onto the empty server if it outlived the clear.
    await seedMutation({ id: 'stale-create', operation: 'create' });
    expect(await listPendingMutations()).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByText('clearFull'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('clear-result')).toHaveTextContent('"ok":true'),
    );

    // The queue was cleared atomically within the clear (under the fence), so
    // nothing remains for a post-clear poll to push back to the server.
    expect(await listPendingMutations()).toEqual([]);
  });

  // Regression (self-heal): a 2xx clearWorkspace whose POST-COMMIT local
  // cleanup hits a TRANSIENT IDB blip must retry (the cleanup steps are
  // idempotent) and converge — resolving `{ ok: true }` with the queue actually
  // cleared, never surfacing a spurious error to the card.
  it('a full clear (2xx) retries a transient post-commit cleanup failure and converges (queue cleared, cursor reset)', async () => {
    await renderSettled(renderClearProvider);
    await writeDeviceMetadata({ ...seedMeta });
    await seedMutation({ id: 'stale-create', operation: 'create' });
    expect(await listPendingMutations()).toHaveLength(1);

    // Fail the mutation-queue drop ONCE, then delegate to the real store fn so
    // the retry genuinely empties the fake-indexeddb queue.
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

    // The cleanup was retried (>1 call) and the second attempt really cleared
    // the queue; the cursor reset landed too — no spurious error reached the card.
    expect(clearSpy.mock.calls.length).toBeGreaterThan(1);
    expect(await listPendingMutations()).toEqual([]);
    expect((await readDeviceMetadata())?.syncCursor).toBe('0');
  });

  // Regression (terminal): when the POST-COMMIT cleanup fails on EVERY
  // attempt after a 2xx server clear, clearWorkspace must reject with the TYPED
  // `WorkspaceClearCleanupError` (distinct from a pre-commit `SyncApiError`) and
  // keep the poll suspended, so the still-queued stale `create` can NEVER be
  // re-pushed onto the freshly-swept server by a background flush.
  it('a full clear (2xx) whose post-commit cleanup fails on every attempt throws WorkspaceClearCleanupError and suspends the poll (no re-push)', async () => {
    await renderSettled(renderClearProvider);
    await writeDeviceMetadata({ ...seedMeta });
    // The exact kind of mutation a post-clear flush would resurrect on the
    // empty server if the poll were allowed to run.
    await seedMutation({ id: 'stale-create', operation: 'create' });
    expect(await listPendingMutations()).toHaveLength(1);

    // Every mutation-queue drop attempt fails → terminal cleanup failure.
    vi.spyOn(storeModule, 'clearMutationQueue').mockRejectedValue(
      new Error('IDB blocked (persistent)'),
    );
    // Watch the transport push path — it must never fire while the poll is
    // suspended.
    const pushSpy = vi.spyOn(fake, 'push');

    await act(async () => {
      fireEvent.click(screen.getByText('clearFull'));
    });
    // The card sees the TYPED post-commit error, not a bare rethrow of the IDB
    // error and not a pre-commit rejection.
    await waitFor(() =>
      expect(screen.getByTestId('clear-result')).toHaveTextContent(
        /local sync-state cleanup could not be completed/i,
      ),
    );
    expect(screen.getByTestId('clear-result')).not.toHaveTextContent('IDB blocked');

    // The poll is suspended: a notifyPending-driven flush must NOT push the
    // still-queued stale create back to the server.
    pushSpy.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
    });
    // Give any (suppressed) flush a chance to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(pushSpy).not.toHaveBeenCalled();
    // The stale create is still queued (never re-pushed / removed).
    expect(await listPendingMutations()).toHaveLength(1);
  });

  // Regression (ambiguous-clear resurrection guard): if the clearWorkspace
  // transport call fails AMBIGUOUSLY — an abort/timeout/network drop where no
  // HTTP response arrived, NOT a definite `SyncApiError` non-2xx — the client
  // cannot tell whether the server actually swept before the connection dropped.
  // If it DID sweep, the next poll gets CURSOR_EXPIRED (the committed clear
  // bumped the watermark past this cursor). That handler normally flushes the
  // pending queue BEFORE the re-bootstrap wipe — which would re-push the
  // just-deleted `create`s onto the freshly-swept server, resurrecting the data.
  // The fix marks the outcome ambiguous so the CURSOR_EXPIRED handler skips the
  // pre-bootstrap flush and re-bootstraps straight from the server's true state.
  it('an ambiguous clearWorkspace failure makes the next CURSOR_EXPIRED poll re-bootstrap WITHOUT re-pushing the stale pre-delete queue', async () => {
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);
    await renderSettled(renderClearProvider);
    // A stale local `create` — the exact row a resurrecting flush would re-push
    // onto the freshly-swept server.
    await seedMutation({ id: 'stale-create', operation: 'create' });
    expect(await listPendingMutations()).toHaveLength(1);

    // The clear request fails AMBIGUOUSLY (network/abort — a TypeError, not a
    // SyncApiError). No response arrived, so the client can't know the server
    // didn't sweep; the CURSOR_EXPIRED below simulates that it actually DID.
    fake.clearWorkspaceImpl = async () => {
      throw new TypeError('Failed to fetch');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('clearFull'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('clear-result')).toHaveTextContent('error:'),
    );
    // Pre-commit fail-safe preserved the queue (nothing was wiped locally).
    expect(await listPendingMutations()).toHaveLength(1);

    // Next background poll: the committed clear expired this device's cursor.
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

    // Fire the background poll's pull→flush pair via the visibility rewake
    // (past the 5 s debounce), mirroring the poll-rewake test.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    nowSpy.mockReturnValue(baseTime + 6_000);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 10));
    });

    // The CURSOR_EXPIRED recovery re-bootstrapped from the server's true (empty)
    // state...
    await waitFor(() => expect(bootstrapCalls).toBeGreaterThan(0));
    // ...WITHOUT first flushing the stale pre-delete queue onto the swept server
    // (the resurrection the fix prevents). The old queue is discarded with the
    // empty reseed instead. The reseed is applied after the bootstrap reply, so
    // wait on the persisted state rather than on the fake having been called.
    await waitFor(async () => {
      expect((await readDeviceMetadata())?.syncCursor).toBe('fresh-cursor');
      expect(await listPendingMutations()).toEqual([]);
    });
    expect(pushSpy).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  // Marker is transient: the ambiguity marker must not permanently
  // disable the flush-before-wipe behaviour. A normal pull (no CURSOR_EXPIRED) proves any ambiguously-failed
  // clear did NOT land, so it lifts the marker — restoring the flush-BEFORE-wipe
  // behaviour for a later, unrelated cursor expiry (this device's own compacted
  // pushes). Without the lift, a subsequent CURSOR_EXPIRED would silently
  // discard a fresh offline edit.
  it('a normal pull lifts the ambiguity marker so a later CURSOR_EXPIRED flushes-first again', async () => {
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);
    await renderSettled(renderClearProvider);

    // Arm the ambiguity marker via an abort/network-style clear failure.
    fake.clearWorkspaceImpl = async () => {
      throw new TypeError('Failed to fetch');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('clearFull'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('clear-result')).toHaveTextContent('error:'),
    );

    // Phase A: a NORMAL round-trip whose pull succeeds without CURSOR_EXPIRED
    // means the clear did NOT land — this lifts the marker.
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

    // Phase B: a fresh offline edit, then a later poll hits CURSOR_EXPIRED for an
    // UNRELATED reason. With the marker lifted, flush-first must run again —
    // the edit is pushed BEFORE the bootstrap wipe, not silently discarded.
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
    // Flush-first restored: the offline edit was flushed BEFORE the bootstrap wipe.
    expect(events.indexOf('push')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('push')).toBeLessThan(events.indexOf('bootstrap'));
    nowSpy.mockRestore();
  });
});


// Restore clears the zero-knowledge freshness pin. A ZK-active
// household restore MUST clear BOTH the persisted DeviceMetadata
// `freshnessCounter` AND the in-memory pin BEFORE the bootstrap, so a
// page reload after restore re-hydrates a cleared (0) pin and the next
// push does not trip a false rollback-detected. `applyBootstrap` only
// SETS the counter when the response carries a non-null freshnessHead;
// a fresh post-restore WorkspaceMeta has none, so without the explicit
// clear the stale-high persisted value would survive and resurrect on
// reload (initialSync re-hydration).
describe('SyncProvider — restore clears ZK freshness pin', () => {
  useSyncTestHooks();

  beforeEach(async () => {
    fake.bootstrapImpl = async () => ({
      snapshotId: 'restored-snap',
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: 'restored-cursor',
      // No freshnessHead — a fresh post-restore WorkspaceMeta has none.
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
    // ZK-active household: a stale-high freshness counter is persisted.
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

    // The persisted ZK pin is cleared so a reload cannot resurrect it.
    const meta = await readDeviceMetadata();
    expect(meta?.freshnessCounter).toBeUndefined();
    // The server was asked to restore + the client bootstrapped onto the
    // restored cursor.
    expect(meta?.syncCursor).toBe('restored-cursor');

    // Simulate a page reload: unmount, then a fresh mount re-hydrates the
    // in-memory pin from persisted DeviceMetadata (cleared → 0). A
    // stale-high pin would have made the HTTP client reject the next sync
    // with FreshnessRollbackError; here the cleared pin accepts a missing
    // head (TOFU) and the badge lands on synced, never rollback-detected.
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

  // Regression: a FAILED server restore (transport.restore rejects)
  // must leave BOTH the persisted DeviceMetadata freshnessCounter AND the
  // in-memory pin UNCHANGED — nothing was restored, so rollback detection
  // must stay armed — and must NOT run the bootstrap (no wipe / reseed).
  it('leaves the persisted + in-memory freshness pin unchanged and does not bootstrap when the server restore fails', async () => {
    // Server restore rejects (e.g. 404 / network / 5xx).
    fake.restoreImpl = async () => {
      throw new Error('restore failed');
    };
    // Spy the bootstrap so we can assert it is never called.
    const bootstrapSpy = vi.fn(async () => ({
      snapshotId: 'restored-snap',
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: 'restored-cursor',
      timestamp: new Date().toISOString(),
    }));
    fake.bootstrapImpl = bootstrapSpy;

    await renderSettled(renderRestoreProvider);

    // ZK-active household: persist a freshness counter AFTER the mount-time
    // initialSync settled (renderSettled writes its own metadata without a
    // counter), preserving the seed-cursor so this is the pre-restore state.
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
    // restoreSnapshot rejects (transport error propagates); the probe
    // records the error so the handler's microtasks have settled.
    await waitFor(() =>
      expect(screen.getByTestId('restore-result')).toHaveTextContent(
        'error:restore failed',
      ),
    );

    // The persisted ZK pin is UNCHANGED (not cleared) and the cursor is
    // untouched — nothing was restored.
    const meta = await readDeviceMetadata();
    expect(meta?.freshnessCounter).toBe(7);
    expect(meta?.syncCursor).toBe('seed-cursor');
    // Bootstrap was never invoked — no local wipe / reseed on failure.
    expect(bootstrapSpy).not.toHaveBeenCalled();
  });

  // Regression: when the server restore SUCCEEDS but the
  // subsequent bootstrap fetch fails, the device must not be left able to
  // re-push OR display stale state on the next poll. restoreSnapshot
  // proactively resets the cursor to '0', clears the mutation queue, AND
  // eagerly wipes the local aggregate stores the instant restore()
  // resolves (BEFORE the bootstrap), so the next initialSync/poll
  // force-bootstraps into an empty store instead of incremental-pulling /
  // flushing / displaying stale state. The returned result must report
  // `wiped:true` even though applyBootstrap's own fetch failed before its
  // internal wipe — so the modal's "Reload the page to continue" branch
  // engages and the reload deterministically re-bootstraps.
  it('clears the queue, wipes the aggregate stores, resets syncCursor to 0, and reports wiped:true even when the post-restore bootstrap fails', async () => {
    // ZK-active household with a pre-existing cursor + pending edits + a
    // local aggregate — the exact pre-restore state that, if left intact,
    // would re-push on the next poll (queue) or be shown behind a 'synced'
    // badge (the stale aggregate a since='0' pull can't expire).
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

    // Server restore succeeds; the follow-on bootstrap fetch then fails.
    fake.restoreImpl = async () => ({ ok: true });
    fake.bootstrapImpl = async () => {
      throw new Error('bootstrap fetch failed');
    };

    await act(async () => {
      fireEvent.click(screen.getByText('restoreSnapshot'));
    });
    // The reseed failed, but because we eagerly wiped locally the result
    // reports wiped:true so the modal's reload-recovery branch engages.
    await waitFor(() =>
      expect(screen.getByTestId('restore-result')).toHaveTextContent(
        JSON.stringify({ ok: false, wiped: true }),
      ),
    );

    // No stale state survives: the queue was cleared, the local aggregate
    // stores were wiped, and the cursor was reset to '0' BEFORE the
    // failing bootstrap, so the next initialSync takes the force-bootstrap
    // branch into an empty store instead of pulling/flushing/displaying
    // stale data.
    expect(await listPendingMutations()).toHaveLength(0);
    expect(await listAggregates('account')).toHaveLength(0);
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('0');
  });

  // Regression: an in-flight flush must not race the restore. A
  // push committed server-side AFTER the sweep would recreate data the
  // confirm dialog said was permanently lost, and the local queue clear
  // can't recall a request already on the wire. restoreSnapshot must
  // therefore await any in-flight flush BEFORE calling transport.restore,
  // and block new flushes for the duration of the restore.
  it('awaits an in-flight push before telling the server to restore, and blocks new flushes during the restore', async () => {
    await renderSettled(renderRestoreProvider);

    // A push whose promise resolves only when we release it — simulating
    // a request already on the wire when the user triggers a restore.
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

    // Queue a mutation and start the flush so a push is in flight.
    await seedMutation({ id: 'mut-inflight' });
    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
    });
    await waitFor(() => expect(events).toContain('push:start'));

    // Trigger the restore while the push is still pending. It must NOT
    // reach the server restore until the in-flight push resolves.
    await act(async () => {
      fireEvent.click(screen.getByText('restoreSnapshot'));
    });
    // The server restore has not fired yet — it is fenced behind the push.
    expect(events).not.toContain('restore:server');

    // Release the push. Now the restore proceeds.
    await act(async () => {
      releasePush();
    });
    await waitFor(() =>
      expect(screen.getByTestId('restore-result')).toHaveTextContent('{"ok":true'),
    );

    // Ordering proof: the in-flight push fully resolved BEFORE the server
    // restore ran — no push was mid-send when the sweep fired.
    expect(events.indexOf('push:resolve')).toBeLessThan(
      events.indexOf('restore:server'),
    );
    // And the post-restore state stands (cursor reset, restored snapshot)
    // — no stale push reintroduced data.
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('restored-cursor');
  });

  // Regression: a poll pull triggered while a restore is in
  // flight must be suppressed. restoreSnapshot writes syncCursor:'0' and
  // clears the freshness pin; an un-fenced pull's read-modify-write on
  // DeviceMetadata could overwrite that with stale metadata. pull()
  // early-returns when restoreInProgressRef is set (mirroring flushPending).
  it('suppresses a concurrent pull while a restore is in progress (no stale metadata write)', async () => {
    await renderSettled(renderRestoreProvider);

    // Gate the server restore so it stays in flight while we trigger a
    // concurrent pull. The pull must not write metadata during that window.
    let releaseRestore: () => void = () => {};
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let pullDuringRestore = 0;
    fake.restoreImpl = async () => {
      // The instant the server restore begins, fire a pull; it must be
      // fenced out by restoreInProgressRef.
      await restoreGate;
      return { ok: true };
    };
    fake.pullImpl = async () => {
      pullDuringRestore += 1;
      return { changes: [], newCursor: 'stale-pull-cursor', hasMore: false };
    };

    // Start the restore (now blocked on the gate, fence is set).
    await act(async () => {
      fireEvent.click(screen.getByText('restoreSnapshot'));
    });
    // Trigger a pull (via syncRoundTrip) while the restore is fenced. The
    // pull must be a no-op: it early-returns on restoreInProgressRef, so
    // the transport's pull is never called and no stale cursor is written.
    await act(async () => {
      fireEvent.click(screen.getByText('syncRoundTrip'));
      await Promise.resolve();
    });

    // Let the restore finish.
    await act(async () => {
      releaseRestore();
    });
    await waitFor(() =>
      expect(screen.getByTestId('restore-result')).toHaveTextContent('{"ok":true'),
    );

    // No pull ran during the restore window (the fence held), so the
    // stale-pull cursor never overwrote the post-restore cursor.
    expect(pullDuringRestore).toBe(0);
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('restored-cursor');
  });
});


// Freshness pin reset on household switch. The
// SyncProvider never remounts across logout→login / shared-device user
// switch (AuthAwareProviders passes a changing householdId prop, no
// `key`), so all refs — including pinnedFreshnessCounterRef — persist. A
// stale-high pin carried into a different household (whose IDB was wiped
// of any counter) must NOT survive: the household-switch effect resets
// the pin to 0, and initialSync hydrates it unconditionally (`?? 0`) so
// the new household starts TOFU. Without the reset, the carried pin would
// trip a false rollback-detected on the next sync once the freshness
// check is live.
describe('SyncProvider — freshness pin reset on household switch', () => {
  useSyncTestHooks();

  // A wrapper whose householdId is swappable at runtime, mirroring
  // AuthAwareProviders re-rendering SyncProvider with a new prop (no key →
  // no remount → refs persist).
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
    // Household A pins a high freshness counter via a pull echo + persists
    // it. The HTTP client would reject a counter below the pin.
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
    // Household A's high counter is now pinned + persisted.
    expect((await readDeviceMetadata())?.freshnessCounter).toBe(5);

    // Cross-user IDB wipe on switch: household B's metadata carries NO
    // counter (and cursor '0', so initialSync force-bootstraps). Its
    // bootstrap echoes no head (fresh WorkspaceMeta) — a TOFU first
    // contact. A leaked stale pin (5) would reject this; the reset lets
    // B accept it and land on synced.
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
      // No freshnessHead — fresh household, TOFU.
    });
    await act(async () => {
      fireEvent.click(screen.getByText('switch'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );
    expect(screen.getByTestId('state')).not.toHaveTextContent('rollback-detected');
    // Household B bootstrapped onto its own cursor with no carried-over
    // freshness counter.
    const metaB = await readDeviceMetadata();
    expect(metaB?.syncCursor).toBe('cursor-B');
    expect(metaB?.freshnessCounter).toBeUndefined();
  });

  it('hydrates the pin to 0 (not the prior value) when the new household metadata has no counter', async () => {
    // Persist a stale-high counter, then mount: initialSync must hydrate
    // the in-memory pin from `meta?.freshnessCounter ?? 0`. A household
    // whose metadata lacks a counter hydrates to 0 (TOFU), proven by a
    // subsequent no-head pull resolving to synced rather than rollback.
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-A',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
      freshnessCounter: 9,
    });
    // Drop the counter to model a cross-user wipe before this login.
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
