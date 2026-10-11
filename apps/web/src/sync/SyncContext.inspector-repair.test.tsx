/**
 * SyncProvider sync-inspector mutation lists, rejection summary and the auto-repair reject loop.
 *
 * Split out of the former single SyncContext.test.tsx; shared setup lives in
 * `sync-context.test-harness.tsx`.
 */
import 'fake-indexeddb/auto';
import { screen, waitFor, act, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAggregate, listFailedConflicts, putAggregate, listPendingMutations } from '../db/store';
import { type PendingMutation } from '../db/types';
import { redactArgs } from '../lib/diagnostics/redact';
import { type PushedMutationRejected, type PushResponseBody } from './types';
import { type SyncTransport } from './sync-client';
import { clear as clearDiagnostics, getEntries } from '../lib/diagnostics/logger';
import { useSync, sameMutationList } from './SyncContext';
import { fake, renderProvider, seedMutation, renderSettled, useSyncTestHooks } from './sync-context.test-harness';

vi.mock('./mock-sync', async () => (await import('./sync-context.test-fake')).mockSyncModule);


// The content-equality gate that keeps `refreshCounts` from churning the
// exposed mutation lists (and every `useSync()` consumer / label lookup) on an
// unchanged poll. Compares only the fields the inspector renders.
describe('sameMutationList (content-equality gate)', () => {
  function row(over: Partial<PendingMutation> = {}): PendingMutation {
    return {
      id: over.id ?? 'm-1',
      aggregateId: over.aggregateId ?? 'agg-1',
      aggregateType: over.aggregateType ?? 'account',
      operation: over.operation ?? 'update',
      expectedVersion: over.expectedVersion ?? 4,
      schemaVersion: over.schemaVersion ?? 1,
      payload: over.payload ?? { name: 'A' },
      timestamp: over.timestamp ?? 1,
      deviceId: over.deviceId ?? 'dev-1',
      status: over.status ?? 'failed-conflict',
      reason: over.reason,
    };
  }

  it('returns true for the same array reference (short-circuit)', () => {
    const a = [row()];
    expect(sameMutationList(a, a)).toBe(true);
  });

  it('returns false when the lengths differ', () => {
    expect(sameMutationList([row()], [row(), row({ id: 'm-2' })])).toBe(false);
  });

  const differingFieldCases: ReadonlyArray<[string, Partial<PendingMutation>]> = [
    ['id', { id: 'm-2' }],
    ['status', { status: 'pending' }],
    ['expectedVersion', { expectedVersion: 99 }],
    ['reason', { reason: 'NOT_FOUND' }],
  ];
  it.each(differingFieldCases)(
    'returns false when %s differs on an equal-length list',
    (_field, over) => {
      expect(sameMutationList([row()], [row(over)])).toBe(false);
    },
  );

  it('returns true for equal rendered content in a distinct array reference', () => {
    // Different array + different UNRENDERED fields (payload / timestamp /
    // deviceId), identical rendered fields → equal, so the gate keeps the prior
    // ref (a no-op setState — no consumer churn).
    const a = [row({ payload: { name: 'A' }, timestamp: 1, deviceId: 'dev-1' })];
    const b = [row({ payload: { name: 'B' }, timestamp: 2, deviceId: 'dev-2' })];
    expect(a).not.toBe(b);
    expect(sameMutationList(a, b)).toBe(true);
  });
});


