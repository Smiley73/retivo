/**
 * SyncProvider failure parks and recovery: device mismatch, permanent push rejections, cursor reset, reseed, rollback detection.
 *
 * Split out of the former single SyncContext.test.tsx; shared setup lives in
 * `sync-context.test-harness.tsx`.
 */
import 'fake-indexeddb/auto';
import { useState } from 'react';
import { screen, waitFor, act, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getAggregate, listAggregates, listFailedErrors, putAggregate, readDeviceMetadata, listPendingMutations, writeDeviceMetadata } from '../db/store';
import * as storeModule from '../db/store';
import { type Aggregate } from '../db/types';
import { SyncApiError, FreshnessRollbackError } from './sync-client';
import { UnauthenticatedPayloadError } from './pull-apply';
import { notifyRollbackDetectedOutsideSync } from './error-detail';
import { useSync } from './SyncContext';
import { fake, renderProvider, seedMutation, renderSettled, useSyncTestHooks } from './sync-context.test-harness';

vi.mock('./mock-sync', async () => (await import('./sync-context.test-fake')).mockSyncModule);


// DEVICE_MISMATCH recovery. A push whose JWT device id no longer
// matches this client's (the wiped-deviceId edge from clear-data) returns
// a 403 `SyncApiError('DEVICE_MISMATCH')`. The push catch hands off to the
// host's `onDeviceMismatch` (logout + clean re-login) once, then `return
// false`s the flush — so even a multi-batch queue produces exactly one
// callback per failed flush. Mirrors the CONFLICT/CURSOR_EXPIRED transport
// tests; renders SyncProvider with the extra `onDeviceMismatch` prop.
describe('SyncProvider — DEVICE_MISMATCH recovery', () => {
  useSyncTestHooks();

  const renderWithMismatch = (onDeviceMismatch: () => void | Promise<void>) =>
    renderProvider({ onDeviceMismatch });

  it('invokes onDeviceMismatch exactly once when push returns DEVICE_MISMATCH', async () => {
    const onDeviceMismatch = vi.fn();
    await seedMutation();
    // Settle the mount-time pull first so the rejecting push is only
    // driven by the click — the mount sync can't double-count the spy.
    await renderSettled(() => renderWithMismatch(onDeviceMismatch));
    fake.pushImpl = async () => {
      throw new SyncApiError('DEVICE_MISMATCH', 'Device id mismatch', 403, 'trace-dm');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
      await Promise.resolve();
    });
    await waitFor(() => expect(onDeviceMismatch).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
    // The failed flush must NOT advance sync state: the push catch does
    // `await onDeviceMismatch?.(); return false;`, so flushPending reports
    // failure without draining the queue or moving the cursor. A future
    // regression that swallows DEVICE_MISMATCH and advances state would
    // leave the queue empty / the cursor changed — assert neither happened.
    const remaining = await listPendingMutations();
    expect(remaining).toHaveLength(1);
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('seed-cursor');
  });

  it('invokes onDeviceMismatch only once even with multiple queued mutations (single failed flush batch)', async () => {
    const onDeviceMismatch = vi.fn();
    // Three queued mutations all flush in one batch (< PUSH_BATCH_SIZE);
    // the catch `return false`s on the first failed chunk, so the spy
    // fires exactly once regardless of queue depth.
    await seedMutation({ id: 'dm-1', aggregateId: 'a-1' });
    await seedMutation({ id: 'dm-2', aggregateId: 'a-2' });
    await seedMutation({ id: 'dm-3', aggregateId: 'a-3' });
    await renderSettled(() => renderWithMismatch(onDeviceMismatch));
    fake.pushImpl = async () => {
      throw new SyncApiError('DEVICE_MISMATCH', 'Device id mismatch', 403, 'trace-dm');
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(onDeviceMismatch).toHaveBeenCalledTimes(1));
    // Give any stray microtask-deferred reruns a chance to fire; the
    // count must stay at one.
    await act(async () => {
      await Promise.resolve();
    });
    expect(onDeviceMismatch).toHaveBeenCalledTimes(1);
    // The failed flush advances nothing: all three queued mutations stay
    // pending and the cursor is untouched (`return false` from the push
    // catch). Guards against a regression that swallows the error and
    // drains/advances state.
    const remaining = await listPendingMutations();
    expect(remaining).toHaveLength(3);
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('seed-cursor');
  });
});


