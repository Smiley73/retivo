// Pins each pull-apply helper's input-to-output behaviour independently of the SyncContext integration suites.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearAllStores, getAggregateIncludingDeleted, listFailedConflicts, listPendingMutations, queueMutation } from '../db/store';
import { setRegisteredDeviceId } from './device-id';
import {
  applyPulledChange,
  assertNoSchemaAhead,
  bootstrapSchemaCarriers,
  idFragment,
  plaintextPayload,
  repairRejections,
  SchemaAheadError,
  UnauthenticatedPayloadError,
} from './pull-apply';

describe('idFragment', () => {
  it('groups the first 8 hex chars into 4-char groups', () => {
    expect(idFragment('d3f08686-1234-5678-9abc-def012345678')).toBe('d3f0-8686');
  });

  it('groups a short (<8 hex) prefix on the same 4-char boundary', () => {
    expect(idFragment('1234567')).toBe('1234-567');
  });

  it('returns empty string for undefined', () => {
    expect(idFragment(undefined)).toBe('');
  });
});

describe('plaintextPayload', () => {
  it('passes a plain payload through unchanged', () => {
    const payload = { name: 'Checking', balance: 100 };
    expect(plaintextPayload(payload)).toBe(payload);
  });

  it('passes an encryptionVersion-carrying payload through unchanged (already decrypted)', () => {
    const payload = { encryptionVersion: 1, name: 'Checking' };
    expect(plaintextPayload(payload)).toBe(payload);
  });

  // A strict envelope reaching this point means the transport guard was bypassed: refuse it rather than write ciphertext as plaintext.
  it('throws UnauthenticatedPayloadError on a strict-envelope-shaped payload', () => {
    const envelope = {
      encryptionVersion: 1,
      alg: 'AES-256-GCM',
      keyId: 'hh-1',
      nonce: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'ciphertext',
    };
    let caught: unknown;
    try {
      plaintextPayload(envelope);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnauthenticatedPayloadError);
    expect((caught as UnauthenticatedPayloadError).phase).toBe('apply');
    expect((caught as UnauthenticatedPayloadError).reason).toBe('undecrypted-at-write');
  });
});

