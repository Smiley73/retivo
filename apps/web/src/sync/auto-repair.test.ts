// Unit tests for the pure auto-repair classifier: every routing case, the poison-train collapse and the re-base-conflicts-again escalation.
import { describe, expect, it } from 'vitest';

import type { PendingMutation } from '../db/types';
import { decide, latestEdit, type RepairRejection } from './auto-repair';

function mut(overrides: Partial<PendingMutation> = {}): PendingMutation {
  return {
    id: 'mut-1',
    aggregateId: 'agg-1',
    aggregateType: 'scenario',
    operation: 'update',
    expectedVersion: 5,
    schemaVersion: 1,
    payload: { name: 'x' },
    timestamp: 1000,
    deviceId: 'dev-1',
    status: 'pending',
    ...overrides,
  };
}

function rej(overrides: Partial<RepairRejection> = {}): RepairRejection {
  return {
    mutationId: 'mut-1',
    aggregateId: 'agg-1',
    reason: 'CONFLICT',
    currentVersion: 5,
    currentUpdatedAt: '2026-07-02T00:00:00.000Z',
    currentDeletedAt: null,
    ...overrides,
  };
}

describe('auto-repair decide', () => {
  it('drops a delete rejected NOT_FOUND (intent already holds)', () => {
    const m = mut({ operation: 'delete' });
    const d = decide(rej({ reason: 'NOT_FOUND', currentVersion: 0 }), [m]);
    expect(d).toEqual({ kind: 'drop', code: 'delete-not-found', removeMutationIds: ['mut-1'] });
  });

  it('drops a delete over an existing tombstone regardless of version', () => {
    const m = mut({ operation: 'delete', expectedVersion: 4 });
    const d = decide(
      rej({ reason: 'CONFLICT', currentVersion: 9, currentDeletedAt: '2026-07-01T00:00:00.000Z' }),
      [m],
    );
    expect(d).toEqual({ kind: 'drop', code: 'delete-over-tombstone', removeMutationIds: ['mut-1'] });
  });

  it('escalates an update rejected NOT_FOUND (server row genuinely gone)', () => {
    const m = mut({ operation: 'update' });
    const d = decide(rej({ reason: 'NOT_FOUND', currentVersion: 0 }), [m]);
    expect(d).toEqual({ kind: 'escalate', code: 'update-not-found', representativeId: 'mut-1' });
  });

  it('converts a create over a tombstone to update @ currentVersion (silent)', () => {
    const m = mut({ operation: 'create', expectedVersion: 0, payload: { name: 'reseed' } });
    const d = decide(
      rej({ reason: 'CONFLICT', currentVersion: 3, currentDeletedAt: '2026-07-01T00:00:00.000Z' }),
      [m],
    );
    expect(d).toEqual({
      kind: 'rebase',
      code: 'create-over-tombstone',
      operation: 'update',
      expectedVersion: 3,
      payload: { name: 'reseed' },
    });
  });

  it('escalates a create over a LIVE row (currentDeletedAt null)', () => {
    const m = mut({ operation: 'create', expectedVersion: 0 });
    const d = decide(rej({ reason: 'CONFLICT', currentVersion: 2, currentDeletedAt: null }), [m]);
    expect(d).toEqual({ kind: 'escalate', code: 'create-over-live', representativeId: 'mut-1' });
  });

  it('silently re-bases an update with currentVersion < expectedVersion', () => {
    const m = mut({ operation: 'update', expectedVersion: 12, payload: { name: 'keep-me' } });
    const d = decide(rej({ currentVersion: 10 }), [m]);
    expect(d).toEqual({
      kind: 'rebase',
      code: 'rebase-inflation',
      operation: 'update',
      expectedVersion: 10,
      payload: { name: 'keep-me' },
    });
  });

  it('silently re-bases a DELETE with currentVersion < expectedVersion', () => {
    const m = mut({ operation: 'delete', expectedVersion: 12, payload: { name: 'tombstone-me' } });
    const d = decide(rej({ currentVersion: 10 }), [m]);
    expect(d).toEqual({
      kind: 'rebase',
      code: 'rebase-inflation',
      operation: 'delete',
      expectedVersion: 10,
      payload: { name: 'tombstone-me' },
    });
  });

  it('escalates an update with currentVersion > expectedVersion (real advance / wedge)', () => {
    const m = mut({ operation: 'update', expectedVersion: 10 });
    const d = decide(rej({ currentVersion: 13 }), [m]);
    expect(d).toEqual({ kind: 'escalate', code: 'server-ahead', representativeId: 'mut-1' });
  });

  it('escalates a DELETE with currentVersion > expectedVersion', () => {
    const m = mut({ operation: 'delete', expectedVersion: 10 });
    const d = decide(rej({ currentVersion: 13 }), [m]);
    expect(d).toEqual({ kind: 'escalate', code: 'server-ahead', representativeId: 'mut-1' });
  });

  it('passes through when currentVersion == expectedVersion (unreachable)', () => {
    const m = mut({ operation: 'update', expectedVersion: 7 });
    const d = decide(rej({ currentVersion: 7 }), [m]);
    expect(d).toEqual({ kind: 'passthrough', code: 'unreachable-equal' });
  });

  it('passes through an unknown / off-enum reason', () => {
    const m = mut({ operation: 'update' });
    const d = decide(rej({ reason: 'SCHEMA_MISMATCH', currentVersion: 9 }), [m]);
    expect(d).toEqual({ kind: 'passthrough', code: 'unknown' });
  });

  it('passes through when the rejected mutation is missing from the stack', () => {
    const d = decide(rej({ mutationId: 'ghost' }), [mut()]);
    expect(d).toEqual({ kind: 'passthrough', code: 'unknown' });
  });
});