// FRESHNESS_HEAD_INVALID park. A push
// whose freshness head the server rejects returns a 400
// `SyncApiError('FRESHNESS_HEAD_INVALID')`. Only a buggy/untrusted client ever
// sends a malformed head, so the client parks the whole rejected batch as
// `failed-error` (a terminal status `listPendingMutations()` excludes) instead
// of retrying it forever, and surfaces it in the sync inspector via
// `listFailedErrors()`.
describe('SyncProvider — FRESHNESS_HEAD_INVALID park', () => {
  useSyncTestHooks();

  it('parks the rejected batch as failed-error and never resends it on a later poll', async () => {
    await seedMutation({ id: 'fh-1', aggregateId: 'a-1' });
    await seedMutation({ id: 'fh-2', aggregateId: 'a-2' });
    await renderSettled(renderProvider);

    fake.pushImpl = async () => {
      throw new SyncApiError('FRESHNESS_HEAD_INVALID', 'freshnessHead invalid', 400, 'trace-fh');
    };

    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
      await Promise.resolve();
    });

    // The whole batch is parked failed-error and drops out of the pending queue.
    await waitFor(async () => {
      expect(await listFailedErrors()).toHaveLength(2);
    });
    expect(await listPendingMutations()).toHaveLength(0);
    // No reason label is stamped — the union has no slot for a batch-level
    // freshness-head failure.
    for (const m of await listFailedErrors()) {
      expect(m.reason).toBeUndefined();
    }

    // A subsequent flush (poll tick) sources work from listPendingMutations,
    // which excludes the parked batch, so the transport is never re-hit for it.
    fake.pushImpl = async () => {
      throw new Error('flushPending must not resend a parked failed-error batch');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
      await Promise.resolve();
    });
    expect(await listFailedErrors()).toHaveLength(2);
    expect(await listPendingMutations()).toHaveLength(0);
  });

  it('does not flip the badge to synced on a later flush/poll tick while the parked batch lingers', async () => {
    await seedMutation({ id: 'fh-3', aggregateId: 'a-3' });
    await renderSettled(renderProvider);

    fake.pushImpl = async () => {
      throw new SyncApiError('FRESHNESS_HEAD_INVALID', 'freshnessHead invalid', 400, 'trace-fh');
    };

    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
      await Promise.resolve();
    });

    // The park drops the batch out of the pending queue but leaves it un-sent.
    await waitFor(async () => {
      expect(await listFailedErrors()).toHaveLength(1);
    });
    expect(await listPendingMutations()).toHaveLength(0);

    // A subsequent flush reads an EMPTY pending queue. Without the truthfulness
    // guard it would fall through to {kind:'synced'} and hide the parked
    // failure; it must stay in a non-synced (error) state instead.
    fake.pushImpl = async () => {
      throw new Error('flushPending must not resend a parked failed-error batch');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('error'),
    );
    expect(screen.getByTestId('state')).not.toHaveTextContent('synced');
    expect(await listFailedErrors()).toHaveLength(1);
  });

  it('does not flip the badge to synced after a subsequent successful PUSH of a different mutation while the parked batch lingers', async () => {
    await seedMutation({ id: 'fh-push-a', aggregateId: 'a-push-a' });
    await renderSettled(renderProvider);

    fake.pushImpl = async () => {
      throw new SyncApiError('FRESHNESS_HEAD_INVALID', 'freshnessHead invalid', 400, 'trace-fh');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
      await Promise.resolve();
    });
    await waitFor(async () => {
      expect(await listFailedErrors()).toHaveLength(1);
    });
    expect(await listPendingMutations()).toHaveLength(0);

    // A NEW edit pushes cleanly. Its success empties the pending queue, but
    // the earlier parked batch is still un-sent — the post-push tail must not
    // read the empty queue as `synced` and hide the parked failure.
    fake.pushImpl = async (args) => ({
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
    await seedMutation({ id: 'new-push-1', aggregateId: 'a-push-new' });
    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
      await Promise.resolve();
    });

    // The new mutation applied and left the pending queue...
    await waitFor(async () => {
      expect(await listPendingMutations()).toHaveLength(0);
    });
    // ...but the parked failed-error must keep the badge off 'synced'.
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('error'),
    );
    expect(screen.getByTestId('state')).not.toHaveTextContent('synced');
    expect(await listFailedErrors()).toHaveLength(1);
  });

  it('does not flip the badge to synced after a subsequent successful PULL while the parked batch lingers', async () => {
    await seedMutation({ id: 'fh-pull-a', aggregateId: 'a-pull-a' });
    await renderSettled(renderProvider);

    fake.pushImpl = async () => {
      throw new SyncApiError('FRESHNESS_HEAD_INVALID', 'freshnessHead invalid', 400, 'trace-fh');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
      await Promise.resolve();
    });
    await waitFor(async () => {
      expect(await listFailedErrors()).toHaveLength(1);
    });
    expect(await listPendingMutations()).toHaveLength(0);

    // A successful pull (poll tick / syncRoundTrip runs pull after the flush)
    // must not flip the badge to 'synced' over the lingering parked batch.
    let pulled = false;
    fake.pullImpl = async () => {
      pulled = true;
      return { changes: [], newCursor: 'seed-cursor', hasMore: false };
    };
    // The empty-queue push flush must not resend the parked batch.
    fake.pushImpl = async () => {
      throw new Error('flushPending must not resend a parked failed-error batch');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('syncRoundTrip'));
      await Promise.resolve();
    });
    await waitFor(() => expect(pulled).toBe(true));
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('error'),
    );
    expect(screen.getByTestId('state')).not.toHaveTextContent('synced');
    expect(await listFailedErrors()).toHaveLength(1);
  });
});


