// IndexedDB layer tests over `fake-indexeddb`, so the real `idb` code paths run end to end.
import 'fake-indexeddb/auto';
import { forceCloseDatabase } from 'fake-indexeddb';
// eslint-disable-next-line no-restricted-imports -- unwrap the cached handle so fake-indexeddb can force-close it
import { unwrap } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  AccountRetypeBlockedError,
  AccountRetypeCheckFailedError,
  clearAllStores,
  closeNudgeChannel,
  ConcurrentQueueMutationError,
  DatabaseDropBlockedError,
  db,
  deleteAggregateLocally,
  dropLocalDatabase,
  collapseToFailedConflict,
  getAggregate,
  getAggregateIncludingDeleted,
  getStoreVersion,
  hasForeignHouseholdData,
  KEY_CACHE_ID,
  listAggregates,
  listAllMutations,
  listFailedConflicts,
  listFailedErrors,
  listMutationsByAggregate,
  onForeignDatabaseDrop,
  listPendingMutations,
  parkFailedConflict,
  putAggregate,
  queueMutation,
  readDeviceMetadata,
  readKeyCacheEntry,
  reEnqueueMutationWithFreshId,
  removeMutation,
  removeMutations,
  subscribeToStoreChanges,
  updateMutationStatus,
  withBatchedStoreSignals,
  writeAccountWithRetypeGuard,
  writeDeviceMetadata,
  writeKeyCacheEntry,
} from './store';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  PendingMutation,
} from './types';

const HH = 'hh-test';
const DEVICE = 'dev-test';

function memberAgg(id: string, overrides: Partial<HouseholdMemberPayload> = {}): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: DEVICE,
    payload: {
      isPrimary: true,
      firstName: 'Alex',
      lastName: 'Test',
      email: 'alex@example.test',
      birthdate: '1985-04-15',
      ...overrides,
    },
  };
}

function pendingMutation(id: string, overrides: Partial<PendingMutation> = {}): PendingMutation {
  return {
    id,
    aggregateId: 'agg-1',
    aggregateType: 'householdMember',
    operation: 'create',
    expectedVersion: 0,
    schemaVersion: 1,
    payload: {},
    deviceId: DEVICE,
    timestamp: Date.now(),
    status: 'pending',
    ...overrides,
  };
}

