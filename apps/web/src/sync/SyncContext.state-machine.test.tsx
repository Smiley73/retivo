/**
 * SyncProvider badge state machine: synced / pending / syncing / offline / error / stale transitions and initial sync.
 *
 * Split out of the former single SyncContext.test.tsx; shared setup lives in
 * `sync-context.test-harness.tsx`.
 */
import 'fake-indexeddb/auto';
import { render, screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAggregate, listAggregates, listFailedConflicts, putAggregate, queueMutation, readDeviceMetadata, listPendingMutations, readKeyCacheEntry, writeDeviceMetadata, writeKeyCacheEntry, KEY_CACHE_ID } from '../db/store';
import { type Aggregate } from '../db/types';
import { redactArgs } from '../lib/diagnostics/redact';
import { type PushResponseBody } from './types';
import { SyncApiError, type SyncTransport } from './sync-client';
import { WORKSPACE_CHANGED_EVENT } from '../lib/workspace-events';
import { clear as clearDiagnostics, getEntries } from '../lib/diagnostics/logger';
import { installDiagnostics, uninstallDiagnostics } from '../lib/diagnostics/install';
import { SyncProvider } from './SyncContext';
import { fake, Probe, renderProvider, seedMutation, renderSettled, useSyncTestHooks } from './sync-context.test-harness';

vi.mock('./mock-sync', async () => (await import('./sync-context.test-fake')).mockSyncModule);

