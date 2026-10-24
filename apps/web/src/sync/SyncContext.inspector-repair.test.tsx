// SyncProvider sync-inspector mutation lists, rejection summary and the auto-repair reject loop.
import 'fake-indexeddb/auto';
import { screen, waitFor, act, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAggregate,
  listFailedConflicts,
  putAggregate,
  listPendingMutations,
  removeMutation,
  updateMutationStatus,
} from '../db/store';
import { type PendingMutation } from '../db/types';
import { redactArgs } from '../lib/diagnostics/redact';
import { type PushedMutationRejected, type PushResponseBody } from './types';
import { type SyncTransport } from './sync-client';
import { clear as clearDiagnostics, getEntries } from '../lib/diagnostics/logger';
import { useSync } from './SyncContext';
import { fake, renderProvider, seedMutation, renderSettled, useSyncTestHooks } from './sync-context.test-harness';

vi.mock('./mock-sync', async () => (await import('./sync-context.test-fake')).mockSyncModule);


// The mutation lists on the context value for the read-only inspector, plus the redaction-surviving `idFragment` on the rejection summary.
describe('SyncProvider — inspector mutation lists + rejection summary', () => {
  useSyncTestHooks('hh-1');

  let capturedConflicts: readonly PendingMutation[] = [];
  function InspectorProbe() {
    const sync = useSync();
    capturedConflicts = sync.conflictMutations;
    return (
      <div>
        <div data-testid="state">{sync.state.kind}</div>
        <div data-testid="conflicts">{sync.conflictCount}</div>
        <button onClick={() => void sync.notifyPending()}>notifyPending</button>
        <button onClick={() => void sync.retryNow()}>retryNow</button>
      </div>
    );
  }
  const renderInspectorProvider = () => renderProvider({ probe: <InspectorProbe /> });

  it('exposes the rejected row on conflictMutations and keeps a stable array reference across a no-change refresh', async () => {
    const m = await seedMutation({ operation: 'update', expectedVersion: 3 });
    await renderSettled(renderInspectorProvider);
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
    await waitFor(() => expect(screen.getByTestId('conflicts')).toHaveTextContent('1'));

    const first = capturedConflicts;
    expect(first.map((c) => c.id)).toContain(m.id);
    expect(first.find((c) => c.id === m.id)?.reason).toBe('CONFLICT');

    // A no-change refresh must not churn the array reference (content-equality gate).
    fake.pullImpl = async () => ({ changes: [], newCursor: 'seed-cursor', hasMore: false });
    await act(async () => {
      fireEvent.click(screen.getByText('retryNow'));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
    expect(capturedConflicts).toBe(first);
  });

  it.each([
    {
      change: 'the reason of the same row changes',
      mutate: async (m: PendingMutation) => {
        await updateMutationStatus(m.id, 'failed-conflict', 'NOT_FOUND');
        return { id: m.id, reason: 'NOT_FOUND' };
      },
    },
    {
      // Same length, status, expectedVersion and reason: only the id differs, so a stale array would show the old row.
      change: 'a different mutation replaces the row',
      mutate: async (m: PendingMutation) => {
        await removeMutation(m.id);
        const other = await seedMutation({ operation: 'update', expectedVersion: 3, status: 'failed-conflict' });
        await updateMutationStatus(other.id, 'failed-conflict', 'CONFLICT');
        return { id: other.id, reason: 'CONFLICT' };
      },
    },
  ])('publishes a new conflict list when $change', async ({ mutate }) => {
    const m = await seedMutation({ operation: 'update', expectedVersion: 3 });
    await renderSettled(renderInspectorProvider);
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
    await waitFor(() => expect(screen.getByTestId('conflicts')).toHaveTextContent('1'));
    const first = capturedConflicts;

    const expected = await mutate(m);
    fireEvent.click(screen.getByText('retryNow'));
    await waitFor(() => expect(capturedConflicts).not.toBe(first));
    expect(capturedConflicts).toHaveLength(1);
    expect(capturedConflicts[0]).toMatchObject(expected);
  });

  it('degrades the rejection summary for a short / non-hex aggregateId — no id fragment, never throws', async () => {
    // A non-hex aggregateId yields an empty fragment: the summary carries type/op/versions but no correlator.
    const m = await seedMutation({ operation: 'update', expectedVersion: 3, aggregateId: 'zz' });
    await renderSettled(renderInspectorProvider);
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

    const why = getEntries()
      .filter((e) => e.source === 'sync')
      .find((e) => e.message.includes('push rejected'));
    expect(why).toBeDefined();
    expect(why?.detail).toContain('CONFLICT');
    expect(why?.detail).toContain('server v7');
    expect(why?.detail).toMatch(/account\/update \(local v3/);
    clearDiagnostics();
  });

  it('keeps the id fragment redaction-surviving for a short all-digit hex prefix (hardening)', async () => {
    // A 7-digit hex prefix ('1234567') returned raw would match the redactor's DIGIT_RUN_RE and be masked, defeating the
    // correlator; idFragment dash-splits it ('1234-567').
    const m = await seedMutation({
      operation: 'update',
      expectedVersion: 3,
      aggregateId: '1234567',
    });
    await renderSettled(renderInspectorProvider);
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

    const why = getEntries()
      .filter((e) => e.source === 'sync')
      .find((e) => e.message.includes('push rejected'));
    expect(why).toBeDefined();
    // `why.detail` is already redacted output, so the fragment's presence proves it cleared the redactor.
    expect(why?.detail).toContain('1234-567');
    expect(why?.detail).not.toContain('[redacted]');
    expect(redactArgs(['1234-567'])).toContain('1234-567');
    expect(redactArgs(['1234-567'])).not.toContain('[redacted]');
    expect(redactArgs(['1234567'])).toContain('[redacted]');
    clearDiagnostics();
  });

  it('degrades the rejection summary when the rejected mutationId is absent from the pushed chunk (local undefined) — no fragment, never throws', async () => {
    // The server also rejects an id never in the chunk, so `local` is undefined and idFragment(undefined) is ''; the summary must fall back to '?' and not throw.
    await seedMutation({ operation: 'update', expectedVersion: 3 });
    await renderSettled(renderInspectorProvider);
    clearDiagnostics();
    fake.pushImpl = async (args) => ({
      applied: args.mutations.map((mm) => ({
        status: 'applied' as const,
        mutationId: mm.id,
        aggregateId: mm.aggregateId,
        newVersion: mm.expectedVersion + 1,
        newUpdatedAt: new Date().toISOString(),
      })),
      rejected: [
        {
          status: 'rejected' as const,
          mutationId: 'ghost-not-in-chunk',
          aggregateId: 'unused',
          reason: 'CONFLICT' as const,
          currentVersion: 7,
          currentUpdatedAt: new Date().toISOString(),
          currentDeletedAt: null,
        },
      ],
      syncCursor: '0',
    });
    fireEvent.click(screen.getByText('notifyPending'));
    // Wait for the diagnostics entry, not the 'synced' badge: the queue drains cleanly, so 'synced' is already true from mount
    // and would race the repair loop's async IDB work before `recordSyncWarn` lands the line.
    const why = await waitFor(() => {
      const e = getEntries()
        .filter((entry) => entry.source === 'sync')
        .find((entry) => entry.message.includes('push rejected'));
      expect(e).toBeDefined();
      return e;
    });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(await listPendingMutations()).toHaveLength(0);
    expect(why?.detail).toContain('CONFLICT');
    expect(why?.detail).toContain('?/?');
    expect(why?.detail).toContain('local v?');
    expect(why?.detail).toContain('server v7');
    clearDiagnostics();
  });
});


describe('SyncProvider — auto-repair reject loop', () => {
  let pushed: PendingMutation[][] = [];
  let repairConflicts: readonly PendingMutation[] = [];

  function applyAll(args: Parameters<SyncTransport['push']>[0]): PushResponseBody {
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
  }

  useSyncTestHooks('hh-1');

  beforeEach(async () => {
    pushed = [];
    repairConflicts = [];
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      return applyAll(args);
    };
    fake.pullImpl = async () => ({ changes: [], newCursor: 'seed-cursor', hasMore: false });
  });
  function RepairProbe() {
    const sync = useSync();
    repairConflicts = sync.conflictMutations;
    return (
      <div>
        <div data-testid="state">{sync.state.kind}</div>
        <div data-testid="conflicts">{sync.conflictCount}</div>
        <div data-testid="pending">{sync.pendingCount}</div>
        <button onClick={() => void sync.notifyPending()}>notifyPending</button>
        <button onClick={() => void sync.retryNow()}>retryNow</button>
        <button
          onClick={() => repairConflicts[0] && void sync.resolveConflict(repairConflicts[0], 'keep')}
        >
          keep
        </button>
        <button
          onClick={() => repairConflicts[0] && void sync.resolveConflict(repairConflicts[0], 'discard')}
        >
          discard
        </button>
      </div>
    );
  }
  const renderRepairProvider = () => renderProvider({ probe: <RepairProbe /> });

  function rejectWith(
    over: Partial<PushedMutationRejected> & { mutationId: string; aggregateId: string },
  ): PushedMutationRejected {
    return {
      status: 'rejected',
      reason: 'CONFLICT',
      currentVersion: 0,
      currentUpdatedAt: '2026-07-02T00:00:00.000Z',
      currentDeletedAt: null,
      ...over,
    };
  }

  it('drops a delete rejected NOT_FOUND with no user action (silent)', async () => {
    const m = await seedMutation({ operation: 'delete', expectedVersion: 4 });
    await renderSettled(renderRepairProvider);
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      return {
        applied: [],
        rejected: [rejectWith({ mutationId: m.id, aggregateId: m.aggregateId, reason: 'NOT_FOUND' })],
        syncCursor: '0',
      };
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(async () => {
      expect(await listPendingMutations()).toHaveLength(0);
    });
    expect(await listFailedConflicts()).toHaveLength(0);
  });

  it('drops the WHOLE stack for a create-over-tombstone whose local edits end in a delete', async () => {
    // A created-then-updated-then-deleted draft the server already tombstoned must clear every queued row in one pass; a
    // single-row drop would strand the `update`, which the next flush would escalate to failed-conflict.
    const create = await seedMutation({
      id: 'c-1',
      operation: 'create',
      expectedVersion: 0,
      aggregateId: 'agg-train',
      timestamp: 1000,
    });
    await seedMutation({
      id: 'u-1',
      operation: 'update',
      expectedVersion: 1,
      aggregateId: 'agg-train',
      timestamp: 1001,
    });
    await seedMutation({
      id: 'd-1',
      operation: 'delete',
      expectedVersion: 2,
      aggregateId: 'agg-train',
      timestamp: 1002,
    });
    await renderSettled(renderRepairProvider);
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      const head = args.mutations[0];
      if (head.id === create.id) {
        return {
          applied: [],
          rejected: [
            rejectWith({
              mutationId: create.id,
              aggregateId: 'agg-train',
              reason: 'CONFLICT',
              currentVersion: 3,
              currentDeletedAt: '2026-07-01T00:00:00.000Z',
            }),
          ],
          syncCursor: '0',
        };
      }
      return applyAll(args);
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(async () => {
      expect(await listPendingMutations()).toHaveLength(0);
    });
    expect(await listFailedConflicts()).toHaveLength(0);
    expect(pushed.flat().find((p) => p.id !== create.id)).toBeUndefined();
    expect(pushed.flat().some((p) => p.operation === 'update')).toBe(false);
  });

  it('silently re-bases an optimistic-inflation conflict and the re-based push lands', async () => {
    await putAggregate('account', {
      id: 'agg-1',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 13,
      updatedAt: '2026-07-02T00:00:00.000Z',
      deviceId: 'dev-1',
      payload: { name: 'Inflated' },
    });
    const m = await seedMutation({ operation: 'update', expectedVersion: 12, aggregateId: 'agg-1' });
    await renderSettled(renderRepairProvider);
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      const head = args.mutations[0];
      if (head.id === m.id) {
        return {
          applied: [],
          rejected: [rejectWith({ mutationId: m.id, aggregateId: 'agg-1', currentVersion: 10 })],
          syncCursor: '0',
        };
      }
      return applyAll(args);
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(async () => {
      expect(await listPendingMutations()).toHaveLength(0);
    });
    expect(await listFailedConflicts()).toHaveLength(0);
    const rebased = pushed.flat().find((p) => p.expectedVersion === 10);
    expect(rebased).toBeDefined();
    expect(rebased?.id).not.toBe(m.id);
  });

  it('escalates a server-ahead conflict, persisting currentVersion/currentUpdatedAt, and the reason survives', async () => {
    const m = await seedMutation({ operation: 'update', expectedVersion: 10 });
    await renderSettled(renderRepairProvider);
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      return {
        applied: [],
        rejected: [
          rejectWith({
            mutationId: m.id,
            aggregateId: m.aggregateId,
            currentVersion: 13,
            currentUpdatedAt: '2026-07-02T09:09:09.000Z',
          }),
        ],
        syncCursor: '0',
      };
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
    const [parked] = await listFailedConflicts();
    expect(parked).toMatchObject({
      reason: 'CONFLICT',
      currentVersion: 13,
      currentUpdatedAt: '2026-07-02T09:09:09.000Z',
    });
    fireEvent.click(screen.getByText('retryNow'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
    const [still] = await listFailedConflicts();
    expect(still).toMatchObject({ reason: 'CONFLICT', currentVersion: 13 });
  });

  it('folds same-aggregate siblings into ONE parked representative and never applies the later sibling', async () => {
    await seedMutation({ id: 'sib-1', operation: 'update', expectedVersion: 10, aggregateId: 'agg-1', timestamp: 1000 });
    await seedMutation({ id: 'sib-2', operation: 'update', expectedVersion: 11, aggregateId: 'agg-1', timestamp: 1001 });
    await renderSettled(renderRepairProvider);
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      const head = args.mutations[0];
      return {
        applied: [],
        rejected: [rejectWith({ mutationId: head.id, aggregateId: 'agg-1', currentVersion: 20 })],
        syncCursor: '0',
      };
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
    expect(pushed[0]).toHaveLength(1);
    expect(await listFailedConflicts()).toHaveLength(1);
    expect(await listPendingMutations()).toHaveLength(0);
  });

  it('happy path: same-aggregate edits land in order across flush rounds (identical final state)', async () => {
    await seedMutation({ id: 'c-1', operation: 'create', expectedVersion: 0, aggregateId: 'agg-1', timestamp: 1000 });
    await seedMutation({ id: 'u-1', operation: 'update', expectedVersion: 1, aggregateId: 'agg-1', timestamp: 1001 });
    await renderSettled(renderRepairProvider);
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      return applyAll(args);
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(async () => {
      expect(await listPendingMutations()).toHaveLength(0);
    });
    expect(pushed[0]).toHaveLength(1);
    expect(pushed[0][0].id).toBe('c-1');
    expect(pushed.flat().map((m) => m.id)).toEqual(['c-1', 'u-1']);
  });

  it('keep on a create-over-live conflict re-queues as update @ currentVersion and lands', async () => {
    const m = await seedMutation({ operation: 'create', expectedVersion: 0, aggregateId: 'agg-live' });
    await renderSettled(renderRepairProvider);
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      const head = args.mutations[0];
      if (head.id === m.id) {
        return {
          applied: [],
          rejected: [rejectWith({ mutationId: m.id, aggregateId: 'agg-live', currentVersion: 2, currentDeletedAt: null })],
          syncCursor: '0',
        };
      }
      return applyAll(args);
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('conflicts')).toHaveTextContent('1'));
    fireEvent.click(screen.getByText('keep'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    const kept = pushed.flat().find((p) => p.aggregateId === 'agg-live' && p.id !== m.id);
    expect(kept).toMatchObject({ operation: 'update', expectedVersion: 2 });
    expect(await listPendingMutations()).toHaveLength(0);
  });

  it('keep heals the wedge: re-bases to the server counter, pushes forward, content advances one version', async () => {
    const m = await seedMutation({ operation: 'update', expectedVersion: 10, aggregateId: 'agg-wedge', payload: { name: 'Keep me' } });
    await renderSettled(renderRepairProvider);
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      const head = args.mutations[0];
      if (head.id === m.id) {
        return {
          applied: [],
          rejected: [rejectWith({ mutationId: m.id, aggregateId: 'agg-wedge', currentVersion: 13 })],
          syncCursor: '0',
        };
      }
      return applyAll(args);
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('conflicts')).toHaveTextContent('1'));
    fireEvent.click(screen.getByText('keep'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    const kept = pushed.flat().find((p) => p.aggregateId === 'agg-wedge' && p.id !== m.id);
    expect(kept).toMatchObject({ operation: 'update', expectedVersion: 13 });
    expect((await getAggregate('account', 'agg-wedge'))?.version).toBe(14);
    expect(await listFailedConflicts()).toHaveLength(0);
  });

  it('keep re-queues the NEWEST local intent when a later edit landed while the conflict sat parked (never drops it)', async () => {
    // "Keep mine" must carry the newest local intent: the collapse removes every queue row for the aggregate, so re-queuing
    // the parked payload A would silently delete a later edit B.
    const a = await seedMutation({
      id: 'keep-latest-a',
      operation: 'update',
      expectedVersion: 10,
      aggregateId: 'agg-keep-latest',
      payload: { name: 'A-older' },
      timestamp: 1000,
    });
    await renderSettled(renderRepairProvider);
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      const head = args.mutations[0];
      if (head.id === a.id) {
        return {
          applied: [],
          rejected: [rejectWith({ mutationId: a.id, aggregateId: 'agg-keep-latest', currentVersion: 13 })],
          syncCursor: '0',
        };
      }
      return applyAll(args);
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('conflicts')).toHaveTextContent('1'));
    await seedMutation({
      id: 'keep-latest-b',
      operation: 'update',
      expectedVersion: 11,
      aggregateId: 'agg-keep-latest',
      payload: { name: 'B-newer' },
      timestamp: 2000,
    });
    fireEvent.click(screen.getByText('keep'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    const kept = pushed
      .flat()
      .find((p) => p.aggregateId === 'agg-keep-latest' && p.id !== a.id && p.id !== 'keep-latest-b');
    expect(kept?.payload).toEqual({ name: 'B-newer' });
    expect(kept?.payload).not.toEqual({ name: 'A-older' });
    expect(kept).toMatchObject({ operation: 'update', expectedVersion: 13 });
    expect(await listPendingMutations()).toHaveLength(0);
    expect(await listFailedConflicts()).toHaveLength(0);
  });

  it('discard adopts the server copy when the pull converges (genuine remote advance)', async () => {
    const m = await seedMutation({ operation: 'update', expectedVersion: 10, aggregateId: 'agg-adopt' });
    await renderSettled(renderRepairProvider);
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      return {
        applied: [],
        rejected: [rejectWith({ mutationId: m.id, aggregateId: 'agg-adopt', currentVersion: 13 })],
        syncCursor: '0',
      };
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('conflicts')).toHaveTextContent('1'));
    fake.pullImpl = async () => ({
      changes: [
        {
          aggregateId: 'agg-adopt',
          aggregateType: 'account',
          operation: 'update',
          payload: { name: 'Server' },
          version: 13,
          schemaVersion: 1,
          updatedAt: '2026-07-02T00:00:00.000Z',
          deviceId: 'other',
        },
      ],
      newCursor: 'seed-cursor',
      hasMore: false,
    });
    fireEvent.click(screen.getByText('discard'));
    await waitFor(() => expect(screen.getByTestId('conflicts')).toHaveTextContent('0'));
    expect(await listFailedConflicts()).toHaveLength(0);
    expect((await getAggregate('account', 'agg-adopt'))?.version).toBe(13);
  });

  it('discard adopts a remote delete (the pull delivers a tombstone) and clears the parked conflict', async () => {
    // A CONFLICT carrying a tombstone reaches the generic discard convergence check, which must read the tombstone
    // (getAggregateIncludingDeleted); getAggregate filters tombstones and would leave the conflict parked behind a false "try again".
    const m = await seedMutation({ operation: 'update', expectedVersion: 10, aggregateId: 'agg-remote-del' });
    await renderSettled(renderRepairProvider);
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      return {
        applied: [],
        rejected: [
          rejectWith({
            mutationId: m.id,
            aggregateId: 'agg-remote-del',
            currentVersion: 13,
            currentUpdatedAt: '2026-07-02T00:00:00.000Z',
            currentDeletedAt: '2026-07-02T00:00:00.000Z',
          }),
        ],
        syncCursor: '0',
      };
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('conflicts')).toHaveTextContent('1'));
    fake.pullImpl = async () => ({
      changes: [
        {
          aggregateId: 'agg-remote-del',
          aggregateType: 'account',
          operation: 'delete',
          payload: {},
          version: 13,
          schemaVersion: 1,
          updatedAt: '2026-07-02T00:00:00.000Z',
          deviceId: 'other',
        },
      ],
      newCursor: 'seed-cursor',
      hasMore: false,
    });
    fireEvent.click(screen.getByText('discard'));
    await waitFor(() => expect(screen.getByTestId('conflicts')).toHaveTextContent('0'));
    expect(await listFailedConflicts()).toHaveLength(0);
    expect(await getAggregate('account', 'agg-remote-del')).toBeNull();
  });

  it('discard re-escalates on a wedge (empty log, nothing to pull) rather than silently diverging', async () => {
    const m = await seedMutation({ operation: 'update', expectedVersion: 10, aggregateId: 'agg-stuck' });
    await renderSettled(renderRepairProvider);
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      return {
        applied: [],
        rejected: [rejectWith({ mutationId: m.id, aggregateId: 'agg-stuck', currentVersion: 13 })],
        syncCursor: '0',
      };
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('conflicts')).toHaveTextContent('1'));
    fake.pullImpl = async () => ({ changes: [], newCursor: 'seed-cursor', hasMore: false });
    fireEvent.click(screen.getByText('discard'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
    expect(await listFailedConflicts()).toHaveLength(1);
  });

  it('discard re-escalates a wedge whose LOCAL version is already inflated past the server counter', async () => {
    // Optimistic version inflation can leave the local version >= the server counter, so convergence must also require the
    // pull to have written the server's true row (updatedAt === currentUpdatedAt); this wedge must re-escalate.
    await putAggregate('account', {
      id: 'agg-inflated',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 15,
      updatedAt: '2026-07-01T00:00:00.000Z',
      deviceId: 'dev-1',
      payload: { name: 'Stale draft' },
    });
    const m = await seedMutation({ operation: 'update', expectedVersion: 10, aggregateId: 'agg-inflated' });
    await renderSettled(renderRepairProvider);
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      return {
        applied: [],
        rejected: [
          rejectWith({
            mutationId: m.id,
            aggregateId: 'agg-inflated',
            currentVersion: 13,
            currentUpdatedAt: '2026-07-02T00:00:00.000Z',
          }),
        ],
        syncCursor: '0',
      };
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('conflicts')).toHaveTextContent('1'));
    fake.pullImpl = async () => ({ changes: [], newCursor: 'seed-cursor', hasMore: false });
    fireEvent.click(screen.getByText('discard'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
    expect(await listFailedConflicts()).toHaveLength(1);
    const still = await getAggregate('account', 'agg-inflated');
    expect(still?.updatedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('keep on a NOT_FOUND-on-update re-queues as create @ 0 carrying the latest payload, and the recreate lands', async () => {
    // NOT_FOUND on update parks a failed-conflict; "Keep mine" converts the update to a create @ 0, which is unique to this
    // branch and so proves it fired.
    const m = await seedMutation({
      operation: 'update',
      expectedVersion: 10,
      aggregateId: 'agg-gone-keep',
      payload: { name: 'Recreate me' },
    });
    await renderSettled(renderRepairProvider);
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      const head = args.mutations[0];
      if (head.id === m.id) {
        return {
          applied: [],
          rejected: [rejectWith({ mutationId: m.id, aggregateId: 'agg-gone-keep', reason: 'NOT_FOUND' })],
          syncCursor: '0',
        };
      }
      return applyAll(args);
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('conflicts')).toHaveTextContent('1'));
    const [parked] = await listFailedConflicts();
    expect(parked).toMatchObject({ operation: 'update', reason: 'NOT_FOUND' });
    fireEvent.click(screen.getByText('keep'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    const kept = pushed.flat().find((p) => p.aggregateId === 'agg-gone-keep' && p.id !== m.id);
    expect(kept).toMatchObject({ operation: 'create', expectedVersion: 0 });
    expect(kept?.payload).toEqual({ name: 'Recreate me' });
    expect(await listPendingMutations()).toHaveLength(0);
    expect(await listFailedConflicts()).toHaveLength(0);
  });

  it('discard on a NOT_FOUND-on-update drops the mutation and deletes the local row', async () => {
    // "Discard" on a NOT_FOUND-on-update conflict accepts the server deletion by removing the mutation and hard-deleting the
    // local row; the generic pull-adopt path would re-escalate on this empty log and leave the row.
    await putAggregate('account', {
      id: 'agg-gone-discard',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 11,
      updatedAt: '2026-07-01T00:00:00.000Z',
      deviceId: 'dev-1',
      payload: { name: 'Local draft' },
    });
    const m = await seedMutation({ operation: 'update', expectedVersion: 10, aggregateId: 'agg-gone-discard' });
    await renderSettled(renderRepairProvider);
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      return {
        applied: [],
        rejected: [rejectWith({ mutationId: m.id, aggregateId: 'agg-gone-discard', reason: 'NOT_FOUND' })],
        syncCursor: '0',
      };
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('conflicts')).toHaveTextContent('1'));
    const [parked] = await listFailedConflicts();
    expect(parked).toMatchObject({ operation: 'update', reason: 'NOT_FOUND' });
    expect(await getAggregate('account', 'agg-gone-discard')).not.toBeNull();
    fireEvent.click(screen.getByText('discard'));
    await waitFor(() => expect(screen.getByTestId('conflicts')).toHaveTextContent('0'));
    expect(await listFailedConflicts()).toHaveLength(0);
    expect(await listPendingMutations()).toHaveLength(0);
    expect(await getAggregate('account', 'agg-gone-discard')).toBeNull();
  });

  it('happy path invokes no auto-repair, writes no rejection line, and mutates no versions', async () => {
    await putAggregate('account', {
      id: 'agg-ok',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-07-02T00:00:00.000Z',
      deviceId: 'dev-1',
      payload: { name: 'Healthy' },
    });
    await seedMutation({ operation: 'update', expectedVersion: 1, aggregateId: 'agg-ok' });
    await renderSettled(renderRepairProvider);
    clearDiagnostics();
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(async () => {
      expect(await listPendingMutations()).toHaveLength(0);
    });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    const rejectionLine = getEntries()
      .filter((e) => e.source === 'sync')
      .find((e) => e.message.includes('push rejected'));
    expect(rejectionLine).toBeUndefined();
    expect((await getAggregate('account', 'agg-ok'))?.version).toBe(1);
    clearDiagnostics();
  });

  it('a silent auto-resolution writes a PII-free diagnostics line (enums + version ints + id fragment, no name)', async () => {
    await putAggregate('account', {
      id: 'd3f08686',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 13,
      updatedAt: '2026-07-02T00:00:00.000Z',
      deviceId: 'dev-1',
      payload: { name: 'SecretHouseholdName' },
    });
    const m = await seedMutation({
      operation: 'update',
      expectedVersion: 12,
      aggregateId: 'd3f08686',
      payload: { name: 'SecretHouseholdName' },
    });
    await renderSettled(renderRepairProvider);
    clearDiagnostics();
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      const head = args.mutations[0];
      if (head.id === m.id) {
        return {
          applied: [],
          rejected: [rejectWith({ mutationId: m.id, aggregateId: 'd3f08686', currentVersion: 10 })],
          syncCursor: '0',
        };
      }
      return applyAll(args);
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(async () => {
      expect(await listPendingMutations()).toHaveLength(0);
    });
    const line = getEntries()
      .filter((e) => e.source === 'sync')
      .find((e) => e.message.includes('push rejected'));
    expect(line).toBeDefined();
    // Enums, version ints and the id fragment only, never the resolved name or other PII.
    expect(line?.detail).toContain('rebase-inflation');
    expect(line?.detail).toContain('d3f0-8686');
    expect(line?.detail).not.toContain('SecretHouseholdName');
    clearDiagnostics();
  });
});