// The mutation lists exposed on the context value for the read-only inspector,
// plus the redaction-surviving `idFragment` on the rejection summary.
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

    // The failed row is exposed on the context contract the inspector renders.
    const first = capturedConflicts;
    expect(first.map((c) => c.id)).toContain(m.id);
    expect(first.find((c) => c.id === m.id)?.reason).toBe('CONFLICT');

    // A subsequent no-change refresh (retryNow flushes → refreshCounts sees the
    // same conflict content) must NOT churn the array reference (content-equality gate).
    fake.pullImpl = async () => ({ changes: [], newCursor: 'seed-cursor', hasMore: false });
    await act(async () => {
      fireEvent.click(screen.getByText('retryNow'));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
    expect(capturedConflicts).toBe(first);
  });

  it('degrades the rejection summary for a short / non-hex aggregateId — no id fragment, never throws', async () => {
    // A non-hex aggregateId yields an empty hex prefix, so idFragment returns
    // '' and the summary carries the type/op/versions but NO correlator.
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
    // No fragment: the op is immediately followed by the versions clause.
    expect(why?.detail).toMatch(/account\/update \(local v3/);
    clearDiagnostics();
  });

  it('keeps the id fragment redaction-surviving for a short all-digit hex prefix (hardening)', async () => {
    // A short aggregateId whose hex prefix is a 7-digit run ('1234567') would,
    // if returned raw, match the diagnostics redactor's DIGIT_RUN_RE (7+
    // digits) and be masked to [redacted] — defeating the correlator.
    // idFragment must dash-split it ('1234-567') so it clears the redactor.
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
    // (i) The fragment is present + non-empty, and (ii) survives redaction —
    // `why.detail` IS the already-redacted output, so its presence proves the
    // fragment cleared the redactor (the raw 7-digit prefix would be masked).
    expect(why?.detail).toContain('1234-567');
    expect(why?.detail).not.toContain('[redacted]');
    // Direct redactor assertions: the dash-split fragment survives; the raw
    // 7-digit prefix it derives from would have been masked to [redacted].
    expect(redactArgs(['1234-567'])).toContain('1234-567');
    expect(redactArgs(['1234-567'])).not.toContain('[redacted]');
    expect(redactArgs(['1234567'])).toContain('[redacted]');
    clearDiagnostics();
  });

  it('degrades the rejection summary when the rejected mutationId is absent from the pushed chunk (local undefined) — no fragment, never throws', async () => {
    // The seeded mutation is applied (queue drains cleanly); the server also
    // rejects an id that was never in the chunk, so `local` is undefined and
    // idFragment(undefined) → ''. The summary must fall back to '?' and not
    // throw.
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
    // Wait for the diagnostics entry ITSELF, not the shared mount-settled
    // 'synced' badge: this test's queue drains cleanly (the real mutation
    // applies), so the badge returns to 'synced' — the very state already
    // present from mount, so a `synced` wait resolves immediately and races the
    // reject loop's async repair work (the extra listMutationsByAggregate +
    // parkFailedConflict IDB awaits before `recordSyncWarn` lands the line).
    // The 'push rejected' entry is the real completion barrier for this assertion.
    const why = await waitFor(() => {
      const e = getEntries()
        .filter((entry) => entry.source === 'sync')
        .find((entry) => entry.message.includes('push rejected'));
      expect(e).toBeDefined();
      return e;
    });
    // The real mutation applied, so the queue drains and the badge lands synced.
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(await listPendingMutations()).toHaveLength(0);
    expect(why?.detail).toContain('CONFLICT');
    // Local undefined → '?' fallbacks for type/op/version, and no id fragment.
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
    // A created-then-updated-then-deleted local draft: the server already
    // tombstoned this aggregate, so the create is rejected CONFLICT over a
    // tombstone (currentDeletedAt set). The final local intent is "deleted" and
    // the server agrees, so EVERY queued row must clear in one pass. A single-row
    // drop would strand the sibling `update`, which the next flush would push
    // stale against the tombstoned version and escalate to failed-conflict —
    // breaking the silent-auto-resolve guarantee for a created-then-deleted draft.
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
    // All THREE rows are gone — nothing stranded, nothing escalated.
    expect(await listFailedConflicts()).toHaveLength(0);
    // Only the create was sent in the first batch, and nothing resurrected the
    // aggregate: no push after the create carried a live `update`/rebase.
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
    // Reject the inflated push (server at v10 < expected v12); apply anything
    // re-based to v10.
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
    // The re-based push carried a FRESH id (≠ the rejected one) at v10.
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
    // A later flush does not push the failed-conflict, and the facts survive.
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
      // Reject whatever earliest sibling is sent (server ahead).
      const head = args.mutations[0];
      return {
        applied: [],
        rejected: [rejectWith({ mutationId: head.id, aggregateId: 'agg-1', currentVersion: 20 })],
        syncCursor: '0',
      };
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
    // The first batch carried at most one mutation for the aggregate.
    expect(pushed[0]).toHaveLength(1);
    // Both siblings collapsed to a single parked representative — the later
    // sibling never applied (no silent overwrite).
    expect(await listFailedConflicts()).toHaveLength(1);
    expect(await listPendingMutations()).toHaveLength(0);
  });

  it('happy path: same-aggregate edits land in order across flush rounds (identical final state)', async () => {
    await seedMutation({ id: 'c-1', operation: 'create', expectedVersion: 0, aggregateId: 'agg-1', timestamp: 1000 });
    await seedMutation({ id: 'u-1', operation: 'update', expectedVersion: 1, aggregateId: 'agg-1', timestamp: 1001 });
    await renderSettled(renderRepairProvider);
    // Default pushImpl applies everything (server not ahead).
    fake.pushImpl = async (args) => {
      pushed.push(args.mutations);
      return applyAll(args);
    };
    fireEvent.click(screen.getByText('notifyPending'));
    await waitFor(async () => {
      expect(await listPendingMutations()).toHaveLength(0);
    });
    // Each batch carried at most one mutation for the aggregate, and the
    // create was pushed before its update (order preserved across rounds).
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
        // create over a LIVE row → escalate.
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
    // The kept push converted the create → update @ currentVersion (2).
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
        // Server counter ran ahead to v13 (the wedge) → escalate.
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
    // Content advanced one version past the wedge counter (13 → 14).
    expect((await getAggregate('account', 'agg-wedge'))?.version).toBe(14);
    expect(await listFailedConflicts()).toHaveLength(0);
  });

  it('keep re-queues the NEWEST local intent when a later edit landed while the conflict sat parked (never drops it)', async () => {
    // A conflict parks (payload A). The user then makes a LATER local edit to the
    // SAME aggregate (payload B, newer timestamp) while the conflict stays parked.
    // "Keep mine" must carry the NEWEST intent (B) forward: the collapse removes
    // EVERY queue row for the aggregate (A + the newer pending sibling B), so
    // re-queuing A's stale payload would silently delete B — violating "never
    // silently lose an un-synced edit". latestEdit(stack) picks B.
    const a = await seedMutation({
      id: 'keep-latest-a',
      operation: 'update',
      expectedVersion: 10,
      aggregateId: 'agg-keep-latest',
      payload: { name: 'A-older' },
      timestamp: 1000,
    });
    await renderSettled(renderRepairProvider);
    // Drive A to a parked failed-conflict (server ran ahead to v13 → escalate).
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
    // A LATER local edit lands on the same aggregate while the conflict is parked
    // (a newer `pending` sibling, strictly higher timestamp) — the newest intent.
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
    // The kept push carries the NEWEST intent (payload B), not the stale parked A.
    const kept = pushed
      .flat()
      .find((p) => p.aggregateId === 'agg-keep-latest' && p.id !== a.id && p.id !== 'keep-latest-b');
    expect(kept?.payload).toEqual({ name: 'B-newer' });
    expect(kept?.payload).not.toEqual({ name: 'A-older' });
    // Re-based forward onto the server's true counter; queue drained, none parked.
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
    // The discard's pull delivers the server copy at v13 (converged).
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
    // The server row was DELETED on another device, so the update is rejected
    // CONFLICT carrying a tombstone (currentDeletedAt set) — NOT NOT_FOUND — so
    // the dedicated update+NOT_FOUND discard branch does not fire and control
    // reaches the generic discard convergence check. The discard's pull adopts
    // the server deletion (the local row becomes a tombstone). The convergence
    // check must read the tombstone (getAggregateIncludingDeleted), not
    // getAggregate — which filters tombstones and would read the adopted
    // deletion as absent, leaving the conflict parked forever behind a false
    // "try again".
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
    // The discard's pull delivers the server DELETE: a tombstone at v13 whose
    // updatedAt matches the rejection's currentUpdatedAt (converged).
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
    // The badge's conflict indicator clears (parked conflict resolved). With the
    // pre-fix getAggregate read this never reaches 0 — the pulled tombstone reads
    // as absent, convergence fails, and the row stays parked (false "try again").
    await waitFor(() => expect(screen.getByTestId('conflicts')).toHaveTextContent('0'));
    expect(await listFailedConflicts()).toHaveLength(0);
    // The adopted server deletion left the local row a tombstone (filtered out).
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
    // The discard's pull delivers nothing (empty log) → cannot converge to v13.
    fake.pullImpl = async () => ({ changes: [], newCursor: 'seed-cursor', hasMore: false });
    fireEvent.click(screen.getByText('discard'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
    // Left parked (re-escalated) — the un-synced content was not silently dropped.
    expect(await listFailedConflicts()).toHaveLength(1);
  });

  it('discard re-escalates a wedge whose LOCAL version is already inflated past the server counter', async () => {
    // Regression: optimistic version inflation can leave the LOCAL
    // aggregate version already >= the server counter off the poisoned edit
    // alone. A bare `version >= currentVersion` convergence check would then
    // falsely clear the conflict even though the empty-log pull delivered
    // NOTHING and the local content is still the user's stale draft. Convergence
    // must additionally require the pull to have written the server's true row
    // (updatedAt === currentUpdatedAt), so this wedge re-escalates.
    await putAggregate('account', {
      id: 'agg-inflated',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      // Local version inflated to 15, PAST the server's true counter (13).
      version: 15,
      // The user's stale local-draft timestamp — NOT the server row's updatedAt.
      updatedAt: '2026-07-01T00:00:00.000Z',
      deviceId: 'dev-1',
      payload: { name: 'Stale draft' },
    });
    // Queued at v10; the server counter is ahead (13) so the rejection escalates
    // to a parked failed-conflict — while the aggregate row itself is inflated to
    // v15, past the counter (the exact shape that fools a bare `>=` check).
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
    // Empty log — the pull delivers nothing, so the local row is never
    // overwritten to the server's true content.
    fake.pullImpl = async () => ({ changes: [], newCursor: 'seed-cursor', hasMore: false });
    fireEvent.click(screen.getByText('discard'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('stale'));
    // Re-escalated, NOT silently cleared — the un-synced edit survives.
    expect(await listFailedConflicts()).toHaveLength(1);
    // The inflated local draft is untouched (never adopted a phantom server copy).
    const still = await getAggregate('account', 'agg-inflated');
    expect(still?.updatedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('keep on a NOT_FOUND-on-update re-queues as create @ 0 carrying the latest payload, and the recreate lands', async () => {
    // The server row was DELETED on another device, so the update is rejected
    // NOT_FOUND — decide() escalates it to a parked failed-conflict carrying
    // reason NOT_FOUND. "Keep mine" then converts the update → create @ 0 (the
    // server row is gone), carrying the latest local payload, and the recreate
    // lands. create @ 0 is unique to this NOT_FOUND-keep branch (a create-over-
    // live or plain keep re-bases to update @ currentVersion), so it proves the
    // real branch fired.
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
    // The parked conflict genuinely carries the NOT_FOUND-on-update shape.
    const [parked] = await listFailedConflicts();
    expect(parked).toMatchObject({ operation: 'update', reason: 'NOT_FOUND' });
    fireEvent.click(screen.getByText('keep'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    // The kept push recreated the aggregate: create @ 0 with the latest payload.
    const kept = pushed.flat().find((p) => p.aggregateId === 'agg-gone-keep' && p.id !== m.id);
    expect(kept).toMatchObject({ operation: 'create', expectedVersion: 0 });
    expect(kept?.payload).toEqual({ name: 'Recreate me' });
    // It landed — nothing left pending or parked.
    expect(await listPendingMutations()).toHaveLength(0);
    expect(await listFailedConflicts()).toHaveLength(0);
  });

  it('discard on a NOT_FOUND-on-update drops the mutation and deletes the local row', async () => {
    // A live local aggregate holds the user's un-synced draft; the server row was
    // deleted on another device → NOT_FOUND on the update parks a failed-conflict.
    // "Discard" accepts the server deletion: it removes the mutation AND hard-
    // deletes the local row (deleteAggregateLocally) — NOT the generic pull-adopt
    // discard path (which, on this empty log, would re-escalate and leave the row
    // intact), so the row-gone + conflict-cleared outcome proves the real branch.
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
    // The parked conflict carries the NOT_FOUND-on-update shape, and the local row
    // is still present before the discard.
    const [parked] = await listFailedConflicts();
    expect(parked).toMatchObject({ operation: 'update', reason: 'NOT_FOUND' });
    expect(await getAggregate('account', 'agg-gone-discard')).not.toBeNull();
    fireEvent.click(screen.getByText('discard'));
    // Conflict clears, the mutation is removed, and the local row is deleted.
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
    // The accepted push left the local aggregate untouched.
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
    // Enums + version ints + id fragment only — never the resolved name / PII.
    expect(line?.detail).toContain('rebase-inflation');
    expect(line?.detail).toContain('d3f0-8686');
    expect(line?.detail).not.toContain('SecretHouseholdName');
    clearDiagnostics();
  });
});