// The FRESHNESS_HEAD_INVALID park
// branch above is widened to PERMANENT_PUSH_REJECTION_CODES so the server's
// new UNRECOVERABLE push bounds (an out-of-window timestamp →
// TIMESTAMP_OUT_OF_SERVER_WINDOW, a too-new schemaVersion →
// SCHEMA_VERSION_TOO_NEW, a too-far-ahead freshness counter, a non-envelope
// payload → ENCRYPTION_REQUIRED) also park instead of hot-looping the
// endpoint. The timestamp bound is in that set because a queued mutation's
// `timestamp` is frozen at enqueue time and never re-stamped, so a rejected
// batch can never clear by retry. The quota 429
// (PUSH_QUOTA_EXCEEDED) is deliberately NOT in that set — it is a transient
// budget condition that clears on the next UTC day and must keep retrying on
// the normal poll cadence.
describe('SyncProvider — permanent push rejection park', () => {
  useSyncTestHooks();

  it.each([
    ['TIMESTAMP_OUT_OF_SERVER_WINDOW (timestamp bound)', 'TIMESTAMP_OUT_OF_SERVER_WINDOW', 400],
    ['SCHEMA_VERSION_TOO_NEW (schemaVersion bound)', 'SCHEMA_VERSION_TOO_NEW', 400],
    ['FRESHNESS_COUNTER_TOO_FAR_AHEAD', 'FRESHNESS_COUNTER_TOO_FAR_AHEAD', 400],
    ['ENCRYPTION_REQUIRED (non-envelope payload)', 'ENCRYPTION_REQUIRED', 403],
  ])('parks a %s rejection as failed-error and never resends it on a later poll', async (_label, code, status) => {
    await seedMutation({ id: `perm-${code}-1`, aggregateId: `a-${code}-1` });
    await renderSettled(renderProvider);

    fake.pushImpl = async () => {
      throw new SyncApiError(code, `${code} rejection`, status, 'trace-perm');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
      await Promise.resolve();
    });

    await waitFor(async () => {
      expect(await listFailedErrors()).toHaveLength(1);
    });
    expect(await listPendingMutations()).toHaveLength(0);

    // A later poll tick sources work from listPendingMutations, which
    // excludes the parked batch — the transport must never be re-hit for it.
    fake.pushImpl = async () => {
      throw new Error('flushPending must not resend a parked failed-error batch');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
      await Promise.resolve();
    });
    expect(await listFailedErrors()).toHaveLength(1);
    expect(await listPendingMutations()).toHaveLength(0);
  });

  // API Gateway's stage throttle (infrastructure `apiThrottleRatePerSec` /
  // `apiThrottleBurst`) answers a burst with its OWN 429 before the Lambda
  // runs: sync-client maps that envelope-less body to
  // `SyncApiError('UPSTREAM_ERROR', …, 429)` with no Retry-After. It must be
  // treated exactly like any other transient outage — nothing parked, the pull
  // cursor untouched, no session side effect — and a later success completes.
  it('does NOT park an API-Gateway-shaped 429 (UPSTREAM_ERROR, no Retry-After) — pending survives, cursor unchanged, later success syncs', async () => {
    await seedMutation({ id: 'gw-429-1', aggregateId: 'a-gw-429-1' });
    await renderSettled(renderProvider);
    const cursorBefore = (await readDeviceMetadata())?.syncCursor;

    const gatewayThrottled = () =>
      new SyncApiError('UPSTREAM_ERROR', 'Request failed: 429', 429);
    fake.pushImpl = async () => {
      throw gatewayThrottled();
    };
    fake.pullImpl = async () => {
      throw gatewayThrottled();
    };
    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('error'),
    );
    const detail = JSON.parse(screen.getByTestId('error-detail').textContent ?? '{}');
    expect(detail.code).toBe('UPSTREAM_ERROR');
    expect(detail.status).toBe(429);
    // Not parked, cursor untouched.
    expect(await listFailedErrors()).toHaveLength(0);
    expect(await listPendingMutations()).toHaveLength(1);
    expect((await readDeviceMetadata())?.syncCursor).toBe(cursorBefore);

    // The throttle window passes: the next attempt sources the still-pending
    // mutation and completes the round trip.
    let resent = false;
    fake.pullImpl = async () => ({ changes: [], newCursor: '0', hasMore: false });
    fake.pushImpl = async (args) => {
      resent = true;
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
      fireEvent.click(screen.getByText('notifyPending'));
      await Promise.resolve();
    });
    await waitFor(() => expect(resent).toBe(true));
    await waitFor(async () => expect(await listPendingMutations()).toHaveLength(0));
    expect(await listFailedErrors()).toHaveLength(0);
  });

  it('does NOT park a quota 429 (PUSH_QUOTA_EXCEEDED) — it stays pending and is retried', async () => {
    await seedMutation({ id: 'quota-1', aggregateId: 'a-quota-1' });
    await renderSettled(renderProvider);

    fake.pushImpl = async () => {
      throw new SyncApiError('PUSH_QUOTA_EXCEEDED', 'daily mutation budget exceeded', 429, 'trace-quota');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('error'),
    );
    // Not parked: the mutation is still in the pending queue, not failed-error.
    expect(await listFailedErrors()).toHaveLength(0);
    expect(await listPendingMutations()).toHaveLength(1);

    // A later retry sources the still-pending mutation and CAN resend it.
    let resent = false;
    fake.pushImpl = async (args) => {
      resent = true;
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
      fireEvent.click(screen.getByText('notifyPending'));
      await Promise.resolve();
    });
    await waitFor(() => expect(resent).toBe(true));
    expect(await listPendingMutations()).toHaveLength(0);
  });
});


