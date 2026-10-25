// Version-truth restoration for destructive workspace flows; IDB only, so `lib/demo-data-loader.ts` can import it.
// Wipe/reset clear the queue but leave optimistically inflated local versions, so the deletes they queue re-conflict.
import {
  listAggregatesIncludingDeleted,
  putAggregate,
} from '../db/store.js';
import type { AggregateType, PendingMutation } from '../db/types.js';

export interface ServerTruth {
  aggregateType: AggregateType;
  version: number;
}

/**
 * Recovers each aggregate's last server-acknowledged version from a snapshot of the un-pushed queue; capture it before
 * `clearMutationQueue()`, the only local record of the pre-inflation base. Pure. The highest server-reported
 * `currentVersion` (on a rejected `failed-conflict` row) wins over the lowest `expectedVersion`, since a stale low row
 * must not clamp an aggregate the server already advanced past and invent a conflict; with no rejected row the lowest
 * `expectedVersion` is the base.
 */
export function serverAcknowledgedVersions(
  mutations: readonly PendingMutation[],
): Map<string, ServerTruth> {
  const out = new Map<string, ServerTruth>();
  // Highest server-reported counter per aggregate (from rejected rows); wins over the lowest-expectedVersion base.
  const serverReported = new Map<string, number>();
  for (const m of mutations) {
    if (m.currentVersion !== undefined) {
      const prevReported = serverReported.get(m.aggregateId);
      if (prevReported === undefined || m.currentVersion > prevReported) {
        serverReported.set(m.aggregateId, m.currentVersion);
      }
    }
    const prev = out.get(m.aggregateId);
    if (!prev || m.expectedVersion < prev.version) {
      out.set(m.aggregateId, {
        aggregateType: m.aggregateType,
        version: m.expectedVersion,
      });
    }
  }
  for (const [id, reported] of serverReported) {
    const entry = out.get(id);
    if (entry) entry.version = reported;
  }
  return out;
}

/**
 * Clamps each local aggregate's `version` down (never up) to its server-acknowledged base and returns how many were
 * re-aligned. If the base still under-shoots the server, the re-queued mutation conflicts with `currentVersion >
 * expectedVersion`, which auto-repair escalates to keep/discard, so a realign never causes silent data loss. Run inside
 * the destructive fence/mutex, after `clearMutationQueue()`.
 */
export async function realignAggregateVersions(
  truth: ReadonlyMap<string, ServerTruth>,
): Promise<number> {
  if (truth.size === 0) return 0;
  const idsByType = new Map<AggregateType, Map<string, number>>();
  for (const [id, t] of truth) {
    let m = idsByType.get(t.aggregateType);
    if (!m) {
      m = new Map();
      idsByType.set(t.aggregateType, m);
    }
    m.set(id, t.version);
  }

  let realigned = 0;
  for (const [type, idVersions] of idsByType) {
    // Include tombstones: a delete-poisoned aggregate's version still needs correcting so the re-queued delete lands.
    const aggregates = await listAggregatesIncludingDeleted(type);
    for (const agg of aggregates) {
      const trueVersion = idVersions.get(agg.id);
      if (trueVersion === undefined) continue;
      // Only de-inflate: raising a version could invent a conflict.
      if (agg.version > trueVersion) {
        await putAggregate(type, { ...agg, version: trueVersion });
        realigned += 1;
      }
    }
  }
  return realigned;
}