describe('SyncProvider state machine', () => {
  useSyncTestHooks();

  it('starts in the synced state when there is nothing to push', async () => {
    renderProvider();
    // Mount kicks off `initialSync` (state: syncing-pull → synced) since
    // the device has no cursor yet. After that round-trip the badge
    // should land in the synced state with nothing pending.
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(screen.getByTestId('pending')).toHaveTextContent('0');
  });

  it('cycles pending -> syncing-push -> synced after notifyPending', async () => {
    await seedMutation();
    // Settle the mount-time pull first so its late state write can't
    // clobber the syncing-push/synced transitions the click drives.
    await renderSettled(renderProvider);
    // Block push so the test can observe `syncing-push` mid-flight.
    let resolvePush!: (value: PushResponseBody) => void;
    fake.pushImpl = (args) =>
      new Promise<PushResponseBody>((resolve) => {
        resolvePush = (value) => resolve(value);
        // Capture the args so the resolution mirrors the input.
        Promise.resolve().then(() => {
          resolvePush({
            applied: args.mutations.map((m) => ({
              status: 'applied' as const,
              mutationId: m.id,
              aggregateId: m.aggregateId,
              newVersion: m.expectedVersion + 1,
              newUpdatedAt: new Date().toISOString(),
            })),
            rejected: [],
            syncCursor: '0',
          });
        });
      });

    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('syncing-push'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    const after = await listPendingMutations();
    expect(after).toHaveLength(0);
  });

  it('marks rejected mutations as failed-conflict and surfaces the stale state', async () => {
    const m = await seedMutation();
    // Settle the mount-time pull before installing the rejecting push
    // so the click is its only caller and the mount sync can't clobber
    // the asserted `stale` state.
    await renderSettled(renderProvider);
    fake.pushImpl = async () => ({
      applied: [],
      rejected: [
        {
          status: 'rejected' as const,
          mutationId: m.id,
          aggregateId: m.aggregateId,
          reason: 'CONFLICT' as const,
          currentVersion: 7,
          currentUpdatedAt: new Date().toISOString(),
          currentDeletedAt: null,
        },
      ],
      syncCursor: '0',
    });
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
    expect(screen.getByTestId('conflicts')).toHaveTextContent('1');
  });

  it('checkAndRepair re-queues each conflict with a FRESH id and re-flushes to clear it', async () => {
    const m = await seedMutation({ operation: 'update', expectedVersion: 3 });
    await renderSettled(renderProvider);
    // First push: server is ahead → escalate to a parked failed-conflict.
    fake.pushImpl = async () => ({
      applied: [],
      rejected: [
        {
          status: 'rejected' as const,
          mutationId: m.id,
          aggregateId: m.aggregateId,
          reason: 'CONFLICT' as const,
          currentVersion: 7,
          currentUpdatedAt: new Date().toISOString(),
          currentDeletedAt: null,
        },
      ],
      syncCursor: '0',
    });
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
    expect(await listFailedConflicts()).toHaveLength(1);

    // Check & repair re-drives the pass. The server now accepts; capture the
    // pushed mutation id to prove it was re-queued under a FRESH id (guards the
    // server's 7-day cached CONFLICT — the original id would replay it).
    const pushedIds: string[] = [];
    fake.pushImpl = async (args) => {
      for (const mut of args.mutations) pushedIds.push(mut.id);
      return {
        applied: args.mutations.map((mut) => ({
          status: 'applied' as const,
          mutationId: mut.id,
          aggregateId: mut.aggregateId,
          newVersion: mut.expectedVersion + 1,
          newUpdatedAt: new Date().toISOString(),
        })),
        rejected: [],
        syncCursor: '0',
      };
    };
    fireEvent.click(screen.getByText('checkAndRepair'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(screen.getByTestId('conflicts')).toHaveTextContent('0');
    expect(pushedIds.length).toBeGreaterThan(0);
    expect(pushedIds).not.toContain(m.id);
    expect(await listFailedConflicts()).toHaveLength(0);
  });

  it('checkAndRepair rehydrates a LEGACY failed-conflict (no server facts) so keep/discard unlocks', async () => {
    // A conflict parked BEFORE the resolve feature shipped has no server facts
    // (`currentVersion` / `currentUpdatedAt` == null), so its keep/discard stays
    // disabled. Check & repair re-pushes it; the fresh CONFLICT rejection now
    // carries the server's true version + updatedAt, which the re-park must
    // persist onto the parked row so the controls unlock.
    await renderSettled(renderProvider);
    // Seed a legacy failed-conflict directly (no persisted server facts).
    await seedMutation({
      id: 'legacy-conflict',
      aggregateId: 'agg-legacy',
      operation: 'update',
      expectedVersion: 3,
      status: 'failed-conflict',
    });
    const legacy = await listFailedConflicts();
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.currentVersion).toBeUndefined();
    expect(legacy[0]?.currentUpdatedAt).toBeUndefined();

    // The re-push is rejected AGAIN with CONFLICT — but now carrying the server's
    // true version + updatedAt (the facts a modern rejection always includes).
    // Key off the ACTUAL pushed id (a fresh uuid the re-enqueue mints).
    fake.pushImpl = async (args) => ({
      applied: [],
      rejected: args.mutations.map((mut) => ({
        status: 'rejected' as const,
        mutationId: mut.id,
        aggregateId: mut.aggregateId,
        reason: 'CONFLICT' as const,
        currentVersion: 7,
        currentUpdatedAt: new Date().toISOString(),
        currentDeletedAt: null,
      })),
      syncCursor: '0',
    });
    fireEvent.click(screen.getByText('checkAndRepair'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));

    // The parked conflict now carries the rehydrated server version — proving
    // the legacy row's facts were refreshed and keep/discard would now be enabled.
    const repaired = await listFailedConflicts();
    expect(repaired).toHaveLength(1);
    expect(repaired[0]?.currentVersion).toBe(7);
  });

  it('records WHY a refresh is needed: the push-rejection reasons + the stale transition marker', async () => {
    // The diagnostics feature must surface why the sync engine insists on
    // "refresh needed": (1) a per-batch entry naming each rejection's reason /
    // aggregateType / operation / versions, and (2) a marker on the stale
    // transition carrying the unresolved-conflict count. Both are source `sync`.
    const m = await seedMutation({
      operation: 'update',
      expectedVersion: 3,
      aggregateId: 'd3f08686-7d07-4a46-a76c-adb1284f1b78',
    });
    await renderSettled(renderProvider);
    clearDiagnostics();
    fake.pushImpl = async () => ({
      applied: [],
      rejected: [
        {
          status: 'rejected' as const,
          mutationId: m.id,
          aggregateId: m.aggregateId,
          reason: 'CONFLICT' as const,
          currentVersion: 7,
          currentUpdatedAt: new Date().toISOString(),
          currentDeletedAt: null,
        },
      ],
      syncCursor: '0',
    });
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));

    const syncEntries = getEntries().filter((e) => e.source === 'sync');
    // The "why" entry: a safe summary string (validated enum + internal
    // enums + small ints only — no reliance on a globally allowlisted key).
    const why = syncEntries.find((e) => e.message.includes('push rejected'));
    expect(why).toBeDefined();
    expect(why?.level).toBe('warn');
    expect(why?.detail).toContain('CONFLICT');
    expect(why?.detail).toContain('account/update');
    expect(why?.detail).toContain('local v3');
    expect(why?.detail).toContain('server v7');
    // The correlatable id fragment (first 8 hex, split to break digit runs) is
    // present on the line — and, since `why.detail` is ALREADY the redacted
    // output, its presence proves the fragment survives the diagnostics
    // redactor. The full UUID would have been masked to `[redacted]`.
    expect(why?.detail).toContain('d3f0-8686');
    expect(why?.detail).not.toContain('[redacted]');
    // Direct redactor assertions: the fragment survives, the full UUID does not.
    expect(redactArgs(['d3f0-8686'])).toContain('d3f0-8686');
    expect(redactArgs(['d3f0-8686'])).not.toContain('[redacted]');
    expect(redactArgs(['d3f08686-7d07-4a46-a76c-adb1284f1b78'])).toContain('[redacted]');
    // The reason is persisted on the failed-conflict mutation.
    const conflicts = await listFailedConflicts();
    expect(conflicts.find((c) => c.id === m.id)?.reason).toBe('CONFLICT');
    // The "when" marker: stale transition with the conflict count.
    const marker = syncEntries.find((e) => e.message.includes('unresolved conflict'));
    expect(marker).toBeDefined();
    expect(marker?.level).toBe('warn');
    expect(marker?.message).toContain('1 unresolved conflict(s)');
    clearDiagnostics();
  });

  it('persists an off-allowlist rejection reason as undefined, never the raw wire string', async () => {
    const m = await seedMutation({ operation: 'update', expectedVersion: 3 });
    await renderSettled(renderProvider);
    fake.pushImpl = async () => ({
      applied: [],
      rejected: [
        {
          status: 'rejected' as const,
          mutationId: m.id,
          aggregateId: m.aggregateId,
          // Simulate a malformed / off-enum wire reason the server should
          // never send — it must NOT be persisted verbatim.
          reason: 'WEIRD_UNKNOWN' as unknown as 'CONFLICT',
          currentVersion: 7,
          currentUpdatedAt: new Date().toISOString(),
          currentDeletedAt: null,
        },
      ],
      syncCursor: '0',
    });
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
    const conflicts = await listFailedConflicts();
    expect(conflicts.find((c) => c.id === m.id)?.reason).toBeUndefined();
  });

  it('does not record refresh-needed diagnostics on a clean synced push', async () => {
    // No conflicts → no `sync` warn noise in the timeline (no false positives).
    await seedMutation();
    await renderSettled(renderProvider);
    clearDiagnostics();
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(getEntries().filter((e) => e.source === 'sync')).toHaveLength(0);
    clearDiagnostics();
  });

  it('writes a diagnostics breadcrumb when a push apply reports recreatedOverTombstone', async () => {
    await seedMutation({
      operation: 'create',
      expectedVersion: 0,
      aggregateId: 'd3f08686-7d07-4a46-a76c-adb1284f1b78',
    });
    await renderSettled(renderProvider);
    clearDiagnostics();
    fake.pushImpl = async (args) => ({
      applied: args.mutations.map((m) => ({
        status: 'applied' as const,
        mutationId: m.id,
        aggregateId: m.aggregateId,
        newVersion: m.expectedVersion + 1,
        newUpdatedAt: new Date().toISOString(),
        // The server revived a tombstoned aggregate id instead of
        // rejecting the create.
        recreatedOverTombstone: true,
      })),
      rejected: [],
      syncCursor: '0',
    });
    fireEvent.click(screen.getByText('notifyPending'));
    // `renderSettled` already leaves the badge at 'synced' (the mount-time
    // pull) — assert the intermediate 'syncing-push' transition first so
    // the wait below proves THIS push cycle (not the stale prior 'synced')
    // has actually completed, mirroring the "cycles pending" test above.
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('syncing-push'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    const syncEntries = getEntries().filter((e) => e.source === 'sync');
    const revived = syncEntries.find((e) =>
      e.message.includes('recreated aggregate over tombstone'),
    );
    expect(revived).toBeDefined();
    expect(revived?.level).toBe('warn');
    // Redaction-surviving id fragment, never the full UUID / a human name.
    expect(revived?.message).toContain('d3f0-8686');
    expect(revived?.message).not.toContain('d3f08686-7d07-4a46-a76c-adb1284f1b78');
    clearDiagnostics();
  });

  it('keeps the badge stale (not synced) on the next poll while a failed-conflict persists', async () => {
    // Drive a rejected push → failed-conflict + stale badge. Then a poll
    // tick (pull success + flush empty-queue early-exit) must NOT flip the
    // badge back to synced — that would drop the user's prompt to resolve
    // while the conflict row lingers in the queue.
    const m = await seedMutation();
    await renderSettled(renderProvider);
    fake.pushImpl = async () => ({
      applied: [],
      rejected: [
        {
          status: 'rejected' as const,
          mutationId: m.id,
          aggregateId: m.aggregateId,
          reason: 'CONFLICT' as const,
          currentVersion: 7,
          currentUpdatedAt: new Date().toISOString(),
          currentDeletedAt: null,
        },
      ],
      syncCursor: '0',
    });
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));

    // retryNow runs ONLY the flush: the pending queue is empty (just the
    // failed-conflict row remains), so this exercises the flush
    // empty-queue early-exit, which must consult the conflict count and
    // stay 'stale'. The pull-success branch is covered by the next test.
    fake.pullImpl = async () => ({ changes: [], newCursor: 'seed-cursor', hasMore: false });
    await act(async () => {
      fireEvent.click(screen.getByText('retryNow'));
      await Promise.resolve();
    });
    // Badge must remain stale, not synced.
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
    expect(screen.getByTestId('state')).not.toHaveTextContent('synced');
    expect(screen.getByTestId('conflicts')).toHaveTextContent('1');
  });

  it('keeps the badge stale through a SUCCESSFUL pull while a failed-conflict persists (pull path)', async () => {
    // Same setup as above, but drive the pull-success branch: a poll tick
    // (and syncRoundTrip) runs pull AFTER the flush, and its success path
    // must not flip the badge to 'synced' over a lingering conflict row.
    const m = await seedMutation();
    await renderSettled(renderProvider);
    fake.pushImpl = async () => ({
      applied: [],
      rejected: [
        {
          status: 'rejected' as const,
          mutationId: m.id,
          aggregateId: m.aggregateId,
          reason: 'CONFLICT' as const,
          currentVersion: 7,
          currentUpdatedAt: new Date().toISOString(),
          currentDeletedAt: null,
        },
      ],
      syncCursor: '0',
    });
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));

    let pulled = false;
    fake.pullImpl = async () => {
      pulled = true;
      return { changes: [], newCursor: 'seed-cursor', hasMore: false };
    };
    await act(async () => {
      fireEvent.click(screen.getByText('syncRoundTrip'));
      await Promise.resolve();
    });
    await waitFor(() => expect(pulled).toBe(true));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
    expect(screen.getByTestId('state')).not.toHaveTextContent('synced');
    expect(screen.getByTestId('conflicts')).toHaveTextContent('1');
  });

  it('forceRefresh runs bootstrap and writes the snapshot to IndexedDB', async () => {
    const aggregateRow = {
      id: 'agg-bootstrap',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 3,
      updatedAt: new Date().toISOString(),
      deviceId: 'dev-server',
      payload: { name: 'From server' },
    };
    // Settle the mount-time pull first, THEN install the per-case
    // bootstrap so the forceRefresh click is the only thing that runs it.
    await renderSettled(renderProvider);
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-1',
      workspaceSnapshot: {
        householdId: 'hh-1',
        aggregates: [aggregateRow],
      },
      postSnapshotMutations: [],
      syncCursor: '42',
      timestamp: new Date().toISOString(),
    });

    await act(async () => {
      fireEvent.click(screen.getByText('forceRefresh'));
    });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('42');
  });

  it('preserves the cached HDK across a force-bootstrap (it refills the same household, not a wipe)', async () => {
    // Regression: a force-bootstrap (cursor-expired auto-recovery or the
    // post-reload force-bootstrap) calls clearAllStores(), which drops the
    // keyCache. The auto-recovery callers have no in-memory HDK
    // to recacheHdk() from, so the cached key was lost and the next reload
    // showed "We couldn't unlock your encrypted data" over a session whose
    // password still worked. applyBootstrap must preserve + restore the cache
    // because the bootstrap refills the SAME household's data — the key stays
    // valid.
    await renderSettled(renderProvider);
    await writeKeyCacheEntry({
      id: KEY_CACHE_ID,
      householdId: 'hh-1',
      hdkExported: new Uint8Array([9, 8, 7, 6]).buffer,
    });
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-1',
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: '7',
      timestamp: new Date().toISOString(),
    });
    await act(async () => {
      fireEvent.click(screen.getByText('forceRefresh'));
    });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    const entry = await readKeyCacheEntry();
    expect(entry).not.toBeNull();
    expect(entry?.householdId).toBe('hh-1');
    expect(new Uint8Array(entry!.hdkExported)).toEqual(new Uint8Array([9, 8, 7, 6]));
  });

  it('error transport surfaces the error state from forceRefresh', async () => {
    await renderSettled(renderProvider);
    fake.bootstrapImpl = async () => {
      throw new Error('Boom');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('forceRefresh'));
    });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
  });

  it('records exactly one sync-sourced diagnostics entry on an error transition', async () => {
    await renderSettled(renderProvider);
    clearDiagnostics();
    fake.bootstrapImpl = async () => {
      throw new Error('Boom');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('forceRefresh'));
    });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    const syncEntries = getEntries().filter((e) => e.source === 'sync');
    expect(syncEntries).toHaveLength(1);
    clearDiagnostics();
  });

  it('propagates SyncApiError envelope (code, traceId, status, phase) into the error state', async () => {
    // The SyncBadge popover renders this structured detail so users
    // can copy a reportable bundle. If the provider drops any field,
    // the popover degrades to a bare message and reportability dies.
    await renderSettled(renderProvider);
    fake.bootstrapImpl = async () => {
      throw new SyncApiError('CONFLICT', 'Aggregate version mismatch', 409, 'trace-xyz');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('forceRefresh'));
    });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    // Read the structured error envelope INSIDE waitFor so it is only
    // sampled after the async error render has fully settled — reading
    // the probe synchronously can catch a half-populated state node.
    await waitFor(() => {
      const detail = JSON.parse(screen.getByTestId('error-detail').textContent || '{}');
      expect(detail).toMatchObject({
        kind: 'error',
        code: 'CONFLICT',
        message: 'Aggregate version mismatch',
        status: 409,
        traceId: 'trace-xyz',
        phase: 'bootstrap',
      });
    });
  });

  it('offline event listener flips the state to offline', async () => {
    await renderSettled(renderProvider);
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('offline'));
  });

  it('does no work when householdId is null (signed-out)', async () => {
    const pushSpy = vi.spyOn(fake, 'push');
    await seedMutation();
    renderProvider({ householdId: null });
    fireEvent.click(screen.getByText('notifyPending'));
    // Yield once so any pending micro-tasks settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('chunks pushes into batches of at most 100 mutations', async () => {
    // 250 queued mutations should result in three sequential push calls
    // of 100 / 100 / 50 — matching the server-side @ArrayMaxSize(100)
    // cap on POST /sync/push.
    for (let i = 0; i < 250; i += 1) {
      await seedMutation({ id: `mut-${i}`, aggregateId: `agg-${i}` });
    }
    // Settle the mount-time pull first so the batch-size capture only
    // sees the click-driven flush, not a mount sync racing it.
    await renderSettled(renderProvider);
    const batchSizes: number[] = [];
    fake.pushImpl = async (args) => {
      batchSizes.push(args.mutations.length);
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
    fireEvent.click(screen.getByText('notifyPending'));
    // Both assertions inside a single waitFor: `batchSizes` is appended
    // synchronously when each push fires, but the `removeMutation`
    // calls that drain `pendingMutations` happen *after* the push
    // resolves. Asserting the length immediately after the
    // batch-count check races those removals — the cure is to wait
    // until the queue actually drains.
    await waitFor(async () => {
      expect(batchSizes).toEqual([100, 100, 50]);
      const remaining = await listPendingMutations();
      expect(remaining).toHaveLength(0);
    });
  });

  it('serializes concurrent notifyPending calls into a single in-flight push', async () => {
    // Mirrors the demo-loader pattern: many `queueLocalMutation` calls
    // each fire `notifyPending()`. Without a re-entry guard each call
    // spawns its own `flushPending`, fanning out concurrent push
    // requests against the same queue. The guard should collapse them
    // into at most one in-flight push at any moment.
    await seedMutation({ id: 'm-1', aggregateId: 'a-1' });
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
    // Wait until the initial sync settles so the test isn't racing
    // the mount-time initialSync.
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );
    // Fire many notifyPending clicks before the first push resolves.
    for (let i = 0; i < 10; i += 1) {
      fireEvent.click(screen.getByText('notifyPending'));
    }
    // Wait for the push to drain. Use the DB queue length (rather than
    // badge state) as the signal because the badge can already read
    // 'synced' from the initialSync prior to clicks.
    await waitFor(
      async () => {
        expect(await listPendingMutations()).toHaveLength(0);
      },
      { timeout: 2000 },
    );
    // Re-entry guard: at most one push runs at a time.
    expect(maxInFlight).toBe(1);
    // Coalesced: the 10 clicks collapse into a small handful of pushes
    // rather than 10 parallel ones. Allow a couple to account for the
    // legitimate rerun on completion if more arrived mid-flight.
    expect(pushCalls).toBeLessThanOrEqual(2);
  });

  it('reruns once when a mutation is queued mid-flush', async () => {
    // While flush is processing the first mutation, queue a second
    // one. The in-flight guard should observe the new pending row on
    // the rerun and push it, leaving the queue empty without an
    // external trigger.
    await seedMutation({ id: 'mid-1', aggregateId: 'a-1' });
    let firstPushStarted = false;
    let firstPushResolve!: () => void;
    const firstPushBlocker = new Promise<void>((r) => {
      firstPushResolve = r;
    });
    fake.pushImpl = async (args) => {
      if (!firstPushStarted) {
        firstPushStarted = true;
        // Queue a second mutation while the first push is blocked.
        await queueMutation({
          id: 'mid-2',
          aggregateId: 'a-2',
          aggregateType: 'account',
          operation: 'create',
          expectedVersion: 0,
          schemaVersion: 1,
          payload: { name: 'Mid' },
          timestamp: Date.now(),
          deviceId: 'dev-1',
          status: 'pending',
        });
        await firstPushBlocker;
      }
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
    // Initial sync runs bootstrap (state lands on 'synced') but does
    // not flush the pending mutation. Wait for that to settle, then
    // trigger the flush explicitly.
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(firstPushStarted).toBe(true));
    // Signal that the second mutation is in the queue; let the first
    // push resolve. The in-flight loop should observe the new pending
    // row on the next iteration and push it.
    firstPushResolve();
    await waitFor(
      async () => {
        expect(await listPendingMutations()).toHaveLength(0);
      },
      { timeout: 2000 },
    );
  });

  it('bootstraps on mount when the device has no sync cursor (first login)', async () => {
    const aggregateRow = {
      id: 'agg-from-server',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 2,
      updatedAt: new Date().toISOString(),
      deviceId: 'dev-server',
      payload: { name: 'Server-side account' },
    };
    let bootstrapCalls = 0;
    let pullCalls = 0;
    fake.bootstrapImpl = async () => {
      bootstrapCalls += 1;
      return {
        snapshotId: 'snap-mount',
        workspaceSnapshot: { householdId: 'hh-1', aggregates: [aggregateRow] },
        postSnapshotMutations: [],
        syncCursor: '7',
        timestamp: new Date().toISOString(),
      };
    };
    fake.pullImpl = async () => {
      pullCalls += 1;
      return { changes: [], newCursor: '7', hasMore: false };
    };

    renderProvider();

    await waitFor(() => expect(bootstrapCalls).toBe(1));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(pullCalls).toBe(0);
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('7');
  });

  it('fires the workspace-changed event after a first-login bootstrap so mounted pages re-read', async () => {
    // Regression: on a fresh device the bootstrap snapshot lands in IDB
    // *after* the dashboard has mounted and read an empty store, so it
    // sat on "0 accounts / $0" until a manual refresh. Bootstrap now
    // dispatches WORKSPACE_CHANGED_EVENT after committing the rows.
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-mount',
      workspaceSnapshot: {
        householdId: 'hh-1',
        aggregates: [
          {
            id: 'agg-from-server',
            householdId: 'hh-1',
            aggregateType: 'account',
            schemaVersion: 1,
            version: 2,
            updatedAt: new Date().toISOString(),
            deviceId: 'dev-server',
            payload: { name: 'Server-side account' },
          },
        ],
      },
      postSnapshotMutations: [],
      syncCursor: '7',
      timestamp: new Date().toISOString(),
    });
    let workspaceChanges = 0;
    const handler = () => {
      workspaceChanges += 1;
    };
    window.addEventListener(WORKSPACE_CHANGED_EVENT, handler);
    try {
      renderProvider();
      await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
      await waitFor(() => expect(workspaceChanges).toBeGreaterThan(0));
    } finally {
      window.removeEventListener(WORKSPACE_CHANGED_EVENT, handler);
    }
  });

  it('pulls on mount when the device already has a non-zero cursor', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-existing',
      syncCursor: '42',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    let bootstrapCalls = 0;
    let pullCalls = 0;
    fake.bootstrapImpl = async () => {
      bootstrapCalls += 1;
      return {
        snapshotId: null,
        workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
        postSnapshotMutations: [],
        syncCursor: '42',
        timestamp: new Date().toISOString(),
      };
    };
    fake.pullImpl = async () => {
      pullCalls += 1;
      return { changes: [], newCursor: '42', hasMore: false };
    };

    renderProvider();

    await waitFor(() => expect(pullCalls).toBe(1));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(bootstrapCalls).toBe(0);
  });

  it('pull replay tombstones an aggregate when the server mutation is a delete', async () => {
    // Regression: pull used to ignore `operation` and write every
    // mutation back as a live row, resurrecting tombstones. After a
    // cross-household import the resurrected rows showed up alongside
    // the freshly imported ones — "all accounts duplicated".
    const seeded: Aggregate = {
      id: 'agg-tombstone',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 3,
      updatedAt: new Date(Date.now() - 1000).toISOString(),
      deviceId: 'dev-test',
      payload: { name: 'Doomed account' },
    };
    await putAggregate('account', seeded);
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: '5',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });

    const tombstoneTime = new Date().toISOString();
    fake.pullImpl = async () => ({
      changes: [
        {
          aggregateId: seeded.id,
          aggregateType: 'account',
          operation: 'delete',
          payload: seeded.payload,
          version: seeded.version + 1,
          schemaVersion: 1,
          updatedAt: tombstoneTime,
          deviceId: 'dev-other',
        },
      ],
      newCursor: '6',
      hasMore: false,
    });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    expect(await getAggregate('account', seeded.id)).toBeNull();
    expect(await listAggregates('account')).toHaveLength(0);
  });

  it('bootstrap replay tombstones an aggregate when postSnapshotMutations contains a delete', async () => {
    // Cross-household import generates delete mutations *after* the
    // last snapshot — bootstrap must apply them, not resurrect them.
    const aggregateRow = {
      id: 'agg-bootstrap-delete',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: new Date(Date.now() - 1000).toISOString(),
      deviceId: 'dev-server',
      payload: { name: 'Imported then deleted' },
    };
    const tombstoneTime = new Date().toISOString();
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-1',
      workspaceSnapshot: {
        householdId: 'hh-1',
        aggregates: [aggregateRow],
      },
      postSnapshotMutations: [
        {
          aggregateId: aggregateRow.id,
          aggregateType: 'account',
          operation: 'delete',
          payload: aggregateRow.payload,
          version: aggregateRow.version + 1,
          schemaVersion: 1,
          updatedAt: tombstoneTime,
          deviceId: 'dev-server',
        },
      ],
      syncCursor: '99',
      timestamp: tombstoneTime,
    });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    expect(await getAggregate('account', aggregateRow.id)).toBeNull();
    expect(await listAggregates('account')).toHaveLength(0);
  });

  it('pull skips changes with an unknown aggregateType and still advances the cursor (regression: a retired aggregate type)', async () => {
    // The `plan` aggregate type was dropped. The dev DynamoDB still
    // had legacy `plan` mutations, and the client would call
    // `putAggregate('plan', ...)` → STORE_BY_TYPE['plan'] is undefined →
    // idb threw "object stores was not found" on every login. The fix
    // is forward-compatible: warn and skip, advance the cursor, keep
    // applying any other changes in the same batch.
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: '5',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    const liveAggregateId = 'agg-live';
    fake.pullImpl = async () => ({
      changes: [
        {
          aggregateId: 'agg-retired',
          aggregateType: 'plan' as never,
          operation: 'create',
          payload: { name: 'Legacy plan' },
          version: 1,
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          deviceId: 'dev-other',
        },
        {
          aggregateId: liveAggregateId,
          aggregateType: 'account',
          operation: 'create',
          payload: { name: 'Live account' },
          version: 1,
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          deviceId: 'dev-other',
        },
      ],
      newCursor: '99',
      hasMore: false,
    });

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    // Cursor advanced past the retired row — otherwise the next pull
    // would replay it forever and the badge would stick on `error`.
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('99');
    // The live change in the same batch was still applied.
    const live = await getAggregate('account', liveAggregateId);
    expect(live).not.toBeNull();
    expect(live?.payload).toEqual({ name: 'Live account' });
  });

  it('captures the [sync] unknown-aggregateType console.warn as exactly one shim-only entry', async () => {
    // The `[sync]` warn is routed through console — the diagnostics console
    // shim must capture it EXACTLY once as source 'console' / namespace 'sync'.
    // There must be NO additional source 'sync' entry (that source is reserved
    // for non-console setSyncState error transitions — no double-capture).
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: '5',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({
      changes: [
        {
          aggregateId: 'agg-retired',
          aggregateType: 'plan' as never,
          operation: 'create',
          payload: { name: 'Legacy plan' },
          version: 1,
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          deviceId: 'dev-other',
        },
      ],
      newCursor: '99',
      hasMore: false,
    });

    // Silence the devtools passthrough so the original console.warn does not
    // dump into the test output, then install the capture shim.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    clearDiagnostics();
    installDiagnostics();
    try {
      renderProvider();
      await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
      const syncNamespaced = getEntries().filter(
        (e) => e.source === 'console' && e.namespace === 'sync',
      );
      expect(syncNamespaced).toHaveLength(1);
      expect(syncNamespaced[0].message).toContain('unknown aggregateType');
      // No double-capture via the non-console 'sync' source.
      expect(getEntries().filter((e) => e.source === 'sync')).toHaveLength(0);
    } finally {
      uninstallDiagnostics();
      clearDiagnostics();
    }
  });

  it('bootstrap skips snapshot rows with an unknown aggregateType and still completes', async () => {
    // Snapshots can carry retired types until the next compaction even
    // after MutationLog is purged — the client must not crash on them.
    // Pin metadata to cursor='0' so initialSync deterministically takes
    // the bootstrap path regardless of cross-file fake-indexeddb leakage.
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: '0',
      lastSyncedAt: null,
      displayName: 'This device',
    });
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-retired',
      workspaceSnapshot: {
        householdId: 'hh-1',
        aggregates: [
          {
            id: 'agg-retired',
            householdId: 'hh-1',
            aggregateType: 'plan' as never,
            schemaVersion: 1,
            version: 1,
            updatedAt: new Date().toISOString(),
            deviceId: 'dev-server',
            payload: { name: 'Legacy plan' },
          },
          {
            id: 'agg-live',
            householdId: 'hh-1',
            aggregateType: 'account',
            schemaVersion: 1,
            version: 1,
            updatedAt: new Date().toISOString(),
            deviceId: 'dev-server',
            payload: { name: 'Live account' },
          },
        ],
      },
      postSnapshotMutations: [],
      syncCursor: '42',
      timestamp: new Date().toISOString(),
    });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    expect(await getAggregate('account', 'agg-live')).not.toBeNull();
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('42');
  });

  it('pull replay updates a live aggregate without tombstoning it (positive control)', async () => {
    const seeded: Aggregate = {
      id: 'agg-live-update',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: new Date(Date.now() - 1000).toISOString(),
      deviceId: 'dev-test',
      payload: { name: 'Old name' },
    };
    await putAggregate('account', seeded);
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: '5',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });

    const updateTime = new Date().toISOString();
    fake.pullImpl = async () => ({
      changes: [
        {
          aggregateId: seeded.id,
          aggregateType: 'account',
          operation: 'update',
          payload: { name: 'New name' },
          version: 2,
          schemaVersion: 1,
          updatedAt: updateTime,
          deviceId: 'dev-other',
        },
      ],
      newCursor: '6',
      hasMore: false,
    });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    const after = await getAggregate('account', seeded.id);
    expect(after).not.toBeNull();
    expect(after?.payload).toEqual({ name: 'New name' });
    expect(after?.deletedAt).toBeUndefined();
  });

  it('rewakes the poll on visibilitychange when the debounce window has elapsed', async () => {
    // Returning to a backgrounded tab should cancel the long idle wait
    // and pull immediately so a fresh deploy that landed while the tab
    // was hidden surfaces in the version-banner detector within seconds
    // instead of on the next 5-min poll boundary. Inside the 5 s
    // debounce window, refocus is a no-op (rapid focus toggling must
    // not fan out a flurry of pulls).
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);

    let pullCalls = 0;
    fake.pullImpl = async () => {
      pullCalls += 1;
      return { changes: [], newCursor: '0', hasMore: false };
    };
    // Seed cursor=42 so initialSync routes through `pull()` (not
    // bootstrap), giving a clean baseline pull-call count.
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: '42',
      lastSyncedAt: null,
      displayName: 'This device',
    });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    const baselinePulls = pullCalls;
    expect(baselinePulls).toBeGreaterThan(0);

    // Inside debounce window: visibility flip must NOT fire a pull.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(pullCalls).toBe(baselinePulls);

    // Past debounce window: visibility flip schedules an immediate pull.
    nowSpy.mockReturnValue(baseTime + 6_000);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      // Allow the 0-delay setTimeout in the rewake handler to fire and
      // its async pull/flushPending chain to settle.
      await new Promise((r) => setTimeout(r, 10));
    });
    await waitFor(() => expect(pullCalls).toBeGreaterThan(baselinePulls));

    // Hidden visibility never triggers a pull.
    const afterRewake = pullCalls;
    nowSpy.mockReturnValue(baseTime + 60_000);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(pullCalls).toBe(afterRewake);

    nowSpy.mockRestore();
  });

  it('flushes pending mutations BEFORE the CURSOR_EXPIRED auto-bootstrap wipes the queue', async () => {
    // Server signal that local cursor predates the compactor watermark
    // (`mutationLogCursorBase`). Continuing to incremental-pull would
    // silently miss data, so the client must reseed via bootstrap.
    // Cursor expiry is frequently caused by this device's OWN
    // compacted pushes, so a non-empty queue can hold valid offline
    // edits. The client must push them BEFORE the mandatory bootstrap
    // wipe, not silently discard them.
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'ancient-cursor',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    await seedMutation();
    const events: string[] = [];
    let pullCalls = 0;
    let bootstrapCalls = 0;
    let lastForce: boolean | null = null;
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
      pullCalls += 1;
      throw new SyncApiError('CURSOR_EXPIRED', 'Cursor expired', 409, 'trace-1');
    };
    fake.bootstrapImpl = async (args) => {
      events.push('bootstrap');
      bootstrapCalls += 1;
      lastForce = args.force;
      return {
        snapshotId: 'snap-recovered',
        workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
        postSnapshotMutations: [],
        syncCursor: 'fresh-cursor',
        timestamp: new Date().toISOString(),
      };
    };

    renderProvider();

    await waitFor(() => expect(pullCalls).toBeGreaterThan(0));
    await waitFor(() => expect(bootstrapCalls).toBe(1));
    expect(lastForce).toBe(true);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    // Ordering proof: the queued edit was pushed BEFORE the bootstrap
    // wiped the queue — not silently discarded.
    expect(events.indexOf('push')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('push')).toBeLessThan(events.indexOf('bootstrap'));
    // The bootstrap wipe still cleared the queue afterwards.
    const remaining = await listPendingMutations();
    expect(remaining).toHaveLength(0);
    // Cursor advanced to whatever bootstrap returned, not stuck on the
    // ancient pre-expiry value.
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('fresh-cursor');
  });

  it('halts pull when a change carries a schemaVersion ahead of the local registry; surfaces the calm update-available badge, not a red error; cursor is not advanced', async () => {
    // Forward-gap detection: if a multi-device household pushed a
    // mutation at v2 of an aggregate while this client only knows v1,
    // applying it would write an unreadable shape into IDB. The client
    // must halt the entire batch (no IDB write, no cursor advance) so
    // that reload + newer bundle can replay from the same cursor.
    // This is surfaced as the calm 'update-available'
    // badge, NOT the red 'error' state — a schema-ahead deploy is not a
    // sync failure the user can retry their way out of.
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-before',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => ({
      changes: [
        {
          aggregateId: 'agg-future',
          aggregateType: 'account',
          operation: 'create',
          // Account is at v1 in the local registry — v9999 is far ahead.
          schemaVersion: 9999,
          version: 1,
          payload: { name: 'From the future' },
          updatedAt: new Date().toISOString(),
          deviceId: 'dev-other',
        },
      ],
      newCursor: 'cursor-after',
      hasMore: false,
    });
    clearDiagnostics();

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('update-available'));
    // Aggregate must NOT have been written.
    expect(await getAggregate('account', 'agg-future')).toBeNull();
    // Cursor stays put so a reload picks up from the same point.
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('cursor-before');
    // The diagnostics breadcrumb is still recorded (setSyncState's
    // centralized hook doesn't auto-record 'update-available', so this
    // proves the explicit call-site recordSyncWarn fired).
    const why = getEntries()
      .filter((e) => e.source === 'sync')
      .find((e) => e.message.includes('SCHEMA_AHEAD'));
    expect(why).toBeDefined();
    expect(why?.level).toBe('warn');
    clearDiagnostics();
  });

  it('halts bootstrap when a snapshot row is schema-ahead and does not clear local state; surfaces the calm update-available badge', async () => {
    // Mirror of the pull-side guard for the bootstrap path. Schema-ahead
    // rows in the snapshot half of the response would otherwise be
    // written into IDB during a forceRefresh — we'd wipe local data and
    // reseed with shapes the bundle can't render. Instead: detect
    // before clearing, leave existing IDB intact, raise the banner (the
    // calm 'update-available' badge, not the red 'error' state).
    const seeded: Aggregate = {
      id: 'agg-keep',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: new Date(Date.now() - 1000).toISOString(),
      deviceId: 'dev-test',
      payload: { name: 'Pre-existing' },
    };
    await putAggregate('account', seeded);
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-before',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-future',
      workspaceSnapshot: {
        householdId: 'hh-1',
        aggregates: [
          {
            id: 'agg-future',
            householdId: 'hh-1',
            aggregateType: 'account',
            schemaVersion: 9999,
            version: 1,
            updatedAt: new Date().toISOString(),
            deviceId: 'dev-other',
            payload: { name: 'From the future' },
          },
        ],
      },
      postSnapshotMutations: [],
      syncCursor: 'cursor-after',
      timestamp: new Date().toISOString(),
    });

    renderProvider();
    // The seeded cursor sends initialSync down the `pull()` branch, not
    // bootstrap. Wait for that incremental pull to settle so its
    // late-resolving `setState('synced')` doesn't race against — and
    // clobber — the SCHEMA_AHEAD state we're about to assert.
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    clearDiagnostics();
    await act(async () => {
      fireEvent.click(screen.getByText('forceRefresh'));
    });

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('update-available'));
    // Existing local state survives — the wipe never ran.
    const kept = await getAggregate('account', seeded.id);
    expect(kept).not.toBeNull();
    expect(kept?.payload).toEqual({ name: 'Pre-existing' });
    // Schema-ahead row from the response was never persisted.
    expect(await getAggregate('account', 'agg-future')).toBeNull();
    // The diagnostics breadcrumb is still recorded at this call site too.
    const why = getEntries()
      .filter((e) => e.source === 'sync')
      .find((e) => e.message.includes('SCHEMA_AHEAD'));
    expect(why).toBeDefined();
    expect(why?.level).toBe('warn');
    clearDiagnostics();
  });

  it('a force bootstrap that quarantined a row keeps that aggregate\'s last readable local copy, refills the rest, and advances the cursor', async () => {
    // A `clearFirst` bootstrap wipes IDB and refills it from the (already-
    // pruned) response. When the transport has just dropped an undecryptable
    // row, a blind refill would silently delete the last readable local copy
    // of that aggregate — a stolen bearer session can push shape-valid
    // ciphertext for any aggregate (the server holds no key to check it), so
    // this is reachable by an attacker, not just corruption. Halting
    // the whole refresh would leave the CURSOR_EXPIRED auto-recovery
    // wedged forever on one poisoned row, so the poisoned
    // aggregate's local copy is carried across the wipe and everything else
    // proceeds: other stale local rows are gone, clean rows land, the cursor
    // advances.
    const poisoned: Aggregate = {
      id: 'agg-poisoned',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: new Date(Date.now() - 1000).toISOString(),
      deviceId: 'dev-test',
      payload: { name: 'Last readable copy' },
    };
    const stale: Aggregate = { ...poisoned, id: 'agg-stale', payload: { name: 'Deleted on the server' } };
    await putAggregate('account', poisoned);
    await putAggregate('account', stale);
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-before',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-quarantine',
      workspaceSnapshot: {
        householdId: 'hh-1',
        aggregates: [
          {
            id: 'agg-clean',
            householdId: 'hh-1',
            aggregateType: 'account',
            schemaVersion: 1,
            version: 2,
            updatedAt: new Date().toISOString(),
            deviceId: 'dev-other',
            payload: { name: 'Fresh from the server' },
          },
        ],
      },
      postSnapshotMutations: [],
      syncCursor: 'cursor-after',
      timestamp: new Date().toISOString(),
      quarantined: [{ aggregateId: 'agg-poisoned', aggregateType: 'account' }],
    });

    renderProvider();
    // The seeded cursor sends initialSync down the `pull()` branch, not
    // bootstrap. Wait for that incremental pull to settle before clicking.
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    await act(async () => {
      fireEvent.click(screen.getByText('forceRefresh'));
    });

    await waitFor(async () => expect((await readDeviceMetadata())?.syncCursor).toBe('cursor-after'));
    expect(screen.getByTestId('state')).toHaveTextContent('synced');
    // The poisoned aggregate's last readable copy survived the wipe, at its
    // old version (so a later good server copy still applies over it).
    const kept = await getAggregate('account', poisoned.id);
    expect(kept?.payload).toEqual({ name: 'Last readable copy' });
    expect(kept?.version).toBe(1);
    // Everything else behaved like a normal force refresh.
    expect(await getAggregate('account', 'agg-stale')).toBeNull();
    expect((await getAggregate('account', 'agg-clean'))?.payload).toEqual({
      name: 'Fresh from the server',
    });
  });

  it('follows hasMore: applies every backlogged page and lands on the final cursor', async () => {
    // A long catch-up must not leave partially-applied cross-aggregate
    // state between poll ticks. pull() loops while hasMore, applying each
    // page and advancing the cursor, until the server reports the last
    // page. Two pages here: page 1 (hasMore:true) then page 2 (false).
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'page-0',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    const sinceSeen: string[] = [];
    fake.pullImpl = async (args) => {
      sinceSeen.push(args.since);
      if (args.since === 'page-0') {
        return {
          changes: [
            {
              aggregateId: 'agg-p1',
              aggregateType: 'account',
              operation: 'create',
              payload: { name: 'Page 1' },
              version: 1,
              schemaVersion: 1,
              updatedAt: new Date().toISOString(),
              deviceId: 'dev-other',
            },
          ],
          newCursor: 'page-1',
          hasMore: true,
        };
      }
      return {
        changes: [
          {
            aggregateId: 'agg-p2',
            aggregateType: 'account',
            operation: 'create',
            payload: { name: 'Page 2' },
            version: 1,
            schemaVersion: 1,
            updatedAt: new Date().toISOString(),
            deviceId: 'dev-other',
          },
        ],
        newCursor: 'page-2',
        hasMore: false,
      };
    };

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    // Both pages' changes are applied locally.
    expect(await getAggregate('account', 'agg-p1')).not.toBeNull();
    expect(await getAggregate('account', 'agg-p2')).not.toBeNull();
    // The second page was fetched from page 1's cursor, and the final
    // persisted cursor is page 2's.
    expect(sinceSeen).toContain('page-1');
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('page-2');
  });

  it('uses the canonical deviceId prop on every push (matches the JWT claim)', async () => {
    // Even if local IDB metadata holds a stale deviceId, the push body
    // must carry the auth-context value so the controller's
    // `dto.deviceId === me.deviceId` check passes (otherwise: 403
    // DEVICE_MISMATCH).
    await writeDeviceMetadata({
      deviceId: 'stale-idb-id',
      syncCursor: '0',
      lastSyncedAt: null,
      displayName: 'This device',
    });
    await seedMutation();
    let captured: Parameters<SyncTransport['push']>[0] | null = null;
    fake.pushImpl = async (args) => {
      captured = args;
      return { applied: [], rejected: [], syncCursor: '0' };
    };
    renderProvider();
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.deviceId).toBe('dev-test');
  });
});


