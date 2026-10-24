// SyncProvider failure parks and recovery: device mismatch, permanent push rejections, cursor reset, reseed, rollback detection.
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


// A push whose JWT device id no longer matches this client's gets a 403 DEVICE_MISMATCH; the push catch hands off to the
// host's `onDeviceMismatch` once and returns false, so a multi-batch queue still yields one callback per failed flush.
describe('SyncProvider — DEVICE_MISMATCH recovery', () => {
  useSyncTestHooks();

  const renderWithMismatch = (onDeviceMismatch: () => void | Promise<void>) =>
    renderProvider({ onDeviceMismatch });

  it('invokes onDeviceMismatch exactly once when push returns DEVICE_MISMATCH', async () => {
    const onDeviceMismatch = vi.fn();
    await seedMutation();
    // Settle the mount-time pull first so the mount sync cannot double-count the spy.
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
    // The failed flush must not drain the queue or move the cursor.
    const remaining = await listPendingMutations();
    expect(remaining).toHaveLength(1);
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('seed-cursor');
  });

  it('invokes onDeviceMismatch only once even with multiple queued mutations (single failed flush batch)', async () => {
    const onDeviceMismatch = vi.fn();
    await seedMutation({ id: 'dm-1', aggregateId: 'a-1' });
    await seedMutation({ id: 'dm-2', aggregateId: 'a-2' });
    await seedMutation({ id: 'dm-3', aggregateId: 'a-3' });
    await renderSettled(() => renderWithMismatch(onDeviceMismatch));
    fake.pushImpl = async () => {
      throw new SyncApiError('DEVICE_MISMATCH', 'Device id mismatch', 403, 'trace-dm');
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(onDeviceMismatch).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onDeviceMismatch).toHaveBeenCalledTimes(1);
    const remaining = await listPendingMutations();
    expect(remaining).toHaveLength(3);
    const meta = await readDeviceMetadata();
    expect(meta?.syncCursor).toBe('seed-cursor');
  });
});


// FRESHNESS_HEAD_INVALID: only a buggy or untrusted client sends a malformed head, so the whole rejected batch is parked as
// `failed-error` (excluded from `listPendingMutations()`) instead of being retried forever.
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

    await waitFor(async () => {
      expect(await listFailedErrors()).toHaveLength(2);
    });
    expect(await listPendingMutations()).toHaveLength(0);
    for (const m of await listFailedErrors()) {
      expect(m.reason).toBeUndefined();
    }

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

  it('keeps the badge off synced through a later poll tick, a successful push of another mutation and a successful pull', async () => {
    await seedMutation({ id: 'fh-3', aggregateId: 'a-3' });
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

    const expectParkedBadge = async () => {
      await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
      expect(screen.getByTestId('state')).not.toHaveTextContent('synced');
      expect(await listFailedErrors()).toHaveLength(1);
    };

    fake.pushImpl = async () => {
      throw new Error('flushPending must not resend a parked failed-error batch');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('notifyPending'));
      await Promise.resolve();
    });
    await expectParkedBadge();

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
    await waitFor(async () => {
      expect(await listPendingMutations()).toHaveLength(0);
    });
    await expectParkedBadge();

    let pulled = false;
    fake.pullImpl = async () => {
      pulled = true;
      return { changes: [], newCursor: 'seed-cursor', hasMore: false };
    };
    fake.pushImpl = async () => {
      throw new Error('flushPending must not resend a parked failed-error batch');
    };
    await act(async () => {
      fireEvent.click(screen.getByText('syncRoundTrip'));
      await Promise.resolve();
    });
    await waitFor(() => expect(pulled).toBe(true));
    await expectParkedBadge();
  });
});


// PERMANENT_PUSH_REJECTION_CODES covers the server's unrecoverable push bounds: a queued mutation's `timestamp` is frozen
// at enqueue, so these batches never clear by retry. The quota 429 (PUSH_QUOTA_EXCEEDED) is transient and keeps retrying.
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

  // API Gateway's stage throttle answers a burst with its own 429 before the Lambda runs; sync-client maps that envelope-less
  // body to `SyncApiError('UPSTREAM_ERROR', …, 429)` with no Retry-After, a transient outage: nothing parked, cursor untouched.
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
    expect(await listFailedErrors()).toHaveLength(0);
    expect(await listPendingMutations()).toHaveLength(1);
    expect((await readDeviceMetadata())?.syncCursor).toBe(cursorBefore);

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
    expect(await listFailedErrors()).toHaveLength(0);
    expect(await listPendingMutations()).toHaveLength(1);

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


// `applyBootstrap` persists syncCursor '0' before `clearAllStores()`, so a force bootstrap that fails after the wipe makes
// the next `initialSync` bootstrap instead of pulling into a wiped store.
describe('SyncProvider — cursor-reset invariant', () => {
  useSyncTestHooks();

  it('persists the server cursor after a successful force bootstrap (success byte-unchanged)', async () => {
    // Settle the mount-time pull first so the click is the only caller of the per-case bootstrap.
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
    // One undecryptable row must cost this device only that row, not wedge the reseed on the same expired cursor.
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
    expect(pullCalls).toBe(1);
    expect((await getAggregate('account', poisoned.id))?.payload).toEqual({
      name: 'Last readable copy',
    });
  });
});


// `forceRefresh()` resolves `{ ok, wiped }`; `wiped` flips true only after `clearAllStores()` resolves, so a pre-fetch throw
// is `wiped:false` and a post-clear throw is `wiped:true`.
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
    // Settle the mount pull first so the forceRefresh wipe is the one-shot rejection's only caller.
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


// The CURSOR_EXPIRED reseed inside `pull()` must propagate the `applyBootstrap` outcome, which returns `{ ok:false }` rather
// than throwing; a hard-coded `return true` would report success after a failed reseed.
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

  it('round-trip reports FAILURE when the CURSOR_EXPIRED reseed throws before the wipe ({ ok:false, wiped:false })', async () => {
    await renderSettled(renderRoundTripProvider);
    fake.pullImpl = async () => {
      throw new SyncApiError('CURSOR_EXPIRED', 'Cursor expired', 409, 'trace-1');
    };
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
    expect(await listAggregates('account')).toEqual([]);
  });

  it('surfaces rollback-detected when bootstrap throws FreshnessRollbackError (no wipe)', async () => {
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


// `UnauthenticatedPayloadError`, thrown by `HttpSyncClient` for a served payload that is not a strict envelope that
// decrypts, drives the same `rollback-detected` reaction as the freshness errors above.
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
    expect(await listAggregates('account')).toEqual([]);
    // The cursor and deviceMetadata must not advance past the poisoned page.
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
      throw new UnauthenticatedPayloadError('bootstrap', 'decrypt-failed');
    };
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('rollback-detected'),
    );
    const kept = await getAggregate('account', 'pre-existing');
    expect(kept?.payload).toEqual({ name: 'Keep me' });
  });

  // Only the dedicated error classifies as rollback-detected; a plain transport failure shows the ordinary error badge.
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

  // The forced-export transport runs its own HttpSyncClient outside the poll, so its rollback-detected rejection reaches the
  // shared badge only through `notifyRollbackDetectedOutsideSync`.
  it('notifyRollbackDetectedOutsideSync flips the badge while SyncProvider is mounted', async () => {
    // Earlier cases here leave throwing stubs and this block has no per-test reset, so restore a clean success path first or the badge would reach rollback-detected on its own.
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
