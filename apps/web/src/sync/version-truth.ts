/**
 * Version-truth restoration for the destructive workspace flows.
 * Framework-free (IDB only, no React
 * edge) so `lib/demo-data-loader.ts` can import it directly.
 *
 * The problem: `wipeWorkspaceForDemoReload` / `resetWorkspace` call
 * `clearMutationQueue()` but leave the optimistically-inflated local aggregate
 * versions behind — `queueLocalMutation` bumps each aggregate to
 * `expectedVersion + 1` on every queued edit, and a parked `failed-conflict`
 * never re-bases it. The deletes those flows then queue reuse the inflated
 * version and re-conflict, so the user "cleared everything" yet the badge stays
 * stuck.
 *
 * The fix, purely from local state: an aggregate's last **server-acknowledged**
 * version is normally the LOWEST `expectedVersion` among its un-pushed queue
 * rows. `queueLocalMutation` stamps the first un-pushed mutation at the
 * then-current (server-acknowledged) version and inflates the local aggregate by
 * exactly +1 per queued edit thereafter, so that minimum is the pre-inflation
 * base. BUT a rejected (`failed-conflict`) row also records the server's own true
 * counter at rejection time (`currentVersion` on `PendingMutation`)
 * — a strictly more authoritative signal than any client-side optimistic
 * `expectedVersion` guess. So when ANY queued row for an aggregate carries a
 * `currentVersion`, the HIGHEST such server-reported value wins over the lowest
 * `expectedVersion`: a stale leftover row (e.g. a superseded `failed-conflict`
 * whose low `expectedVersion` no longer reflects reality) can no longer clamp an
 * aggregate the server has already advanced past, which would INVENT a spurious
 * conflict on an aggregate that needed no repair. Only when NO row has ever been
 * rejected (no `currentVersion` anywhere — the pure optimistic-poison case) does
 * the lowest-`expectedVersion` base apply.
 * {@link serverAcknowledgedVersions} recovers this truth from the queue snapshot
 * (captured BEFORE the queue clear); {@link realignAggregateVersions} clamps each
 * local aggregate DOWN to it (never up) so the next queued mutation targets a
 * version the server can actually reach.
 *
 * Safety: clamping only ever LOWERS a version. If the recovered base still
 * under-shoots the server's true counter (the wedge — server counter ran ahead
 * of reachable content), the subsequently-queued mutation conflicts with
 * `currentVersion > expectedVersion`, which the reject-loop auto-repair
 * ESCALATES to keep/discard rather than silently overwriting — so no realign can
 * ever cause a silent data loss.
 */
import {
  listAggregatesIncludingDeleted,
  putAggregate,
} from '../db/store.js';
import type { AggregateType, PendingMutation } from '../db/types.js';

export interface ServerTruth {
  aggregateType: AggregateType;
  /**
   * The server-acknowledged version: the HIGHEST server-reported `currentVersion`
   * among the aggregate's queued rows when any row was rejected, else the lowest
   * un-pushed `expectedVersion`.
   */
  version: number;
}

/**
 * Recover each aggregate's last server-acknowledged version from a snapshot of
 * the un-pushed mutation queue. Capture this BEFORE `clearMutationQueue()` — the
 * queue is the only local record of the pre-inflation base. Pure.
 *
 * A row's server-reported `currentVersion` (present on a parked `failed-conflict`
 * row) is strictly more authoritative than any optimistic `expectedVersion`, so
 * the highest `currentVersion` for an aggregate OVERRIDES the lowest
 * `expectedVersion`. The lowest-`expectedVersion` base only applies when no row
 * for the aggregate carries a `currentVersion` (nothing has been rejected — the
 * pure optimistic-poison case this helper was originally written for).
 */
export function serverAcknowledgedVersions(
  mutations: readonly PendingMutation[],
): Map<string, ServerTruth> {
  const out = new Map<string, ServerTruth>();
  // Highest server-REPORTED counter per aggregate (from rejected rows). When set
  // it wins over the lowest-`expectedVersion` heuristic below.
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
  // Override the optimistic base with the more-authoritative server truth
  // wherever the server has reported one for the aggregate.
  for (const [id, reported] of serverReported) {
    const entry = out.get(id);
    if (entry) entry.version = reported;
  }
  return out;
}

/**
 * Clamp each local aggregate's `version` DOWN to its server-acknowledged base,
 * stripping the optimistic inflation the cleared queue left behind. Returns the
 * number of aggregates re-aligned. Run inside the destructive fence/mutex (the
 * caller holds it) so no concurrent edit races the read→write, and AFTER
 * `clearMutationQueue()` (the truth map is captured before the clear).
 */
export async function realignAggregateVersions(
  truth: ReadonlyMap<string, ServerTruth>,
): Promise<number> {
  if (truth.size === 0) return 0;
  // Group the target ids by aggregate type so each store is listed once.
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
    // Include tombstones: a delete-poisoned aggregate is locally tombstoned, and
    // its version still needs correcting so the re-queued delete lands.
    const aggregates = await listAggregatesIncludingDeleted(type);
    for (const agg of aggregates) {
      const trueVersion = idVersions.get(agg.id);
      if (trueVersion === undefined) continue;
      // Only ever de-inflate — never raise a version (raising could invent a
      // conflict). A healthy aggregate already at/below its base is untouched.
      if (agg.version > trueVersion) {
        await putAggregate(type, { ...agg, version: trueVersion });
        realigned += 1;
      }
    }
  }
  return realigned;
}