describe('SyncProvider initial sync start', () => {
  useSyncTestHooks();

  beforeEach(async () => {
    // Clean slate so the mount `initialSync` deterministically takes the
    // bootstrap branch (no persisted cursor).
    fake.pushImpl = vi.fn(async () => ({ applied: [], rejected: [], syncCursor: '0' }));
    fake.pullImpl = vi.fn(async () => ({ changes: [], newCursor: '0', hasMore: false }));
    fake.bootstrapImpl = vi.fn(async () => ({
      snapshotId: null,
      workspaceSnapshot: { householdId: 'mock', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: '0',
      timestamp: new Date().toISOString(),
    }));
  });

  afterEach(() => {
    cleanup();
  });

  function renderWithHousehold(householdId: string | null) {
    const props = {
      deviceId: 'dev-test',
      apiBaseUrl: '',
      getAccessToken: () => 'tok',
      getCsrfToken: () => 'csrf',
      mock: true as const,
    };
    const utils = render(
      <SyncProvider {...props} householdId={householdId}>
        <Probe />
      </SyncProvider>,
    );
    return {
      ...utils,
      setHouseholdId: (id: string | null) =>
        utils.rerender(
          <SyncProvider {...props} householdId={id}>
            <Probe />
          </SyncProvider>,
        ),
    };
  }

  it('does not sync without a household, then bootstraps once the householdId is released', async () => {
    const { setHouseholdId } = renderWithHousehold(null);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(fake.bootstrapImpl).not.toHaveBeenCalled();
    expect(fake.pullImpl).not.toHaveBeenCalled();
    expect(fake.pushImpl).not.toHaveBeenCalled();

    // The host releases the household (unlock resolved): sync starts right away,
    // with no other precondition.
    await act(async () => {
      setHouseholdId('hh-1');
    });
    await waitFor(() => expect(fake.bootstrapImpl).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );
  });

  it('bootstraps on mount when the household is already known', async () => {
    renderWithHousehold('hh-1');
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );
    expect(fake.bootstrapImpl).toHaveBeenCalledTimes(1);
  });
});