// Systemic cursor-reset invariant. `applyBootstrap`
// persists syncCursor:'0' BEFORE `clearAllStores()`, so a force
// bootstrap that fails after the wipe leaves a cursor that forces the
// next `initialSync` down the bootstrap branch instead of an
// incremental pull into a wiped store. Success is byte-unchanged (the
// final metadata write overwrites '0' with the real server cursor).
describe('SyncProvider — cursor-reset invariant', () => {
  useSyncTestHooks();

  it('persists the server cursor after a successful force bootstrap (success byte-unchanged)', async () => {
    // The mount-time pull settles to the seed cursor first; installing
    // the per-case bootstrap AFTER means the click is the only thing
    // that runs it, so its final metadata write can't be clobbered by a
    // late-resolving mount bootstrap.
    await renderSettled(renderProvider);
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-1',
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: '777',
      timestamp: new Date().toISOString(),
    });
    await act(async () => {
      fireEvent.click(screen.getByText('forceRefresh'));
    });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('777');
  });

  it('leaves syncCursor=0 when a post-clearAllStores step throws, so the next initialSync re-bootstraps instead of pulling', async () => {
    // Force-bootstrap whose post-wipe `clearMutationQueue` throws —
    // aggregates already gone, metadata write never reached. The
    // pre-wipe '0' write must survive so recovery re-bootstraps.
    // The mount-time pull settles first; the one-shot reject + per-case
    // bootstrap install AFTER so the forceRefresh click is their first
    // (and only) caller — the mount sync can't consume the one-shot.
    await renderSettled(renderProvider);
    const clearQueueSpy = vi
      .spyOn(storeModule, 'clearMutationQueue')
      .mockRejectedValueOnce(new Error('post-wipe boom'));
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-1',
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: '999',
      timestamp: new Date().toISOString(),
    });
    await act(async () => {
      fireEvent.click(screen.getByText('forceRefresh'));
    });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('0');
    expect(clearQueueSpy).toHaveBeenCalled();

    // The next initialSync (simulated by a fresh mount) must take the
    // bootstrap branch — not pull() — because the cursor is '0'.
    clearQueueSpy.mockRestore();
    let bootstrapCalls = 0;
    let pullCalls = 0;
    fake.bootstrapImpl = async () => {
      bootstrapCalls += 1;
      return {
        snapshotId: 'snap-2',
        workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
        postSnapshotMutations: [],
        syncCursor: '1000',
        timestamp: new Date().toISOString(),
      };
    };
    fake.pullImpl = async () => {
      pullCalls += 1;
      return { changes: [], newCursor: '1000', hasMore: false };
    };
    renderProvider();
    await waitFor(() => expect(bootstrapCalls).toBe(1));
    expect(pullCalls).toBe(0);
  });

  it('CURSOR_EXPIRED auto-recovery: success leaves the fresh cursor (unchanged)', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'ancient-cursor',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => {
      throw new SyncApiError('CURSOR_EXPIRED', 'Cursor expired', 409, 'trace-1');
    };
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-recovered',
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: 'fresh-cursor',
      timestamp: new Date().toISOString(),
    });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('fresh-cursor');
  });

  it('CURSOR_EXPIRED auto-recovery completes and advances the cursor even when the bootstrap quarantined a row', async () => {
    // One undecryptable row must cost this device that row only — not wedge
    // the mandatory reseed forever on the same expired cursor.
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
    await putAggregate('account', poisoned);
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'ancient-cursor',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    let pullCalls = 0;
    fake.pullImpl = async () => {
      pullCalls += 1;
      throw new SyncApiError('CURSOR_EXPIRED', 'Cursor expired', 409, 'trace-1');
    };
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-recovered',
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: 'fresh-cursor',
      timestamp: new Date().toISOString(),
      quarantined: [{ aggregateId: 'agg-poisoned', aggregateType: 'account' }],
    });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('fresh-cursor');
    // Recovered in ONE pass — the expired cursor was not retried.
    expect(pullCalls).toBe(1);
    // The poisoned aggregate's last readable local copy is still here.
    expect((await getAggregate('account', poisoned.id))?.payload).toEqual({
      name: 'Last readable copy',
    });
  });

  it('CURSOR_EXPIRED auto-recovery: a post-clearAllStores failure resets the cursor to 0', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'ancient-cursor',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    const clearQueueSpy = vi
      .spyOn(storeModule, 'clearMutationQueue')
      .mockRejectedValueOnce(new Error('post-wipe boom'));
    fake.pullImpl = async () => {
      throw new SyncApiError('CURSOR_EXPIRED', 'Cursor expired', 409, 'trace-1');
    };
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-recovered',
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: 'fresh-cursor',
      timestamp: new Date().toISOString(),
    });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    expect(clearQueueSpy).toHaveBeenCalled();
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('0');
  });
});


