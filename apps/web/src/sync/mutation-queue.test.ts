/**
 * queueLocalMutation tests. Focus: the strictly-monotonic logical clock
 * that stamps each queued mutation's `timestamp`, so same-millisecond
 * edits to one aggregate keep a strict flush order (an update can't
 * be pushed before its create).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AccountRetypeBlockedError,
  clearAllStores,
  ConcurrentQueueMutationError,
  getAggregate,
  listAllMutations,
  listPendingMutations,
  putAggregate,
  queueMutation,
} from '../db/store';
import type { AccountPayload, Aggregate, PendingMutation } from '../db/types';
import { setRegisteredDeviceId } from './device-id';
import {
  collapseAndReQueue,
  queueGuardedAccountUpdate,
  queueLocalMutation,
} from './mutation-queue';

describe('queueLocalMutation', () => {
  beforeEach(async () => {
    await clearAllStores();
    setRegisteredDeviceId('dev-test');
  });
  afterEach(async () => {
    await clearAllStores();
  });

  it('stamps strictly-monotonic timestamps so same-ms create+update keep flush order', async () => {
    // A burst of edits to one aggregate (create then update) issued in the
    // same millisecond must not tie on `timestamp` — listPendingMutations
    // sorts by it, and a tie would let the random UUID decide order.
    await queueLocalMutation({
      type: 'account',
      aggregateId: 'agg-1',
      householdId: 'hh-1',
      operation: 'create',
      expectedVersion: 0,
      payload: { name: 'Created' },
    });
    await queueLocalMutation({
      type: 'account',
      aggregateId: 'agg-1',
      householdId: 'hh-1',
      operation: 'update',
      expectedVersion: 1,
      payload: { name: 'Updated' },
    });

    const pending = await listPendingMutations();
    expect(pending.map((m) => m.operation)).toEqual(['create', 'update']);
    // Strictly increasing — no tie even within one millisecond.
    expect(pending[1].timestamp).toBeGreaterThan(pending[0].timestamp);
  });
});

function stackRow(id: string, over: Partial<PendingMutation> = {}): PendingMutation {
  return {
    id,
    aggregateId: 'agg-1',
    aggregateType: 'scenario',
    operation: 'update',
    expectedVersion: 12,
    schemaVersion: 1,
    payload: { name: id },
    timestamp: 1000,
    deviceId: 'dev-test',
    status: 'failed-conflict',
    ...over,
  };
}

describe('collapseAndReQueue', () => {
  beforeEach(async () => {
    await clearAllStores();
    setRegisteredDeviceId('dev-test');
  });
  afterEach(async () => {
    await clearAllStores();
  });

  it('mints a FRESH id (≠ the rejected ids) so the 7-day rejection cache is not replayed', async () => {
    await queueMutation(stackRow('old-1'));
    await queueMutation(stackRow('old-2', { timestamp: 1001 }));
    const fresh = await collapseAndReQueue({
      aggregateType: 'scenario',
      aggregateId: 'agg-1',
      householdId: 'hh-1',
      operation: 'update',
      expectedVersion: 9,
      schemaVersion: 1,
      payload: { name: 'latest' },
      removeMutationIds: ['old-1', 'old-2'],
    });
    expect(fresh.id).not.toBe('old-1');
    expect(fresh.id).not.toBe('old-2');
    const all = await listAllMutations();
    expect(all.map((m) => m.id)).toEqual([fresh.id]);
    expect(all[0]).toMatchObject({
      operation: 'update',
      expectedVersion: 9,
      status: 'pending',
      payload: { name: 'latest' },
    });
  });

  it('corrects the local aggregate version to expectedVersion + 1', async () => {
    await queueMutation(stackRow('old-1'));
    await collapseAndReQueue({
      aggregateType: 'scenario',
      aggregateId: 'agg-1',
      householdId: 'hh-1',
      operation: 'update',
      expectedVersion: 9,
      schemaVersion: 1,
      payload: { name: 'latest' },
      removeMutationIds: ['old-1'],
    });
    const agg = await getAggregate('scenario', 'agg-1');
    expect(agg?.version).toBe(10);
    expect(agg?.deletedAt).toBeUndefined();
  });

  it('a delete collapse tombstones the local aggregate', async () => {
    await queueMutation(stackRow('old-1'));
    await collapseAndReQueue({
      aggregateType: 'scenario',
      aggregateId: 'agg-1',
      householdId: 'hh-1',
      operation: 'delete',
      expectedVersion: 9,
      schemaVersion: 1,
      payload: { name: 'gone' },
      removeMutationIds: ['old-1'],
    });
    // getAggregate filters tombstones, so a null read confirms the deletedAt.
    expect(await getAggregate('scenario', 'agg-1')).toBeNull();
  });

  it('aborts rather than stomping a concurrent queueLocalMutation that landed after the caller read the stack', async () => {
    // The check-and-mutate TOCTOU: the caller read the stack as [old-1] and
    // computed removeMutationIds from it, THEN a user edit (queueLocalMutation)
    // for the SAME aggregate landed — un-fenced by the sync mutex. The collapse
    // re-reads the live stack INSIDE its transaction, sees the extra row, and
    // aborts — leaving the concurrent edit intact rather than silently losing it
    // (the corrected-aggregate write would otherwise stomp it). The repair pass
    // then re-routes the aggregate on the next round with the fresh stack.
    await queueMutation(stackRow('old-1'));
    const concurrent = await queueLocalMutation({
      type: 'scenario',
      aggregateId: 'agg-1',
      householdId: 'hh-1',
      operation: 'update',
      expectedVersion: 12,
      payload: { name: 'concurrent-edit' },
    });
    await expect(
      collapseAndReQueue({
        aggregateType: 'scenario',
        aggregateId: 'agg-1',
        householdId: 'hh-1',
        operation: 'update',
        expectedVersion: 9,
        schemaVersion: 1,
        payload: { name: 'stale-latest' },
        removeMutationIds: ['old-1'], // stale snapshot — excludes `concurrent`
      }),
    ).rejects.toBeInstanceOf(ConcurrentQueueMutationError);
    // Nothing lost: the concurrent edit survives as a pending row, old-1 is
    // untouched (the abort rolled the delete back), and NO fresh re-based row
    // was minted.
    const all = await listAllMutations();
    expect(all.map((m) => m.id).sort()).toEqual(['old-1', concurrent.id].sort());
    expect(all.find((m) => m.id === concurrent.id)?.status).toBe('pending');
  });

  it('is atomic — a fault mid-collapse leaves the old mutation in place (nothing lost)', async () => {
    await queueMutation(stackRow('old-1'));
    // A non-cloneable payload (a function) makes the aggregate `put` throw
    // inside the single readwrite transaction, aborting it — so the preceding
    // delete of `old-1` rolls back and the un-synced edit is never dropped.
    const badPayload = { boom: () => 0 } as unknown as Record<string, unknown>;
    await expect(
      collapseAndReQueue({
        aggregateType: 'scenario',
        aggregateId: 'agg-1',
        householdId: 'hh-1',
        operation: 'update',
        expectedVersion: 9,
        schemaVersion: 1,
        payload: badPayload,
        removeMutationIds: ['old-1'],
      }),
    ).rejects.toThrow();
    const all = await listAllMutations();
    expect(all.map((m) => m.id)).toEqual(['old-1']);
  });
});

function accountAggregate(id: string, overrides: Partial<AccountPayload> = {}): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'hh-1',
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-test',
    payload: {
      name: 'My 401k',
      type: 'RETIREMENT_401K',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'PRE_TAX',
      ownerId: 'hm-1',
      institution: 'Vanguard',
      notes: '',
      planningReturnPct: 7,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      ...overrides,
    } as AccountPayload,
  };
}

describe('queueGuardedAccountUpdate', () => {
  beforeEach(async () => {
    await clearAllStores();
    setRegisteredDeviceId('dev-test');
  });
  afterEach(async () => {
    await clearAllStores();
  });

  it('carries the same deviceId guard as queueLocalMutation', async () => {
    await putAggregate('account', accountAggregate('acc-1'));
    setRegisteredDeviceId('');
    await expect(
      queueGuardedAccountUpdate({
        householdId: 'hh-1',
        aggregateId: 'acc-1',
        expectedVersion: 1,
        buildPayload: (freshAccount) => freshAccount.payload,
        guard: { needsHistoryRead: () => false, allow: () => true },
      }),
    ).rejects.toThrow(/registered the device id/);
  });

  it('stamps the same schemaVersion and expectedVersion + 1 optimistic bump as queueLocalMutation', async () => {
    await putAggregate('account', accountAggregate('acc-1'));
    const written = await queueGuardedAccountUpdate({
      householdId: 'hh-1',
      aggregateId: 'acc-1',
      expectedVersion: 5,
      buildPayload: (freshAccount) => ({ ...freshAccount.payload, name: 'Renamed' }),
      guard: { needsHistoryRead: () => false, allow: () => true },
    });
    expect(written.aggregate.version).toBe(6);
    expect(written.aggregate.schemaVersion).toBe(written.mutation.schemaVersion);
    expect(written.mutation.expectedVersion).toBe(5);
    expect(written.mutation.operation).toBe('update');
    const stored = await getAggregate('account', 'acc-1');
    expect(stored?.payload.name).toBe('Renamed');
    expect(stored?.version).toBe(6);
  });

  it('a refused write throws AccountRetypeBlockedError and queues nothing', async () => {
    await putAggregate('account', accountAggregate('acc-1'));
    await expect(
      queueGuardedAccountUpdate({
        householdId: 'hh-1',
        aggregateId: 'acc-1',
        expectedVersion: 1,
        buildPayload: (freshAccount) => freshAccount.payload,
        guard: { needsHistoryRead: () => true, allow: () => false },
      }),
    ).rejects.toBeInstanceOf(AccountRetypeBlockedError);
    expect(await listAllMutations()).toEqual([]);
  });

  it('two writes inside one millisecond get strictly increasing timestamps from the shared counter', async () => {
    await putAggregate('account', accountAggregate('acc-1'));
    await putAggregate('account', accountAggregate('acc-2'));
    const first = await queueGuardedAccountUpdate({
      householdId: 'hh-1',
      aggregateId: 'acc-1',
      expectedVersion: 1,
      buildPayload: (freshAccount) => freshAccount.payload,
      guard: { needsHistoryRead: () => false, allow: () => true },
    });
    const second = await queueLocalMutation({
      type: 'account',
      aggregateId: 'acc-2',
      householdId: 'hh-1',
      operation: 'update',
      expectedVersion: 1,
      payload: accountAggregate('acc-2').payload,
    });
    expect(second.timestamp).toBeGreaterThan(first.mutation.timestamp);
  });
});
