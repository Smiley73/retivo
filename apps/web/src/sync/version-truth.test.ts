/**
 * Version-truth restoration tests. Seed
 * inflated local versions, run the helper after a queue clear, and assert local
 * versions clamp down to the server-acknowledged base so the next queued
 * mutation would not conflict. The realign only ever de-inflates.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAllStores,
  clearMutationQueue,
  getAggregate,
  listAllMutations,
  putAggregate,
  queueMutation,
} from '../db/store';
import type { Aggregate, PendingMutation } from '../db/types';
import {
  realignAggregateVersions,
  serverAcknowledgedVersions,
} from './version-truth';

function scenarioAgg(id: string, version: number): Aggregate {
  return {
    id,
    householdId: 'hh-1',
    aggregateType: 'scenario',
    schemaVersion: 1,
    version,
    updatedAt: '2026-07-02T00:00:00.000Z',
    deviceId: 'dev-1',
    payload: { name: id, isPrimary: true },
  };
}

function queued(
  id: string,
  aggregateId: string,
  expectedVersion: number,
  currentVersion?: number,
): PendingMutation {
  return {
    id,
    aggregateId,
    aggregateType: 'scenario',
    operation: 'update',
    expectedVersion,
    schemaVersion: 1,
    payload: { name: aggregateId },
    timestamp: expectedVersion,
    deviceId: 'dev-1',
    // A row that carries a server-reported `currentVersion` is a parked
    // `failed-conflict`; a bare optimistic row is still `pending`.
    status: currentVersion !== undefined || expectedVersion > 10 ? 'failed-conflict' : 'pending',
    ...(currentVersion !== undefined ? { currentVersion } : {}),
  };
}

describe('serverAcknowledgedVersions', () => {
  it('recovers the lowest expectedVersion per aggregate as the base', () => {
    const truth = serverAcknowledgedVersions([
      queued('a', 'agg-1', 12),
      queued('b', 'agg-1', 11),
      queued('c', 'agg-1', 10),
      queued('d', 'agg-2', 4),
    ]);
    expect(truth.get('agg-1')).toEqual({ aggregateType: 'scenario', version: 10 });
    expect(truth.get('agg-2')).toEqual({ aggregateType: 'scenario', version: 4 });
  });

  it('prefers a server-reported currentVersion over the lowest expectedVersion', () => {
    // A stale leftover `failed-conflict` row (expectedVersion 10) sits in the
    // queue, but the server already told us its true counter is 13 via the same
    // row's `currentVersion`. The server-reported value is more authoritative,
    // so truth is 13 — NOT the stale 10, which would clamp a healthy aggregate
    // down and invent a spurious conflict.
    const truth = serverAcknowledgedVersions([
      queued('a', 'agg-1', 10, 13),
    ]);
    expect(truth.get('agg-1')).toEqual({ aggregateType: 'scenario', version: 13 });
  });

  it('prefers the HIGHEST currentVersion when several rows report one', () => {
    // The latest rejection carries the most-recent server counter (14); an older
    // parked row still shows 13. Take the highest server-reported value.
    const truth = serverAcknowledgedVersions([
      queued('a', 'agg-1', 10, 13),
      queued('b', 'agg-1', 11, 14),
    ]);
    expect(truth.get('agg-1')).toEqual({ aggregateType: 'scenario', version: 14 });
  });

  it('falls back to the lowest expectedVersion when NO row reports a currentVersion', () => {
    // Pure optimistic poison, nothing rejected yet: no server truth has ever
    // been reported, so the lowest expectedVersion remains the base.
    const truth = serverAcknowledgedVersions([
      queued('a', 'agg-1', 12),
      queued('b', 'agg-1', 10),
    ]);
    expect(truth.get('agg-1')).toEqual({ aggregateType: 'scenario', version: 10 });
  });
});

describe('realignAggregateVersions', () => {
  beforeEach(async () => {
    await clearAllStores();
  });
  afterEach(async () => {
    await clearAllStores();
  });

  it('de-inflates a poisoned aggregate to its server-acknowledged base after a queue clear', async () => {
    // A poison train left the local scenario inflated to v13 with its queue rows
    // recording the base v10.
    await putAggregate('scenario', scenarioAgg('agg-1', 13));
    await queueMutation(queued('a', 'agg-1', 10));
    await queueMutation(queued('b', 'agg-1', 11));
    await queueMutation(queued('c', 'agg-1', 12));

    // Capture truth BEFORE the clear, then clear + realign (the destructive-flow
    // order).
    const truth = serverAcknowledgedVersions(await listAllMutations());
    await clearMutationQueue();
    const n = await realignAggregateVersions(truth);

    expect(n).toBe(1);
    const agg = await getAggregate('scenario', 'agg-1');
    expect(agg?.version).toBe(10);
  });

  it('does NOT clamp an aggregate the server already advanced past (stale leftover row)', async () => {
    // The aggregate is genuinely synced to v13 (confirmed via a real pull). The
    // queue still holds ONE stale `failed-conflict` row from an old, superseded
    // conflict: expectedVersion 10 but currentVersion 13 (the server already told
    // us 13). The old lowest-expectedVersion logic would wrongly clamp 13 → 10 and
    // the next queued delete would spuriously CONFLICT. Truth must stay 13.
    await putAggregate('scenario', scenarioAgg('agg-1', 13));
    await queueMutation(queued('a', 'agg-1', 10, 13));

    const truth = serverAcknowledgedVersions(await listAllMutations());
    await clearMutationQueue();
    const n = await realignAggregateVersions(truth);

    expect(n).toBe(0);
    expect((await getAggregate('scenario', 'agg-1'))?.version).toBe(13);
  });

  it('still clamps pure optimistic poison (no server truth reported) to the lowest base', async () => {
    // Regression guard for the original mechanic-2 fix: NO row carries a
    // currentVersion, so the lowest expectedVersion (10) remains the base and the
    // inflated local aggregate (13) de-inflates to it.
    await putAggregate('scenario', scenarioAgg('agg-1', 13));
    await queueMutation(queued('a', 'agg-1', 10));
    await queueMutation(queued('b', 'agg-1', 11));
    await queueMutation(queued('c', 'agg-1', 12));

    const truth = serverAcknowledgedVersions(await listAllMutations());
    await clearMutationQueue();
    const n = await realignAggregateVersions(truth);

    expect(n).toBe(1);
    expect((await getAggregate('scenario', 'agg-1'))?.version).toBe(10);
  });

  it('never raises a version (only de-inflates)', async () => {
    await putAggregate('scenario', scenarioAgg('agg-1', 5));
    const truth = new Map([['agg-1', { aggregateType: 'scenario' as const, version: 9 }]]);
    const n = await realignAggregateVersions(truth);
    expect(n).toBe(0);
    const agg = await getAggregate('scenario', 'agg-1');
    expect(agg?.version).toBe(5);
  });

  it('leaves aggregates with no queued mutation untouched (empty truth)', async () => {
    await putAggregate('scenario', scenarioAgg('agg-1', 3));
    const n = await realignAggregateVersions(new Map());
    expect(n).toBe(0);
    expect((await getAggregate('scenario', 'agg-1'))?.version).toBe(3);
  });
});