describe('auto-repair poison-train collapse', () => {
  it('collapses N stacked inflation edits to one re-based mutation at the latest payload', () => {
    const stack: PendingMutation[] = [
      mut({ id: 'a', operation: 'update', expectedVersion: 10, payload: { name: 'v1' }, timestamp: 1000 }),
      mut({ id: 'b', operation: 'update', expectedVersion: 11, payload: { name: 'v2' }, timestamp: 1001 }),
      mut({ id: 'c', operation: 'update', expectedVersion: 12, payload: { name: 'v3' }, timestamp: 1002 }),
    ];
    const d = decide(rej({ mutationId: 'a', currentVersion: 9 }), stack);
    expect(d).toEqual({
      kind: 'rebase',
      code: 'rebase-inflation',
      operation: 'update',
      expectedVersion: 9,
      payload: { name: 'v3' }, // latest edit wins
    });
  });

  it('a trailing delete wins the collapse (operation-aware)', () => {
    const stack: PendingMutation[] = [
      mut({ id: 'a', operation: 'update', expectedVersion: 10, payload: { name: 'v1' }, timestamp: 1000 }),
      mut({ id: 'b', operation: 'delete', expectedVersion: 11, payload: { name: 'v1' }, timestamp: 1001 }),
    ];
    const d = decide(rej({ mutationId: 'a', currentVersion: 9 }), stack);
    expect(d).toMatchObject({ kind: 'rebase', operation: 'delete', expectedVersion: 9 });
  });

  it('drops (never resurrects) a create-over-tombstone whose stack ends in a delete', () => {
    // A trailing delete means the intent is "stay deleted": the decision must drop, never re-queue an `update` that resurrects the aggregate.
    const stack: PendingMutation[] = [
      mut({ id: 'a', operation: 'create', expectedVersion: 0, payload: { name: 'draft' }, timestamp: 1000 }),
      mut({ id: 'b', operation: 'delete', expectedVersion: 1, payload: { name: 'draft' }, timestamp: 1001 }),
    ];
    const d = decide(
      rej({ mutationId: 'a', reason: 'CONFLICT', currentVersion: 3, currentDeletedAt: '2026-07-01T00:00:00.000Z' }),
      stack,
    );
    // A stranded sibling `update` would push stale against the tombstoned version and escalate, so every stack row is removed.
    expect(d).toEqual({
      kind: 'drop',
      code: 'delete-over-tombstone',
      removeMutationIds: ['a', 'b'],
    });
    expect(d.kind).not.toBe('rebase');
  });

  it('still rebases a create-over-tombstone to update when the latest edit is not a delete', () => {
    const stack: PendingMutation[] = [
      mut({ id: 'a', operation: 'create', expectedVersion: 0, payload: { name: 'v1' }, timestamp: 1000 }),
      mut({ id: 'b', operation: 'delete', expectedVersion: 1, payload: { name: 'v1' }, timestamp: 1001 }),
      mut({ id: 'c', operation: 'create', expectedVersion: 0, payload: { name: 'v3' }, timestamp: 1002 }),
    ];
    const d = decide(
      rej({ mutationId: 'a', reason: 'CONFLICT', currentVersion: 4, currentDeletedAt: '2026-07-01T00:00:00.000Z' }),
      stack,
    );
    expect(d).toEqual({
      kind: 'rebase',
      code: 'create-over-tombstone',
      operation: 'update',
      expectedVersion: 4,
      payload: { name: 'v3' },
    });
  });

  it('latestEdit picks the highest-timestamp row', () => {
    const stack: PendingMutation[] = [
      mut({ id: 'a', timestamp: 1000 }),
      mut({ id: 'c', timestamp: 1002 }),
      mut({ id: 'b', timestamp: 1001 }),
    ];
    expect(latestEdit(stack).id).toBe('c');
  });
});

describe('auto-repair bounded via version monotonicity', () => {
  it('a re-based mutation that conflicts AGAIN escalates rather than re-basing twice', () => {
    const rebased = mut({ operation: 'update', expectedVersion: 10 });
    const d = decide(rej({ currentVersion: 11 }), [rebased]);
    expect(d.kind).toBe('escalate');
    const d2 = decide(rej({ currentVersion: 10 }), [mut({ operation: 'update', expectedVersion: 10 })]);
    expect(d2).toEqual({ kind: 'passthrough', code: 'unreachable-equal' });
  });
});
