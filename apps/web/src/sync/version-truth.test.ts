// After a queue clear, local versions clamp down to the server-acknowledged base so the next queued mutation does not conflict; the realign only de-inflates.
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
    // A stale `failed-conflict` row (expectedVersion 10) whose own `currentVersion` says 13: the server-reported value wins, or a healthy aggregate would be clamped down and conflict spuriously.
    const truth = serverAcknowledgedVersions([
      queued('a', 'agg-1', 10, 13),
    ]);
    expect(truth.get('agg-1')).toEqual({ aggregateType: 'scenario', version: 13 });
  });

  it('prefers the HIGHEST currentVersion when several rows report one', () => {
    const truth = serverAcknowledgedVersions([
      queued('a', 'agg-1', 10, 13),
      queued('b', 'agg-1', 11, 14),
    ]);
    expect(truth.get('agg-1')).toEqual({ aggregateType: 'scenario', version: 14 });
  });

  it('falls back to the lowest expectedVersion when NO row reports a currentVersion', () => {
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
    await putAggregate('scenario', scenarioAgg('agg-1', 13));
    await queueMutation(queued('a', 'agg-1', 10));
    await queueMutation(queued('b', 'agg-1', 11));
    await queueMutation(queued('c', 'agg-1', 12));

    const truth = serverAcknowledgedVersions(await listAllMutations());
    await clearMutationQueue();
    const n = await realignAggregateVersions(truth);

    expect(n).toBe(1);
    const agg = await getAggregate('scenario', 'agg-1');
    expect(agg?.version).toBe(10);
  });

  it('does NOT clamp an aggregate the server already advanced past (stale leftover row)', async () => {
    // A stale superseded `failed-conflict` row (expectedVersion 10, currentVersion 13) on an aggregate synced to v13: truth must stay 13, not clamp to 10 and conflict on the next delete.
    await putAggregate('scenario', scenarioAgg('agg-1', 13));
    await queueMutation(queued('a', 'agg-1', 10, 13));

    const truth = serverAcknowledgedVersions(await listAllMutations());
    await clearMutationQueue();
    const n = await realignAggregateVersions(truth);

    expect(n).toBe(0);
    expect((await getAggregate('scenario', 'agg-1'))?.version).toBe(13);
  });

  it('still clamps pure optimistic poison (no server truth reported) to the lowest base', async () => {
    // With no server-reported currentVersion the lowest expectedVersion remains the base.
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