// Phase-aware result. `forceRefresh()` / `applyBootstrap()`
// resolve `{ ok, wiped }`. `wiped` flips true only on the line after
// `clearAllStores()` resolves: a pre-fetch throw is `wiped:false`
// (stores intact); a post-clear throw is `wiped:true`.
describe('SyncProvider — forceRefresh { ok, wiped } result', () => {
  useSyncTestHooks();

  function ResultProbe() {
    const sync = useSync();
    const [result, setResult] = useState<string>('');
    return (
      <div>
        <div data-testid="state">{sync.state.kind}</div>
        <div data-testid="force-result">{result}</div>
        <button
          onClick={async () => {
            const r = await sync.forceRefresh();
            setResult(JSON.stringify(r));
          }}
        >
          forceRefresh
        </button>
      </div>
    );
  }

  const renderResultProvider = () => renderProvider({ probe: <ResultProbe /> });

  it('resolves { ok: true, wiped: true } on a successful force bootstrap', async () => {
    await renderSettled(renderResultProvider);
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-1',
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: '5',
      timestamp: new Date().toISOString(),
    });
    await act(async () => {
      fireEvent.click(screen.getByText('forceRefresh'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('force-result')).toHaveTextContent(
        JSON.stringify({ ok: true, wiped: true }),
      ),
    );
  });

  it('resolves { ok: false, wiped: false } when bootstrap throws before the wipe (pre-fetch)', async () => {
    await renderSettled(renderResultProvider);
    fake.bootstrapImpl = async () => {
      throw new Error('network down');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('forceRefresh'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('force-result')).toHaveTextContent(
        JSON.stringify({ ok: false, wiped: false }),
      ),
    );
  });

  it('resolves { ok: false, wiped: true } when a post-clearAllStores step throws', async () => {
    // Settle the mount-time pull first. The pull branch never touches
    // `clearMutationQueue`, so installing the one-shot reject AFTER the
    // settle guarantees the forceRefresh wipe is its first (and only)
    // caller — the mount sync can no longer consume the one-shot.
    await renderSettled(renderResultProvider);
    vi.spyOn(storeModule, 'clearMutationQueue').mockRejectedValueOnce(
      new Error('post-wipe boom'),
    );
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-1',
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: '5',
      timestamp: new Date().toISOString(),
    });
    await act(async () => {
      fireEvent.click(screen.getByText('forceRefresh'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('force-result')).toHaveTextContent(
        JSON.stringify({ ok: false, wiped: true }),
      ),
    );
  });
});