describe('assertNoSchemaAhead', () => {
  it('does not throw when every row is at or below the known schema version', () => {
    expect(() =>
      assertNoSchemaAhead([{ aggregateType: 'account', schemaVersion: 1 }]),
    ).not.toThrow();
  });

  it('throws SchemaAheadError with aggregateType/theirVersion/ourCurrent on a future version', () => {
    let caught: unknown;
    try {
      assertNoSchemaAhead([{ aggregateType: 'account', schemaVersion: 999 }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaAheadError);
    const err = caught as SchemaAheadError;
    expect(err.aggregateType).toBe('account');
    expect(err.theirVersion).toBe(999);
  });

  it('skips an unknown aggregateType rather than throwing', () => {
    expect(() =>
      assertNoSchemaAhead([{ aggregateType: 'not-a-real-type', schemaVersion: 999 }]),
    ).not.toThrow();
  });
});

describe('bootstrapSchemaCarriers', () => {
  it('combines snapshot aggregates and post-snapshot mutations into one carrier list', () => {
    const carriers = bootstrapSchemaCarriers({
      snapshotId: null,
      workspaceSnapshot: {
        householdId: 'hh-1',
        aggregates: [{ aggregateType: 'account', schemaVersion: 1 } as never],
      },
      postSnapshotMutations: [{ aggregateType: 'scenario', schemaVersion: 2 } as never],
      syncCursor: '0',
      timestamp: new Date().toISOString(),
    });
    expect(carriers).toEqual([
      { aggregateType: 'account', schemaVersion: 1 },
      { aggregateType: 'scenario', schemaVersion: 2 },
    ]);
  });
});

describe('applyPulledChange', () => {
  beforeEach(async () => {
    await clearAllStores();
  });
  afterEach(async () => {
    await clearAllStores();
  });

  it('writes a create/update change with deletedAt undefined', async () => {
    const applied = await applyPulledChange(
      {
        aggregateType: 'account',
        aggregateId: 'agg-1',
        operation: 'update',
        schemaVersion: 1,
        version: 2,
        updatedAt: '2026-01-01T00:00:00.000Z',
        deviceId: 'dev-1',
        payload: { name: 'Checking' },
      } as never,
      'hh-1',
    );
    expect(applied).toBe(true);
    const row = await getAggregateIncludingDeleted('account', 'agg-1');
    expect(row?.deletedAt).toBeUndefined();
    expect(row?.payload).toEqual({ name: 'Checking' });
  });

  it('marks deletedAt = updatedAt for a delete operation', async () => {
    await applyPulledChange(
      {
        aggregateType: 'account',
        aggregateId: 'agg-2',
        operation: 'delete',
        schemaVersion: 1,
        version: 3,
        updatedAt: '2026-01-02T00:00:00.000Z',
        deviceId: 'dev-1',
        payload: {},
      } as never,
      'hh-1',
    );
    const row = await getAggregateIncludingDeleted('account', 'agg-2');
    expect(row?.deletedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('skips and returns false for an unknown aggregateType, writing nothing', async () => {
    const applied = await applyPulledChange(
      {
        aggregateType: 'not-a-real-type',
        aggregateId: 'agg-3',
        operation: 'update',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        deviceId: 'dev-1',
        payload: {},
      } as never,
      'hh-1',
    );
    expect(applied).toBe(false);
  });

  // Every apply path funnels through `applyPulledChange`, so an envelope-shaped payload reaching it must throw and write nothing.
  it('propagates UnauthenticatedPayloadError and writes nothing for a strict-envelope-shaped payload', async () => {
    await expect(
      applyPulledChange(
        {
          aggregateType: 'account',
          aggregateId: 'agg-4',
          operation: 'update',
          schemaVersion: 1,
          version: 1,
          updatedAt: '2026-01-01T00:00:00.000Z',
          deviceId: 'dev-1',
          payload: {
            encryptionVersion: 1,
            alg: 'AES-256-GCM',
            keyId: 'hh-1',
            nonce: 'AAAAAAAAAAAAAAAA',
            ciphertext: 'ciphertext',
          },
        } as never,
        'hh-1',
      ),
    ).rejects.toBeInstanceOf(UnauthenticatedPayloadError);
    expect(await getAggregateIncludingDeleted('account', 'agg-4')).toBeNull();
  });
});

describe('repairRejections', () => {
  beforeEach(async () => {
    await clearAllStores();
    setRegisteredDeviceId('dev-test');
  });
  afterEach(async () => {
    await clearAllStores();
  });

  it('drops the rejected mutation on a delete/NOT_FOUND (intent already holds)', async () => {
    await queueMutation({
      id: 'm-1',
      aggregateId: 'agg-1',
      aggregateType: 'account',
      operation: 'delete',
      expectedVersion: 1,
      schemaVersion: 1,
      payload: {},
      timestamp: 1000,
      deviceId: 'dev-test',
      status: 'pending',
    });

    await repairRejections(
      [
        {
          status: 'rejected',
          mutationId: 'm-1',
          aggregateId: 'agg-1',
          reason: 'NOT_FOUND',
          currentVersion: 1,
          currentUpdatedAt: '2026-01-01T00:00:00.000Z',
          currentDeletedAt: null,
        },
      ],
      'hh-1',
    );

    const pending = await listPendingMutations();
    expect(pending.find((m) => m.id === 'm-1')).toBeUndefined();
  });

  it('parks an off-enum SCHEMA_MISMATCH rejection as failed-conflict (passthrough)', async () => {
    await queueMutation({
      id: 'm-2',
      aggregateId: 'agg-2',
      aggregateType: 'account',
      operation: 'update',
      expectedVersion: 5,
      schemaVersion: 1,
      payload: { name: 'Savings' },
      timestamp: 1000,
      deviceId: 'dev-test',
      status: 'pending',
    });

    await repairRejections(
      [
        {
          status: 'rejected',
          mutationId: 'm-2',
          aggregateId: 'agg-2',
          reason: 'SCHEMA_MISMATCH',
          currentVersion: 5,
          currentUpdatedAt: '2026-01-01T00:00:00.000Z',
          currentDeletedAt: null,
        },
      ],
      'hh-1',
    );

    const conflicts = await listFailedConflicts();
    expect(conflicts.find((m) => m.id === 'm-2')).toBeDefined();
  });

  it('collapses and re-queues on a rebase (CONFLICT with currentVersion < expectedVersion)', async () => {
    await queueMutation({
      id: 'm-3',
      aggregateId: 'agg-3',
      aggregateType: 'account',
      operation: 'update',
      expectedVersion: 5,
      schemaVersion: 1,
      payload: { name: 'Rebased' },
      timestamp: 1000,
      deviceId: 'dev-test',
      status: 'pending',
    });

    await repairRejections(
      [
        {
          status: 'rejected',
          mutationId: 'm-3',
          aggregateId: 'agg-3',
          reason: 'CONFLICT',
          currentVersion: 3,
          currentUpdatedAt: '2026-01-01T00:00:00.000Z',
          currentDeletedAt: null,
        },
      ],
      'hh-1',
    );

    const pending = await listPendingMutations();
    expect(pending.find((m) => m.id === 'm-3')).toBeUndefined();
    const requeued = pending.find((m) => m.aggregateId === 'agg-3');
    expect(requeued).toBeDefined();
    expect(requeued?.operation).toBe('update');
    expect(requeued?.expectedVersion).toBe(3);
    expect(requeued?.payload).toEqual({ name: 'Rebased' });

    const conflicts = await listFailedConflicts();
    expect(conflicts.find((m) => m.aggregateId === 'agg-3')).toBeUndefined();
  });

  it('folds the stack to one parked failed-conflict on an escalate (update/NOT_FOUND)', async () => {
    await queueMutation({
      id: 'm-4',
      aggregateId: 'agg-4',
      aggregateType: 'account',
      operation: 'update',
      expectedVersion: 2,
      schemaVersion: 1,
      payload: { name: 'Gone' },
      timestamp: 1000,
      deviceId: 'dev-test',
      status: 'pending',
    });

    await repairRejections(
      [
        {
          status: 'rejected',
          mutationId: 'm-4',
          aggregateId: 'agg-4',
          reason: 'NOT_FOUND',
          currentVersion: 2,
          currentUpdatedAt: '2026-01-01T00:00:00.000Z',
          currentDeletedAt: null,
        },
      ],
      'hh-1',
    );

    const pending = await listPendingMutations();
    expect(pending.find((m) => m.id === 'm-4')).toBeUndefined();

    const conflicts = await listFailedConflicts();
    const parked = conflicts.find((m) => m.aggregateId === 'agg-4');
    expect(parked).toBeDefined();
    expect(parked?.id).toBe('m-4');
    expect(parked?.reason).toBe('NOT_FOUND');
  });

  // The `ConcurrentQueueMutationError` raced-retry path has no seam to interleave a write inside the collapse transaction without mocking store internals, so it is not tested.
});
