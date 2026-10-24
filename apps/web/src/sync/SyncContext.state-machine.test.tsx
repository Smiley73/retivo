// SyncProvider badge state machine: synced / pending / syncing / offline / error / stale transitions and initial sync.
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

// A failed refresh re-arms the poll with a full-jitter draw from uniform(0, 15 s); a draw near zero would flip the badge
// back to `synced` before the test sees `error`, so the draw is pinned to its ceiling.
function pinRetryJitterToCeiling(): void {
  vi.spyOn(Math, 'random').mockReturnValue(1);
}

describe('SyncProvider state machine', () => {
  useSyncTestHooks();

  it('starts in the synced state when there is nothing to push', async () => {
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(screen.getByTestId('pending')).toHaveTextContent('0');
  });

  it('cycles pending -> syncing-push -> synced after notifyPending', async () => {
    await seedMutation();
    // Settle the mount-time pull first so its late state write cannot clobber the transitions the click drives.
    await renderSettled(renderProvider);
    let resolvePush!: (value: PushResponseBody) => void;
    fake.pushImpl = (args) =>
      new Promise<PushResponseBody>((resolve) => {
        resolvePush = (value) => resolve(value);
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

    // The retry must re-queue under a fresh id: the server caches a CONFLICT for 7 days per mutation id.
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
    // A conflict parked before server facts were persisted has `currentVersion`/`currentUpdatedAt` null; Check & repair
    // re-pushes it and the fresh CONFLICT must persist the true facts.
    await renderSettled(renderProvider);
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

    const repaired = await listFailedConflicts();
    expect(repaired).toHaveLength(1);
    expect(repaired[0]?.currentVersion).toBe(7);
  });

  it('records WHY a refresh is needed: the push-rejection reasons + the stale transition marker', async () => {
    // Diagnostics must say why the engine insists on "refresh needed": a per-batch entry per rejection and a stale-transition marker carrying the conflict count.
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
    const why = syncEntries.find((e) => e.message.includes('push rejected'));
    expect(why).toBeDefined();
    expect(why?.level).toBe('warn');
    expect(why?.detail).toContain('CONFLICT');
    expect(why?.detail).toContain('account/update');
    expect(why?.detail).toContain('local v3');
    expect(why?.detail).toContain('server v7');
    // `why.detail` is already redacted output, so the id fragment's presence proves it survives the redactor; the full UUID would be masked.
    expect(why?.detail).toContain('d3f0-8686');
    expect(why?.detail).not.toContain('[redacted]');
    expect(redactArgs(['d3f0-8686'])).toContain('d3f0-8686');
    expect(redactArgs(['d3f0-8686'])).not.toContain('[redacted]');
    expect(redactArgs(['d3f08686-7d07-4a46-a76c-adb1284f1b78'])).toContain('[redacted]');
    const conflicts = await listFailedConflicts();
    expect(conflicts.find((c) => c.id === m.id)?.reason).toBe('CONFLICT');
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
          // An off-enum wire reason must not be persisted verbatim.
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
        recreatedOverTombstone: true,
      })),
      rejected: [],
      syncCursor: '0',
    });
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('syncing-push'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    const syncEntries = getEntries().filter((e) => e.source === 'sync');
    const revived = syncEntries.find((e) =>
      e.message.includes('recreated aggregate over tombstone'),
    );
    expect(revived).toBeDefined();
    expect(revived?.level).toBe('warn');
    expect(revived?.message).toContain('d3f0-8686');
    expect(revived?.message).not.toContain('d3f08686-7d07-4a46-a76c-adb1284f1b78');
    clearDiagnostics();
  });

  it('keeps the badge stale through an empty-queue flush and a successful pull while a failed-conflict persists', async () => {
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

    const expectStillStale = async () => {
      await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
      expect(screen.getByTestId('state')).not.toHaveTextContent('synced');
      expect(screen.getByTestId('conflicts')).toHaveTextContent('1');
    };

    fake.pullImpl = async () => ({ changes: [], newCursor: 'seed-cursor', hasMore: false });
    await act(async () => {
      fireEvent.click(screen.getByText('retryNow'));
      await Promise.resolve();
    });
    await expectStillStale();

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
    await expectStillStale();
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
    // A force-bootstrap calls clearAllStores(), which drops the keyCache, and auto-recovery has no in-memory HDK to
    // recache; applyBootstrap must preserve and restore it, or the next reload says the data cannot be unlocked.
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
    pinRetryJitterToCeiling();
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
    pinRetryJitterToCeiling();
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
    // The SyncBadge popover renders this detail for a reportable bundle; a dropped field degrades it to a bare message.
    await renderSettled(renderProvider);
    pinRetryJitterToCeiling();
    fake.bootstrapImpl = async () => {
      throw new SyncApiError('CONFLICT', 'Aggregate version mismatch', 409, 'trace-xyz');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('forceRefresh'));
    });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    // Sampled inside waitFor: reading the probe synchronously can catch a half-populated state node.
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
    await act(async () => {
      await Promise.resolve();
    });
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('chunks pushes into batches of at most 100 mutations', async () => {
    // 250 queued mutations push as 100 / 100 / 50, matching the server's @ArrayMaxSize(100) on POST /sync/push.
    for (let i = 0; i < 250; i += 1) {
      await seedMutation({ id: `mut-${i}`, aggregateId: `agg-${i}` });
    }
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
    // One waitFor for both assertions: the removals that drain the queue run after each push resolves.
    await waitFor(async () => {
      expect(batchSizes).toEqual([100, 100, 50]);
      const remaining = await listPendingMutations();
      expect(remaining).toHaveLength(0);
    });
  });

  it('serializes concurrent notifyPending calls into a single in-flight push', async () => {
    // Many `queueLocalMutation` calls each fire `notifyPending()`; the re-entry guard must collapse them into at most one in-flight push.
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
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );
    for (let i = 0; i < 10; i += 1) {
      fireEvent.click(screen.getByText('notifyPending'));
    }
    // The queue length, not the badge, is the drain signal: the badge can already read 'synced' from the initial sync.
    await waitFor(
      async () => {
        expect(await listPendingMutations()).toHaveLength(0);
      },
      { timeout: 2000 },
    );
    expect(maxInFlight).toBe(1);
    expect(pushCalls).toBeLessThanOrEqual(2);
  });

  it('reruns once when a mutation is queued mid-flush', async () => {
    await seedMutation({ id: 'mid-1', aggregateId: 'a-1' });
    let firstPushStarted = false;
    let firstPushResolve!: () => void;
    const firstPushBlocker = new Promise<void>((r) => {
      firstPushResolve = r;
    });
    fake.pushImpl = async (args) => {
      if (!firstPushStarted) {
        firstPushStarted = true;
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
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('synced'),
    );
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(firstPushStarted).toBe(true));
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
    // A fresh device's bootstrap lands in IDB after the dashboard read an empty store, so bootstrap must dispatch WORKSPACE_CHANGED_EVENT.
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
    // Pull must honour `operation`: writing every mutation back as a live row resurrects tombstones after a cross-household import.
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
    // A dropped aggregate type (`plan`) still has legacy mutations: pull warns and skips them, advances the cursor and applies the rest of the batch.
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
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('99');
    const live = await getAggregate('account', liveAggregateId);
    expect(live).not.toBeNull();
    expect(live?.payload).toEqual({ name: 'Live account' });
  });

  it('captures the [sync] unknown-aggregateType console.warn as exactly one shim-only entry', async () => {
    // The `[sync]` warn goes through console, so the diagnostics shim must capture it exactly once as source 'console'; source 'sync'
    // is reserved for non-console setSyncState error transitions.
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

    // Silence the devtools passthrough so the original console.warn stays out of the test output.
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
      expect(getEntries().filter((e) => e.source === 'sync')).toHaveLength(0);
    } finally {
      uninstallDiagnostics();
      clearDiagnostics();
    }
  });

  it('bootstrap skips snapshot rows with an unknown aggregateType and still completes', async () => {
    // Pinning cursor '0' makes initialSync take the bootstrap path regardless of cross-file fake-indexeddb leakage.
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
    // Returning to a backgrounded tab pulls immediately so a fresh deploy surfaces in the version-banner detector; inside the
    // 5 s debounce window a refocus is a no-op.
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);

    let pullCalls = 0;
    fake.pullImpl = async () => {
      pullCalls += 1;
      return { changes: [], newCursor: '0', hasMore: false };
    };
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

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(pullCalls).toBe(baselinePulls);

    nowSpy.mockReturnValue(baseTime + 6_000);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 10));
    });
    await waitFor(() => expect(pullCalls).toBeGreaterThan(baselinePulls));

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
    // A cursor older than the compactor watermark (`mutationLogCursorBase`) forces a bootstrap; queued edits may be valid
    // offline work, so they must be pushed before the wipe, not discarded.
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
    expect(events.indexOf('push')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('push')).toBeLessThan(events.indexOf('bootstrap'));
    const remaining = await listPendingMutations();
    expect(remaining).toHaveLength(0);
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('fresh-cursor');
  });

  it('halts pull when a change carries a schemaVersion ahead of the local registry; surfaces the calm update-available badge, not a red error; cursor is not advanced', async () => {
    // A mutation ahead of the local schema would write an unreadable shape: the whole batch halts (no IDB write, no cursor
    // advance) and the calm 'update-available' badge shows, since a retry cannot fix it.
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
    expect(await getAggregate('account', 'agg-future')).toBeNull();
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('cursor-before');
    const why = getEntries()
      .filter((e) => e.source === 'sync')
      .find((e) => e.message.includes('SCHEMA_AHEAD'));
    expect(why).toBeDefined();
    expect(why?.level).toBe('warn');
    clearDiagnostics();
  });

  it('halts bootstrap when a snapshot row is schema-ahead and does not clear local state; surfaces the calm update-available badge', async () => {
    // The bootstrap path has the same guard: schema-ahead snapshot rows are detected before the wipe so existing IDB stays
    // intact.
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
    // Wait for the incremental pull to settle so its late `synced` cannot clobber the SCHEMA_AHEAD state asserted below.
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    clearDiagnostics();
    await act(async () => {
      fireEvent.click(screen.getByText('forceRefresh'));
    });

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('update-available'));
    const kept = await getAggregate('account', seeded.id);
    expect(kept).not.toBeNull();
    expect(kept?.payload).toEqual({ name: 'Pre-existing' });
    expect(await getAggregate('account', 'agg-future')).toBeNull();
    const why = getEntries()
      .filter((e) => e.source === 'sync')
      .find((e) => e.message.includes('SCHEMA_AHEAD'));
    expect(why).toBeDefined();
    expect(why?.level).toBe('warn');
    clearDiagnostics();
  });

  it('a force bootstrap that quarantined a row keeps that aggregate\'s last readable local copy, refills the rest, and advances the cursor', async () => {
    // A clearFirst bootstrap must not delete the last readable local copy of an aggregate the transport just dropped as
    // undecryptable (a stolen session can push valid-shaped ciphertext), nor wedge CURSOR_EXPIRED recovery on one poisoned
    // row: that copy is carried across the wipe and everything else proceeds.
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
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    await act(async () => {
      fireEvent.click(screen.getByText('forceRefresh'));
    });

    await waitFor(async () => expect((await readDeviceMetadata())?.syncCursor).toBe('cursor-after'));
    expect(screen.getByTestId('state')).toHaveTextContent('synced');
    const kept = await getAggregate('account', poisoned.id);
    expect(kept?.payload).toEqual({ name: 'Last readable copy' });
    expect(kept?.version).toBe(1);
    expect(await getAggregate('account', 'agg-stale')).toBeNull();
    expect((await getAggregate('account', 'agg-clean'))?.payload).toEqual({
      name: 'Fresh from the server',
    });
  });

  it('follows hasMore: applies every backlogged page and lands on the final cursor', async () => {
    // pull() loops while hasMore, applying each page and advancing the cursor, so a long catch-up leaves no partial state between ticks.
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

    expect(await getAggregate('account', 'agg-p1')).not.toBeNull();
    expect(await getAggregate('account', 'agg-p2')).not.toBeNull();
    expect(sinceSeen).toContain('page-1');
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('page-2');
  });

  it('uses the canonical deviceId prop on every push (matches the JWT claim)', async () => {
    // The push body carries the auth-context deviceId even when IDB metadata is stale, or the controller's deviceId check 403s.
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