// Regression — the mandatory `CURSOR_EXPIRED` reseed inside `pull()`
// must propagate the `applyBootstrap` outcome. `applyBootstrap` swallows
// its failure into `{ ok:false }` (it RETURNS, never throws), so a hard-
// coded `return true` would report sync success even when the reseed
// failed and the store is wiped/stale. `pull()`/`syncRoundTrip()` must
// report FAILURE on a failed reseed, SUCCESS only on a successful one.
describe('SyncProvider — CURSOR_EXPIRED reseed propagates failure', () => {
  useSyncTestHooks();

  function RoundTripProbe() {
    const sync = useSync();
    const [result, setResult] = useState<string>('');
    return (
      <div>
        <div data-testid="state">{sync.state.kind}</div>
        <div data-testid="roundtrip-result">{result}</div>
        <button
          onClick={async () => {
            const r = await sync.syncRoundTrip();
            setResult(JSON.stringify(r));
          }}
        >
          syncRoundTrip
        </button>
      </div>
    );
  }

  const renderRoundTripProvider = () => renderProvider({ probe: <RoundTripProbe /> });

  it('round-trip reports FAILURE when the CURSOR_EXPIRED reseed throws after the wipe ({ ok:false, wiped:true })', async () => {
    await renderSettled(renderRoundTripProvider);
    // From now on pull rejects CURSOR_EXPIRED; the auto-reseed bootstrap
    // wipes the stores then `clearMutationQueue` throws — wiped:true.
    fake.pullImpl = async () => {
      throw new SyncApiError('CURSOR_EXPIRED', 'Cursor expired', 409, 'trace-1');
    };
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-1',
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: '999',
      timestamp: new Date().toISOString(),
    });
    vi.spyOn(storeModule, 'clearMutationQueue').mockRejectedValueOnce(
      new Error('post-wipe boom'),
    );
    await act(async () => {
      fireEvent.click(screen.getByText('syncRoundTrip'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('roundtrip-result')).toHaveTextContent(
        '{"ok":false',
      ),
    );
  });

  it('round-trip reports FAILURE when the CURSOR_EXPIRED reseed throws before the wipe ({ ok:false, wiped:false })', async () => {
    await renderSettled(renderRoundTripProvider);
    fake.pullImpl = async () => {
      throw new SyncApiError('CURSOR_EXPIRED', 'Cursor expired', 409, 'trace-1');
    };
    // Bootstrap throws before `clearAllStores()` — stores intact,
    // wiped:false. The reseed still failed → round-trip must fail.
    fake.bootstrapImpl = async () => {
      throw new Error('network down');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('syncRoundTrip'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('roundtrip-result')).toHaveTextContent(
        '{"ok":false',
      ),
    );
  });

  it('round-trip still reports SUCCESS when the CURSOR_EXPIRED reseed succeeds (success path unchanged)', async () => {
    await renderSettled(renderRoundTripProvider);
    fake.pullImpl = async () => {
      throw new SyncApiError('CURSOR_EXPIRED', 'Cursor expired', 409, 'trace-1');
    };
    fake.bootstrapImpl = async () => ({
      snapshotId: 'snap-recovered',
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: 'fresh-cursor',
      timestamp: new Date().toISOString(),
    });
    await act(async () => {
      fireEvent.click(screen.getByText('syncRoundTrip'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('roundtrip-result')).toHaveTextContent(
        JSON.stringify({ ok: true }),
      ),
    );
  });
});


describe('SyncProvider — zero-knowledge freshness rollback', () => {
  useSyncTestHooks('hh-1');

  it('surfaces rollback-detected when pull throws FreshnessRollbackError', async () => {
    // Seed a non-zero cursor so the mount-time initialSync takes the
    // incremental `pull()` branch (not bootstrap). The transport then
    // rejects with FreshnessRollbackError — the same throw the HTTP
    // client raises before any local write.
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => {
      throw new FreshnessRollbackError(3, 5);
    };
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('rollback-detected'),
    );
    // Reject-before-write: no local aggregates were touched.
    expect(await listAggregates('account')).toEqual([]);
  });

  it('surfaces rollback-detected when bootstrap throws FreshnessRollbackError (no wipe)', async () => {
    // Cursor '0' → initialSync takes the bootstrap branch.
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: '0',
      lastSyncedAt: null,
      displayName: 'This device',
    });
    await putAggregate('account', {
      id: 'pre-existing',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: new Date().toISOString(),
      deviceId: 'dev-test',
      payload: { name: 'Keep me' },
    });
    fake.bootstrapImpl = async () => {
      // The HTTP client verifies freshness inside bootstrap() and throws
      // BEFORE the clearAllStores() wipe, so local data must survive.
      throw new FreshnessRollbackError(2, 4);
    };
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('rollback-detected'),
    );
    const kept = await getAggregate('account', 'pre-existing');
    expect(kept?.payload).toEqual({ name: 'Keep me' });
  });
});