describe('foreign database drop notification', () => {
  let listener: Mock<() => void>;
  let unsubscribe: () => void;

  beforeEach(async () => {
    await dropLocalDatabase();
    listener = vi.fn<() => void>();
    unsubscribe = onForeignDatabaseDrop(listener);
  });
  afterEach(async () => {
    unsubscribe();
    closeNudgeChannel();
    await dropLocalDatabase();
  });

  it('fires when a nudge arrives from another tab', async () => {
    await db();
    const sender = new BroadcastChannel('retivo.idb.nudge');
    sender.postMessage('release-idb');
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    sender.close();
  });

  it('fires when another connection deletes the database this tab holds open', async () => {
    await db();
    await new Promise<void>((resolve, reject) => {
      // eslint-disable-next-line no-restricted-properties -- a second connection standing in for another tab's drop
      const req = indexedDB.deleteDatabase('retirement');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires when the browser terminates the connection', async () => {
    const handle = await db();
    // fake-indexeddb types the argument as the IDBDatabase constructor, not an instance.
    forceCloseDatabase(unwrap(handle) as unknown as Parameters<typeof forceCloseDatabase>[0]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not fire for this tab\'s own drop or another tab\'s version upgrade', async () => {
    await db();
    await dropLocalDatabase();
    expect(listener).not.toHaveBeenCalled();

    await db();
    await new Promise<void>((resolve, reject) => {
      // eslint-disable-next-line no-restricted-properties -- a second connection standing in for another tab's upgrade
      const req = indexedDB.open('retirement', 10);
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', async () => {
    unsubscribe();
    await db();
    const sender = new BroadcastChannel('retivo.idb.nudge');
    sender.postMessage('release-idb');
    await new Promise((r) => setTimeout(r, 50));
    sender.close();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('IndexedDB store', () => {
  beforeEach(async () => {
    await clearAllStores();
  });
  afterEach(async () => {
    await clearAllStores();
  });

  describe('aggregates', () => {
    it('listAggregates returns nothing when the store is empty', async () => {
      const out = await listAggregates('householdMember');
      expect(out).toEqual([]);
    });

    it('putAggregate then getAggregate round-trips the row', async () => {
      const agg = memberAgg('hm-1');
      await putAggregate('householdMember', agg);
      const got = await getAggregate('householdMember', 'hm-1');
      expect(got).not.toBeNull();
      expect(got?.id).toBe('hm-1');
      expect((got?.payload as HouseholdMemberPayload).firstName).toBe('Alex');
    });

    it('listAggregates excludes soft-deleted rows', async () => {
      await putAggregate('householdMember', memberAgg('hm-1'));
      await putAggregate('householdMember', {
        ...memberAgg('hm-2'),
        deletedAt: '2026-05-01T01:00:00Z',
      });
      const out = await listAggregates('householdMember');
      expect(out.map((r) => r.id)).toEqual(['hm-1']);
    });

    it('getAggregate returns null for a soft-deleted row', async () => {
      await putAggregate('householdMember', {
        ...memberAgg('hm-1'),
        deletedAt: '2026-05-01T01:00:00Z',
      });
      expect(await getAggregate('householdMember', 'hm-1')).toBeNull();
    });

    it('getAggregateIncludingDeleted returns a tombstoned row where getAggregate returns null', async () => {
      await putAggregate('householdMember', {
        ...memberAgg('hm-1'),
        deletedAt: '2026-05-01T01:00:00Z',
      });
      // getAggregate filters the tombstone; the include-deleted accessor keeps it (the discard convergence check reads the adopted remote deletion there).
      expect(await getAggregate('householdMember', 'hm-1')).toBeNull();
      const kept = await getAggregateIncludingDeleted('householdMember', 'hm-1');
      expect(kept?.id).toBe('hm-1');
      expect(kept?.deletedAt).toBe('2026-05-01T01:00:00Z');
    });

    it('getAggregateIncludingDeleted returns null for a genuinely absent id', async () => {
      expect(await getAggregateIncludingDeleted('householdMember', 'missing')).toBeNull();
    });

    it('deleteAggregateLocally removes the row from the store', async () => {
      await putAggregate('householdMember', memberAgg('hm-1'));
      await deleteAggregateLocally('householdMember', 'hm-1');
      expect(await getAggregate('householdMember', 'hm-1')).toBeNull();
    });
  });

  describe('per-store change notifications (live-query fine signal)', () => {
    it('putAggregate bumps the version and notifies the store subscriber', async () => {
      const before = getStoreVersion('householdMembers');
      const listener = vi.fn();
      const unsubscribe = subscribeToStoreChanges('householdMembers', listener);
      await putAggregate('householdMember', memberAgg('hm-1'));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(getStoreVersion('householdMembers')).toBe(before + 1);
      unsubscribe();
    });

    it('deleteAggregateLocally notifies the store subscriber', async () => {
      await putAggregate('householdMember', memberAgg('hm-1'));
      const listener = vi.fn();
      const unsubscribe = subscribeToStoreChanges('householdMembers', listener);
      await deleteAggregateLocally('householdMember', 'hm-1');
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it('clearAllStores notifies every aggregate-store subscriber', async () => {
      const membersListener = vi.fn();
      const accountsListener = vi.fn();
      const unsubMembers = subscribeToStoreChanges('householdMembers', membersListener);
      const unsubAccounts = subscribeToStoreChanges('accounts', accountsListener);
      await clearAllStores();
      expect(membersListener).toHaveBeenCalledTimes(1);
      expect(accountsListener).toHaveBeenCalledTimes(1);
      unsubMembers();
      unsubAccounts();
    });

    it('a single write to store A does not notify a store-B subscriber (per-type isolation)', async () => {
      const accountsListener = vi.fn();
      const unsubscribe = subscribeToStoreChanges('accounts', accountsListener);
      const before = getStoreVersion('accounts');
      await putAggregate('householdMember', memberAgg('hm-1'));
      expect(accountsListener).not.toHaveBeenCalled();
      expect(getStoreVersion('accounts')).toBe(before);
      unsubscribe();
    });

    it('unsubscribed listeners stop receiving notifications', async () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToStoreChanges('householdMembers', listener);
      unsubscribe();
      await putAggregate('householdMember', memberAgg('hm-1'));
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('withBatchedStoreSignals (bulk-fill signal suppression)', () => {
    function accountAgg(id: string): Aggregate {
      return {
        id,
        householdId: HH,
        aggregateType: 'account',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-05-01T00:00:00Z',
        deviceId: DEVICE,
        payload: { name: 'Acct', taxTreatment: 'PRE_TAX' },
      } as Aggregate;
    }

    it('collapses N puts to one store into a single fine signal on exit (version bumped once)', async () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToStoreChanges('householdMembers', listener);
      const before = getStoreVersion('householdMembers');

      await withBatchedStoreSignals(async (batch) => {
        await putAggregate('householdMember', memberAgg('hm-1'), batch);
        await putAggregate('householdMember', memberAgg('hm-2'), batch);
        await putAggregate('householdMember', memberAgg('hm-3'), batch);
        expect(listener).not.toHaveBeenCalled();
        expect(getStoreVersion('householdMembers')).toBe(before);
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(getStoreVersion('householdMembers')).toBe(before + 1);
      unsubscribe();
    });

    it('flushes one signal per touched store; untouched stores stay silent (per-type isolation)', async () => {
      const membersListener = vi.fn();
      const accountsListener = vi.fn();
      const scenariosListener = vi.fn();
      const unsubMembers = subscribeToStoreChanges('householdMembers', membersListener);
      const unsubAccounts = subscribeToStoreChanges('accounts', accountsListener);
      const unsubScenarios = subscribeToStoreChanges('scenarios', scenariosListener);
      const scenariosBefore = getStoreVersion('scenarios');

      await withBatchedStoreSignals(async (batch) => {
        await putAggregate('householdMember', memberAgg('hm-1'), batch);
        await putAggregate('householdMember', memberAgg('hm-2'), batch);
        await putAggregate('account', accountAgg('acc-1'), batch);
      });

      expect(membersListener).toHaveBeenCalledTimes(1);
      expect(accountsListener).toHaveBeenCalledTimes(1);
      expect(scenariosListener).not.toHaveBeenCalled();
      expect(getStoreVersion('scenarios')).toBe(scenariosBefore);
      unsubMembers();
      unsubAccounts();
      unsubScenarios();
    });

    it('still flushes the touched-store signals when the scope throws, and propagates the error', async () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToStoreChanges('householdMembers', listener);
      const before = getStoreVersion('householdMembers');

      await expect(
        withBatchedStoreSignals(async (batch) => {
          await putAggregate('householdMember', memberAgg('hm-1'), batch);
          throw new Error('mid-batch boom');
        }),
      ).rejects.toThrow('mid-batch boom');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(getStoreVersion('householdMembers')).toBe(before + 1);
      unsubscribe();
    });

    it('two interleaved batches each flush only their own touched stores on their own exit', async () => {
      const membersListener = vi.fn();
      const accountsListener = vi.fn();
      const unsubMembers = subscribeToStoreChanges('householdMembers', membersListener);
      const unsubAccounts = subscribeToStoreChanges('accounts', accountsListener);

      // Each batch owns its own touched-store set, so concurrent batches flush only their own store.
      let resolveA!: () => void;
      let resolveB!: () => void;
      const gateA = new Promise<void>((r) => { resolveA = r; });
      const gateB = new Promise<void>((r) => { resolveB = r; });

      const runA = withBatchedStoreSignals(async (batch) => {
        await putAggregate('householdMember', memberAgg('hm-a1'), batch);
        resolveA();
        await gateB;
        await putAggregate('householdMember', memberAgg('hm-a2'), batch);
        expect(membersListener).not.toHaveBeenCalled();
      });

      const runB = withBatchedStoreSignals(async (batch) => {
        await gateA;
        await putAggregate('account', accountAgg('acc-b1'), batch);
        resolveB();
        await putAggregate('account', accountAgg('acc-b2'), batch);
      });

      await Promise.all([runA, runB]);

      expect(membersListener).toHaveBeenCalledTimes(1);
      expect(accountsListener).toHaveBeenCalledTimes(1);
      unsubMembers();
      unsubAccounts();
    });
  });

  describe('mutation queue', () => {
    it('queueMutation appends a pending row', async () => {
      await queueMutation(pendingMutation('mut-1'));
      const pending = await listPendingMutations();
      expect(pending.map((m) => m.id)).toEqual(['mut-1']);
    });

    it('listPendingMutations returns rows in timestamp (creation) order, not UUID order', async () => {
      // The `status` index orders ties by primary key (a random UUID), so listPendingMutations must sort by `timestamp`: a create whose UUID sorts after the update's but whose timestamp is earlier must still come first.
      await queueMutation(
        pendingMutation('zzz-create', {
          aggregateId: 'agg-x',
          operation: 'create',
          timestamp: 1000,
        }),
      );
      await queueMutation(
        pendingMutation('aaa-update', {
          aggregateId: 'agg-x',
          operation: 'update',
          expectedVersion: 1,
          timestamp: 1001,
        }),
      );
      const pending = await listPendingMutations();
      expect(pending.map((m) => m.id)).toEqual(['zzz-create', 'aaa-update']);
    });

    it('listPendingMutations only returns rows with status=pending', async () => {
      await queueMutation(pendingMutation('mut-1', { status: 'pending' }));
      await queueMutation(pendingMutation('mut-2', { status: 'failed-conflict' }));
      const pending = await listPendingMutations();
      expect(pending.map((m) => m.id)).toEqual(['mut-1']);
    });

    it('listFailedConflicts only returns rows with status=failed-conflict', async () => {
      await queueMutation(pendingMutation('mut-1', { status: 'pending' }));
      await queueMutation(pendingMutation('mut-2', { status: 'failed-conflict' }));
      const failed = await listFailedConflicts();
      expect(failed.map((m) => m.id)).toEqual(['mut-2']);
    });

    it('updateMutationStatus mutates an existing row in place', async () => {
      await queueMutation(pendingMutation('mut-1'));
      await updateMutationStatus('mut-1', 'failed-conflict');
      const pending = await listPendingMutations();
      expect(pending).toEqual([]);
      const failed = await listFailedConflicts();
      expect(failed.map((m) => m.id)).toEqual(['mut-1']);
    });

    it('updateMutationStatus persists a reason on failed-conflict', async () => {
      await queueMutation(pendingMutation('mut-1'));
      await updateMutationStatus('mut-1', 'failed-conflict', 'CONFLICT');
      const [failed] = await listFailedConflicts();
      expect(failed?.reason).toBe('CONFLICT');
    });

    it('updateMutationStatus without a reason clears a stale one', async () => {
      await queueMutation(pendingMutation('mut-1'));
      await updateMutationStatus('mut-1', 'failed-conflict', 'SCHEMA_MISMATCH');
      await updateMutationStatus('mut-1', 'pending');
      const [pending] = await listPendingMutations();
      expect(pending?.reason).toBeUndefined();
    });

    it('updateMutationStatus with an off-allowlist reason is the caller’s job; the store persists exactly what it is given', async () => {
      // The store writes the reason verbatim; the SyncContext rejection loop normalises an off-allowlist wire reason before calling here.
      await queueMutation(pendingMutation('mut-1'));
      await updateMutationStatus('mut-1', 'failed-conflict', undefined);
      const [failed] = await listFailedConflicts();
      expect(failed?.reason).toBeUndefined();
    });

    it('updateMutationStatus on a missing id is a no-op', async () => {
      await expect(
        updateMutationStatus('does-not-exist', 'failed-conflict'),
      ).resolves.not.toThrow();
    });

    it('parkFailedConflict persists reason + currentVersion + currentUpdatedAt together', async () => {
      await queueMutation(pendingMutation('mut-1'));
      await parkFailedConflict('mut-1', {
        reason: 'CONFLICT',
        currentVersion: 13,
        currentUpdatedAt: '2026-07-02T00:00:00.000Z',
      });
      const [failed] = await listFailedConflicts();
      expect(failed).toMatchObject({
        status: 'failed-conflict',
        reason: 'CONFLICT',
        currentVersion: 13,
        currentUpdatedAt: '2026-07-02T00:00:00.000Z',
      });
    });

    it('parkFailedConflict on a missing id is a no-op', async () => {
      await expect(parkFailedConflict('ghost', { reason: 'CONFLICT' })).resolves.not.toThrow();
    });

    it('collapseToFailedConflict folds siblings into one parked representative', async () => {
      await queueMutation(pendingMutation('rep', { aggregateId: 'agg-x', timestamp: 1002 }));
      await queueMutation(pendingMutation('sib-1', { aggregateId: 'agg-x', timestamp: 1000 }));
      await queueMutation(pendingMutation('sib-2', { aggregateId: 'agg-x', timestamp: 1001 }));
      await collapseToFailedConflict({
        aggregateId: 'agg-x',
        representativeId: 'rep',
        removeMutationIds: ['rep', 'sib-1', 'sib-2'],
        facts: { reason: 'CONFLICT', currentVersion: 7, currentUpdatedAt: '2026-07-02T00:00:00.000Z' },
      });
      const all = await listAllMutations();
      expect(all.map((m) => m.id)).toEqual(['rep']);
      expect(all[0]).toMatchObject({ status: 'failed-conflict', reason: 'CONFLICT', currentVersion: 7 });
    });

    it('collapseToFailedConflict aborts (throws, no stomp) when a concurrent row landed after the snapshot', async () => {
      // A user edit landing after the caller snapshotted the stack must survive: the transactional collapse re-reads the live stack and aborts rather than folding a stale collapse.
      await queueMutation(pendingMutation('rep', { aggregateId: 'agg-x', timestamp: 1001 }));
      await queueMutation(pendingMutation('sib-1', { aggregateId: 'agg-x', timestamp: 1000 }));
      await queueMutation(pendingMutation('concurrent', { aggregateId: 'agg-x', timestamp: 1002 }));
      await expect(
        collapseToFailedConflict({
          aggregateId: 'agg-x',
          representativeId: 'rep',
          removeMutationIds: ['rep', 'sib-1'],
          facts: { reason: 'CONFLICT', currentVersion: 7, currentUpdatedAt: '2026-07-02T00:00:00.000Z' },
        }),
      ).rejects.toBeInstanceOf(ConcurrentQueueMutationError);
      const all = await listAllMutations();
      expect(all.map((m) => m.id).sort()).toEqual(['concurrent', 'rep', 'sib-1']);
      expect(all.every((m) => m.status === 'pending')).toBe(true);
    });

    it('reEnqueueMutationWithFreshId re-queues as a fresh-id pending row and clears the rejection facts', async () => {
      await queueMutation(
        pendingMutation('old', {
          status: 'failed-conflict',
          reason: 'CONFLICT',
          currentVersion: 9,
          currentUpdatedAt: '2026-07-02T00:00:00.000Z',
          payload: { name: 'keep me' },
          expectedVersion: 5,
        }),
      );
      await reEnqueueMutationWithFreshId('old', 'fresh');
      const all = await listAllMutations();
      expect(all.map((m) => m.id)).toEqual(['fresh']);
      expect(all[0]).toMatchObject({
        status: 'pending',
        payload: { name: 'keep me' },
        expectedVersion: 5,
      });
      expect(all[0].reason).toBeUndefined();
      expect(all[0].currentVersion).toBeUndefined();
      expect(all[0].currentUpdatedAt).toBeUndefined();
    });

    it('reEnqueueMutationWithFreshId on a missing id is a no-op', async () => {
      await expect(reEnqueueMutationWithFreshId('ghost', 'fresh')).resolves.not.toThrow();
      expect(await listAllMutations()).toEqual([]);
    });

    it('listMutationsByAggregate returns every status for one aggregate', async () => {
      await queueMutation(pendingMutation('a', { aggregateId: 'agg-y', status: 'pending' }));
      await queueMutation(pendingMutation('b', { aggregateId: 'agg-y', status: 'failed-conflict' }));
      await queueMutation(pendingMutation('c', { aggregateId: 'agg-z', status: 'pending' }));
      const rows = await listMutationsByAggregate('agg-y');
      expect(rows.map((m) => m.id).sort()).toEqual(['a', 'b']);
    });

    it('listAllMutations returns rows of every status', async () => {
      await queueMutation(pendingMutation('a', { status: 'pending' }));
      await queueMutation(pendingMutation('b', { status: 'failed-conflict' }));
      const rows = await listAllMutations();
      expect(rows.map((m) => m.id).sort()).toEqual(['a', 'b']);
    });

    it('listFailedErrors only returns rows with status=failed-error', async () => {
      await queueMutation(pendingMutation('mut-1', { status: 'pending' }));
      await queueMutation(pendingMutation('mut-2', { status: 'failed-conflict' }));
      await queueMutation(pendingMutation('mut-3', { status: 'failed-error' }));
      const failedErrors = await listFailedErrors();
      expect(failedErrors.map((m) => m.id)).toEqual(['mut-3']);
    });

    it('removeMutation deletes the row', async () => {
      await queueMutation(pendingMutation('mut-1'));
      await removeMutation('mut-1');
      expect(await listPendingMutations()).toEqual([]);
    });

    it('removeMutations deletes every listed row and leaves the rest (poison-train drop)', async () => {
      await queueMutation(pendingMutation('a', { aggregateId: 'agg-x', operation: 'create' }));
      await queueMutation(pendingMutation('b', { aggregateId: 'agg-x', operation: 'update', expectedVersion: 1 }));
      await queueMutation(pendingMutation('c', { aggregateId: 'agg-x', operation: 'delete', expectedVersion: 2 }));
      await queueMutation(pendingMutation('other', { aggregateId: 'agg-y' }));
      await removeMutations(['a', 'b', 'c']);
      const all = await listAllMutations();
      expect(all.map((m) => m.id)).toEqual(['other']);
    });

    it('removeMutations ignores missing ids and is a no-op on an empty list', async () => {
      await queueMutation(pendingMutation('keep'));
      await removeMutations(['ghost']);
      await removeMutations([]);
      expect((await listAllMutations()).map((m) => m.id)).toEqual(['keep']);
    });

    // The `mutations` store is not migrated on load like the aggregate stores, only on read through these list functions, so a
    // stale row must be upgraded and the upgrade persisted before it reaches a push or an export.
    it('listPendingMutations upgrades a schema-behind row to the current schema before it can be pushed', async () => {
      await queueMutation(
        pendingMutation('mut-1', {
          aggregateType: 'account',
          schemaVersion: 6,
          payload: { type: 'RETIREMENT_ROTH_IRA', rothIraRegularContributionBasis: 25000 },
        }),
      );
      const [pending] = await listPendingMutations();
      expect(pending?.schemaVersion).toBe(7);
      expect(pending?.payload.rothIraRegularContributionBasis).toBeUndefined();
    });

    it('listPendingMutations persists the upgrade — a later read sees the same migrated row, not a fresh recompute', async () => {
      await queueMutation(
        pendingMutation('mut-1', {
          aggregateType: 'account',
          schemaVersion: 6,
          payload: { type: 'RETIREMENT_ROTH_IRA', rothIraRegularContributionBasis: 25000 },
        }),
      );
      await listPendingMutations();
      const [persisted] = await listAllMutations();
      expect(persisted?.schemaVersion).toBe(7);
      expect(persisted?.payload.rothIraRegularContributionBasis).toBeUndefined();
    });

    it('listAllMutations upgrades a schema-behind row before it can reach an export (unresolvedLocalChanges.queuedMutations)', async () => {
      await queueMutation(
        pendingMutation('mut-1', {
          aggregateType: 'account',
          schemaVersion: 6,
          status: 'failed-conflict',
          payload: { type: 'RETIREMENT_ROTH_401K', designatedRothBasis: 9000 },
        }),
      );
      const [row] = await listAllMutations();
      expect(row?.schemaVersion).toBe(7);
      expect(row?.payload.designatedRothBasis).toBeUndefined();
    });

    it('listFailedConflicts and listFailedErrors also upgrade schema-behind rows (both feed the exported queuedMutations stack)', async () => {
      await queueMutation(
        pendingMutation('conflict-1', {
          aggregateType: 'account',
          schemaVersion: 6,
          status: 'failed-conflict',
          payload: { type: 'RETIREMENT_ROTH_IRA', rothIraRegularContributionBasis: 25000 },
        }),
      );
      await queueMutation(
        pendingMutation('error-1', {
          aggregateType: 'account',
          schemaVersion: 6,
          status: 'failed-error',
          payload: { type: 'RETIREMENT_ROTH_IRA', rothIraRegularContributionBasis: 25000 },
        }),
      );
      const [conflict] = await listFailedConflicts();
      const [error] = await listFailedErrors();
      expect(conflict?.schemaVersion).toBe(7);
      expect(conflict?.payload.rothIraRegularContributionBasis).toBeUndefined();
      expect(error?.schemaVersion).toBe(7);
      expect(error?.payload.rothIraRegularContributionBasis).toBeUndefined();
    });

    // listAllMutations feeds the export's default `readAllMutations`, which must stay read-only: it migrates a schema-behind row
    // for its return value without writing back. Asserted on the raw IDBObjectStore.put, since a read-back cannot tell the difference.
    it('listAllMutations migrates the returned payload but does not persist the upgrade (export stays read-only)', async () => {
      await queueMutation(
        pendingMutation('mut-1', {
          aggregateType: 'account',
          schemaVersion: 6,
          payload: { type: 'RETIREMENT_ROTH_IRA', rothIraRegularContributionBasis: 25000 },
        }),
      );
      const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
      const [returned] = await listAllMutations();
      expect(returned?.schemaVersion).toBe(7);
      expect(returned?.payload.rothIraRegularContributionBasis).toBeUndefined();
      expect(putSpy).not.toHaveBeenCalled();
      putSpy.mockRestore();

      // The push-serving read migrates and persists, so the row is still schema-6 on disk until then.
      const persistPutSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
      const [pending] = await listPendingMutations();
      expect(pending?.schemaVersion).toBe(7);
      expect(persistPutSpy).toHaveBeenCalledTimes(1);
      persistPutSpy.mockRestore();
    });

    it('a mutation already at the current schema version is returned unchanged (no spurious rewrite)', async () => {
      const seeded = pendingMutation('mut-1', {
        aggregateType: 'account',
        schemaVersion: 7,
        payload: { type: 'RETIREMENT_ROTH_IRA' },
      });
      await queueMutation(seeded);
      const [pending] = await listPendingMutations();
      expect(pending).toEqual(seeded);
    });

    // The persisted upgrade is cleanup, not a precondition: when the write fails (storage at quota is the realistic case),
    // listPendingMutations must still hand the flush its rows, because draining the queue is what frees the space.
    it('listPendingMutations still returns the upgraded rows when persisting the upgrade fails (persist is best-effort)', async () => {
      await queueMutation(
        pendingMutation('mut-1', {
          aggregateType: 'account',
          schemaVersion: 6,
          payload: { type: 'RETIREMENT_ROTH_IRA', rothIraRegularContributionBasis: 25000 },
        }),
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const failingPut = vi
        .spyOn(IDBObjectStore.prototype, 'put')
        .mockImplementation(function (this: IDBObjectStore) {
          this.transaction.abort();
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        });
      try {
        const [pending] = await listPendingMutations();
        expect(pending?.schemaVersion).toBe(7);
        expect(pending?.payload.rothIraRegularContributionBasis).toBeUndefined();
        expect(failingPut).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        failingPut.mockRestore();
        warn.mockRestore();
      }

      const persistPutSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
      const [pending] = await listPendingMutations();
      expect(pending?.schemaVersion).toBe(7);
      expect(persistPutSpy).toHaveBeenCalledTimes(1);
      persistPutSpy.mockRestore();
    });

    // The persist re-reads each row inside its own readwrite transaction, so a writer landing after the readonly list is never clobbered by a stale put.
    it('the persisted upgrade never resurrects a row removed between the read and the write', async () => {
      await queueMutation(
        pendingMutation('mut-1', {
          aggregateType: 'account',
          schemaVersion: 6,
          payload: { type: 'RETIREMENT_ROTH_IRA', rothIraRegularContributionBasis: 25000 },
        }),
      );
      // Land the removal from inside the persist transaction's own `get`, after the readonly list took its snapshot.
      const originalGet = IDBObjectStore.prototype.get;
      const getSpy = vi
        .spyOn(IDBObjectStore.prototype, 'get')
        .mockImplementationOnce(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
          this.delete(key);
          return originalGet.call(this, key);
        });
      const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
      try {
        const [pending] = await listPendingMutations();
        expect(pending?.schemaVersion).toBe(7);
        expect(putSpy).not.toHaveBeenCalled();
      } finally {
        getSpy.mockRestore();
        putSpy.mockRestore();
      }
      expect(await listAllMutations()).toEqual([]);
    });
  });

  describe('writeAccountWithRetypeGuard', () => {
    function accountAggregate(
      id: string,
      overrides: Partial<AccountPayload> = {},
    ): Aggregate<AccountPayload> {
      return {
        id,
        householdId: HH,
        aggregateType: 'account',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-05-01T00:00:00Z',
        deviceId: DEVICE,
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

    function balanceAggregate(
      id: string,
      accountId: string,
      overrides: Partial<AccountBalancePayload> = {},
      deletedAt?: string,
    ): Aggregate<AccountBalancePayload> {
      return {
        id,
        householdId: HH,
        aggregateType: 'accountBalance',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-05-01T00:00:00Z',
        deletedAt,
        deviceId: DEVICE,
        payload: {
          accountId,
          year: 2020,
          lastUpdated: '2020-12-31T00:00:00Z',
          startingBalance: 0,
          startingBalancePreTax: null,
          startingBalancePostTax: null,
          contributionsPreTax: null,
          contributionsPostTax: null,
          companyContributions: 0,
          companyContributionsPreTax: null,
          companyContributionsPostTax: null,
          rollover: 0,
          distributions: 0,
          endingBalance: 0,
          endingBalancePreTax: null,
          endingBalancePostTax: null,
          totalContributions: 0,
          comment: null,
          ...overrides,
        },
      };
    }

    function guardedMutation(accountId: string): PendingMutation {
      return {
        id: 'mut-1',
        aggregateId: accountId,
        aggregateType: 'account',
        operation: 'update',
        expectedVersion: 1,
        schemaVersion: 1,
        payload: {},
        timestamp: Date.now(),
        deviceId: DEVICE,
        status: 'pending',
      };
    }

    it('a refusal writes neither the aggregate nor the queue row and fires no signal', async () => {
      await putAggregate('account', accountAggregate('acc-1'));
      const listener = vi.fn();
      const unsubscribe = subscribeToStoreChanges('accounts', listener);
      await expect(
        writeAccountWithRetypeGuard({
          accountId: 'acc-1',
          needsBalanceRead: () => true,
          decide: () => ({ refuse: true }),
        }),
      ).rejects.toBeInstanceOf(AccountRetypeBlockedError);
      expect(listener).not.toHaveBeenCalled();
      const stored = await getAggregate('account', 'acc-1');
      expect(stored?.version).toBe(1);
      expect(await listAllMutations()).toEqual([]);
      unsubscribe();
    });

    it('a commit writes both and fires the account store’s signal exactly once', async () => {
      await putAggregate('account', accountAggregate('acc-1'));
      const listener = vi.fn();
      const unsubscribe = subscribeToStoreChanges('accounts', listener);
      const written = await writeAccountWithRetypeGuard({
        accountId: 'acc-1',
        needsBalanceRead: () => false,
        decide: (freshAccount) => ({
          aggregate: {
            ...freshAccount,
            version: 2,
            payload: { ...freshAccount.payload, name: 'Renamed' },
          },
          mutation: guardedMutation('acc-1'),
        }),
      });
      expect(written.aggregate.payload.name).toBe('Renamed');
      expect(listener).toHaveBeenCalledTimes(1);
      const stored = await getAggregate('account', 'acc-1');
      expect(stored?.payload.name).toBe('Renamed');
      expect(stored?.version).toBe(2);
      expect(await listAllMutations()).toHaveLength(1);
      unsubscribe();
    });

    it('tombstoned balance rows never reach the decide callback', async () => {
      await putAggregate('account', accountAggregate('acc-1'));
      await putAggregate(
        'accountBalance',
        balanceAggregate('bal-1', 'acc-1', { endingBalance: 5000 }, '2026-01-01T00:00:00Z'),
      );
      let seenBalances: unknown;
      await writeAccountWithRetypeGuard({
        accountId: 'acc-1',
        needsBalanceRead: () => true,
        decide: (freshAccount, balances) => {
          seenBalances = balances;
          return { aggregate: freshAccount, mutation: guardedMutation('acc-1') };
        },
      });
      expect(seenBalances).toEqual([]);
    });

    it('a tombstoned account row reads as absent — the general save-failure path, not a typed refusal', async () => {
      await putAggregate('account', {
        ...accountAggregate('acc-1'),
        deletedAt: '2026-01-01T00:00:00Z',
      });
      let caught: unknown;
      try {
        await writeAccountWithRetypeGuard({
          accountId: 'acc-1',
          needsBalanceRead: () => false,
          decide: () => {
            throw new Error('decide must not run — the account read fails first');
          },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(AccountRetypeBlockedError);
      expect(caught).not.toBeInstanceOf(AccountRetypeCheckFailedError);
      expect((caught as Error).message).toMatch(/not found/i);
    });

    it('a throwing decide callback rolls the whole transaction back', async () => {
      await putAggregate('account', accountAggregate('acc-1'));
      await expect(
        writeAccountWithRetypeGuard({
          accountId: 'acc-1',
          needsBalanceRead: () => false,
          decide: () => {
            throw new Error('boom');
          },
        }),
      ).rejects.toThrow('boom');
      const stored = await getAggregate('account', 'acc-1');
      expect(stored?.version).toBe(1);
      expect(await listAllMutations()).toEqual([]);
    });

    it('a failed in-transaction balance read is AccountRetypeCheckFailedError, distinct from a refusal', async () => {
      await putAggregate('account', accountAggregate('acc-1'));
      const originalGetAll = IDBObjectStore.prototype.getAll;
      const spy = vi
        .spyOn(IDBObjectStore.prototype, 'getAll')
        .mockImplementation(function (
          this: IDBObjectStore,
          ...args: Parameters<typeof originalGetAll>
        ) {
          if (this.name === 'accountBalances') {
            throw new Error('injected getAll failure');
          }
          return originalGetAll.apply(this, args);
        });
      try {
        await expect(
          writeAccountWithRetypeGuard({
            accountId: 'acc-1',
            needsBalanceRead: () => true,
            decide: () => {
              throw new Error('decide must not run — the balance read fails first');
            },
          }),
        ).rejects.toBeInstanceOf(AccountRetypeCheckFailedError);
      } finally {
        spy.mockRestore();
      }
      const stored = await getAggregate('account', 'acc-1');
      expect(stored?.version).toBe(1);
      expect(await listAllMutations()).toEqual([]);
    });
  });

  describe('device metadata', () => {
    it('readDeviceMetadata returns null when nothing was written', async () => {
      expect(await readDeviceMetadata()).toBeNull();
    });

    it('writeDeviceMetadata then readDeviceMetadata round-trips', async () => {
      await writeDeviceMetadata({
        deviceId: 'dev-x',
        syncCursor: '0',
        lastSyncedAt: null,
        displayName: 'Test device',
      });
      const got = await readDeviceMetadata();
      expect(got?.deviceId).toBe('dev-x');
      expect(got?.displayName).toBe('Test device');
    });

    it('round-trips the envelopeSetVersion rollback pin', async () => {
      await writeDeviceMetadata({
        deviceId: 'dev-x',
        syncCursor: '0',
        lastSyncedAt: null,
        displayName: 'Test device',
        envelopeSetVersion: 4,
      });
      expect((await readDeviceMetadata())?.envelopeSetVersion).toBe(4);
    });

    it('leaves envelopeSetVersion undefined when not written (old devices = no pin)', async () => {
      await writeDeviceMetadata({
        deviceId: 'dev-x',
        syncCursor: '0',
        lastSyncedAt: null,
        displayName: 'Test device',
      });
      expect((await readDeviceMetadata())?.envelopeSetVersion).toBeUndefined();
    });
  });

  describe('clearAllStores', () => {
    it('drops every aggregate + mutation row but leaves device metadata in place', async () => {
      await putAggregate('householdMember', memberAgg('hm-1'));
      await queueMutation(pendingMutation('mut-1'));
      await writeDeviceMetadata({
        deviceId: 'dev-x',
        syncCursor: '0',
        lastSyncedAt: null,
        displayName: '',
      });
      await clearAllStores();
      expect(await listAggregates('householdMember')).toEqual([]);
      expect(await listPendingMutations()).toEqual([]);
      expect(await readDeviceMetadata()).not.toBeNull();
    });

    it('drops the cached HDK so a Full Sync reset leaves no stale unlock key', async () => {
      await writeKeyCacheEntry({
        id: KEY_CACHE_ID,
        householdId: HH,
        hdkExported: new Uint8Array([1, 2, 3, 4]).buffer,
      });
      expect(await readKeyCacheEntry()).not.toBeNull();
      await clearAllStores();
      expect(await readKeyCacheEntry()).toBeNull();
    });
  });

  describe('hasForeignHouseholdData (cross-user IDB-leak guard)', () => {
    it('returns false when every store is empty (legitimate first login)', async () => {
      expect(await hasForeignHouseholdData('hh-anything')).toBe(false);
    });

    it('returns false when every row matches the expected householdId', async () => {
      await putAggregate('householdMember', memberAgg('hm-1'));
      await putAggregate('householdMember', memberAgg('hm-2'));
      expect(await hasForeignHouseholdData(HH)).toBe(false);
    });

    it('returns true when any aggregate row carries a different householdId', async () => {
      await putAggregate('householdMember', memberAgg('hm-1'));
      await putAggregate('householdMember', {
        ...memberAgg('hm-2'),
        householdId: 'hh-previous-user',
      });
      expect(await hasForeignHouseholdData(HH)).toBe(true);
    });

    it('returns true when ALL rows belong to a foreign household (the leak case)', async () => {
      await putAggregate('householdMember', {
        ...memberAgg('hm-1'),
        householdId: 'hh-previous-user',
      });
      expect(await hasForeignHouseholdData('hh-new-user')).toBe(true);
    });

    it('returns true when foreign rows live in a non-householdMember store', async () => {
      // The audit must walk every store, not just the first.
      await putAggregate('account', {
        id: 'acc-1',
        householdId: 'hh-previous-user',
        aggregateType: 'account',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-05-01T00:00:00Z',
        deviceId: DEVICE,
        payload: {
          name: 'Bank',
          ownerHouseholdMemberId: 'hm-1',
          accountType: 'checking',
          taxQualified: false,
        },
      } as Aggregate);
      expect(await hasForeignHouseholdData('hh-new-user')).toBe(true);
    });
  });

  describe('dropLocalDatabase', () => {
    it('removes everything including device metadata', async () => {
      await putAggregate('householdMember', memberAgg('hm-1'));
      await queueMutation(pendingMutation('mut-1'));
      await writeDeviceMetadata({
        deviceId: 'dev-x',
        syncCursor: '0',
        lastSyncedAt: null,
        displayName: '',
      });
      await dropLocalDatabase();
      expect(await listAggregates('householdMember')).toEqual([]);
      expect(await listPendingMutations()).toEqual([]);
      expect(await readDeviceMetadata()).toBeNull();
    });

    it('rejects with DatabaseDropBlockedError when the delete stays blocked past the timeout', async () => {
      // Another tab holding the DB open makes deleteDatabase fire `onblocked` and never `onsuccess`; the 2 s cap must reject so the caller fails closed. The string-keyed spy keeps raw `indexedDB.deleteDatabase` access out of this file (audited-home lint).
      const blockedReq = { onsuccess: null, onerror: null, onblocked: null } as unknown as IDBOpenDBRequest;
      const deleteSpy = vi
        .spyOn(indexedDB, 'deleteDatabase')
        .mockImplementation(() => {
          queueMicrotask(() => blockedReq.onblocked?.(new Event('blocked') as never));
          return blockedReq;
        });
      try {
        vi.useFakeTimers();
        const dropPromise = dropLocalDatabase();
        const assertion = expect(dropPromise).rejects.toBeInstanceOf(
          DatabaseDropBlockedError,
        );
        await vi.advanceTimersByTimeAsync(2000);
        await assertion;
      } finally {
        vi.useRealTimers();
        deleteSpy.mockRestore();
      }
    });
  });

  describe('db() upgrade blocked by an older connection', () => {
    // fake-indexeddb cannot raise a real `blocked`, so the test drives a bare open request.
    function stubOpenRequest(): { request: IDBOpenDBRequest; open: ReturnType<typeof vi.spyOn> } {
      const request = new IDBOpenDBRequest();
      const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
        queueMicrotask(() => request.dispatchEvent(new IDBVersionChangeEvent('blocked')));
        return request;
      });
      return { request, open };
    }

    function stubHandle(): EventTarget & { close: ReturnType<typeof vi.fn> } {
      return Object.assign(new EventTarget(), { close: vi.fn() });
    }

    function resolveOpen(request: IDBOpenDBRequest, handle: EventTarget): void {
      Object.defineProperty(request, 'result', { value: handle });
      request.dispatchEvent(new IDBVersionChangeEvent('success'));
    }

    beforeEach(async () => {
      await dropLocalDatabase();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(async () => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await dropLocalDatabase();
    });

    it('rejects with DatabaseUpgradeBlockedError once the cap passes, then retries the open', async () => {
      const { open } = stubOpenRequest();
      const first = expect(db()).rejects.toMatchObject({ name: 'DatabaseUpgradeBlockedError' });
      await vi.advanceTimersByTimeAsync(2000);
      await first;

      const retry = expect(db()).rejects.toMatchObject({ name: 'DatabaseUpgradeBlockedError' });
      await vi.advanceTimersByTimeAsync(2000);
      await retry;
      expect(open).toHaveBeenCalledTimes(2);
    });

    it('closes and discards a handle that resolves after the timeout', async () => {
      const { request } = stubOpenRequest();
      const timedOut = expect(db()).rejects.toMatchObject({ name: 'DatabaseUpgradeBlockedError' });
      await vi.advanceTimersByTimeAsync(2000);
      await timedOut;

      const late = stubHandle();
      resolveOpen(request, late);
      await vi.advanceTimersByTimeAsync(0);
      expect(late.close).toHaveBeenCalledTimes(1);
    });

    it('resolves with the handle when the block lifts before the cap', async () => {
      const { request } = stubOpenRequest();
      const handle = stubHandle();
      const opened = db();
      await vi.advanceTimersByTimeAsync(1000);
      resolveOpen(request, handle);
      await expect(opened).resolves.toBe(handle);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(db()).resolves.toBe(handle);
    });
  });
});