// The SAME `rollback-detected` reaction the freshness
// tests above prove, now triggered by `UnauthenticatedPayloadError` — the
// dedicated error `HttpSyncClient` throws (before returning) when a served
// pull/bootstrap payload isn't a strict envelope that decrypts. This suite
// fakes the transport throwing exactly that error (mirroring how the
// freshness suite fakes `FreshnessRollbackError`) to prove SyncContext's
// reject-before-write + classification, independent of the real WebCrypto
// decrypt path (covered separately in sync-client.test.ts).
describe('SyncProvider — unauthenticated served payload', () => {
  useSyncTestHooks();

  it('pull: rejects before any local write — no aggregates written, cursor/deviceMetadata unchanged, badge rollback-detected', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    const before = await readDeviceMetadata();
    fake.pullImpl = async () => {
      throw new UnauthenticatedPayloadError('pull', 'not-envelope');
    };
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('rollback-detected'),
    );
    // Reject-before-write: no local aggregates were touched...
    expect(await listAggregates('account')).toEqual([]);
    // ...and the persisted cursor / deviceMetadata never advanced past the
    // poisoned page (a test that only checks the badge would pass even if
    // the cycle silently skipped this row forever).
    const after = await readDeviceMetadata();
    expect(after).toEqual(before);
  });

  it('bootstrap: rejects before the local wipe — pre-existing aggregate survives, badge rollback-detected', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: '0',
      lastSyncedAt: null,
      displayName: 'This device',
    });
    await putAggregate('account', {
      id: 'pre-existing',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: new Date().toISOString(),
      deviceId: 'dev-test',
      payload: { name: 'Keep me' },
    });
    fake.bootstrapImpl = async () => {
      // The HTTP client's payload guard throws BEFORE the clearAllStores()
      // wipe, matching the freshness-rejection reject-before-write guarantee.
      throw new UnauthenticatedPayloadError('bootstrap', 'decrypt-failed');
    };
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('rollback-detected'),
    );
    const kept = await getAggregate('account', 'pre-existing');
    expect(kept?.payload).toEqual({ name: 'Keep me' });
  });

  // Distinguish a forged/undecryptable envelope from a plain network error:
  // only the dedicated error classifies as rollback-detected. A run-of-the-
  // mill transport failure must still surface the ordinary error badge, not
  // borrow the security-specific one.
  it('a plain network error during pull does NOT surface rollback-detected', async () => {
    await writeDeviceMetadata({
      deviceId: 'dev-test',
      syncCursor: 'cursor-1',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      displayName: 'This device',
    });
    fake.pullImpl = async () => {
      throw new Error('network down');
    };
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    expect(screen.getByTestId('state')).not.toHaveTextContent('rollback-detected');
  });

  // The forced-export transport (createExportSyncTransport / use-profile-
  // export.ts) runs its own HttpSyncClient outside this provider's poll, so a
  // rollback-detected rejection it catches can only reach the shared badge
  // through `notifyRollbackDetectedOutsideSync`. Without SyncProvider
  // registering the handler here, that export-time rejection would leave the
  // badge on whatever it last showed (typically `synced`) even though a
  // tampered/unauthenticated payload was just refused.
  it('notifyRollbackDetectedOutsideSync flips the badge while SyncProvider is mounted', async () => {
    // This describe block's earlier cases install throwing pull/bootstrap
    // stubs and this block has no per-test reset (unlike the other describe
    // blocks in this file), so restore both to a clean success path first —
    // otherwise this test would inherit a leftover throwing stub and reach
    // `rollback-detected` on its own, defeating the point of the assertion
    // below (that ONLY the explicit notify call flips the badge).
    fake.pullImpl = async () => ({ changes: [], newCursor: '0', hasMore: false });
    fake.bootstrapImpl = async () => ({
      snapshotId: null,
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: '0',
      timestamp: new Date().toISOString(),
    });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    act(() => {
      notifyRollbackDetectedOutsideSync();
    });
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('rollback-detected'),
    );
  });
});
