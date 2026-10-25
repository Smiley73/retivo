// Pure auto-repair classifier for a rejected push mutation: `decide()` returns the one action the SyncContext reject loop takes.
// Rebase and escalate fold the aggregate's stack into one representative (the latest edit); docs/architecture.md "Writing".
import type { PendingMutation } from '../db/types.js';

/**
 * Rejection facts auto-repair routes on; `reason` stays the raw wire string so an off-enum value passes through instead
 * of being coerced.
 */
export interface RepairRejection {
  mutationId: string;
  aggregateId: string;
  reason: string;
  currentVersion: number;
  currentUpdatedAt: string;
  currentDeletedAt: string | null;
}

/** The reject-loop action for one aggregate; each `code` is a fixed enum so the diagnostics line stays PII-safe. */
export type RepairDecision =
  /**
   * Silent and safe: the delete intent already holds; remove exactly `removeMutationIds` (just the rejected row, or the
   * whole stack for a created-then-deleted draft over a tombstone).
   */
  | { kind: 'drop'; code: RepairCode; removeMutationIds: readonly string[] }
  /**
   * Silent and safe: collapse the stack to one mutation re-based to the server's true version; `operation` may differ
   * from the rejected one (create over tombstone becomes update).
   */
  | {
      kind: 'rebase';
      code: RepairCode;
      operation: PendingMutation['operation'];
      expectedVersion: number;
      payload: Record<string, unknown>;
    }
  /**
   * A real keep/discard choice: collapse the stack to one parked `failed-conflict` representative (the latest edit).
   */
  | { kind: 'escalate'; code: RepairCode; representativeId: string }
  /** Unhandled reason: leave as a `failed-conflict`. */
  | { kind: 'passthrough'; code: RepairCode };

type RepairCode =
  | 'delete-not-found'
  | 'delete-over-tombstone'
  | 'update-not-found'
  | 'create-over-tombstone'
  | 'create-over-live'
  | 'rebase-inflation'
  | 'server-ahead'
  | 'unreachable-equal'
  | 'unknown';

/**
 * The latest edit in a stack; the highest `timestamp` wins (`listPendingMutations` guarantees strictly monotonic ones),
 * so a trailing delete wins.
 */
export function latestEdit(stack: readonly PendingMutation[]): PendingMutation {
  return stack.reduce((a, b) => (b.timestamp >= a.timestamp ? b : a));
}

/**
 * Classifies one rejection against the aggregate's full local stack (pending and failed-conflict), so a later pending
 * sibling can't re-poison it after the collapse. Pure.
 */
export function decide(
  rejection: RepairRejection,
  stack: readonly PendingMutation[],
): RepairDecision {
  const rejected = stack.find((m) => m.id === rejection.mutationId);
  // Defensive: the caller reads the stack fresh, so this should not happen.
  if (!rejected) return { kind: 'passthrough', code: 'unknown' };

  const op = rejected.operation;
  const { reason, currentVersion, currentDeletedAt } = rejection;
  const isTombstone = currentDeletedAt != null;

  // 1. A delete whose intent already holds drops regardless of version, ahead of the `<`/`>` rules.
  if (op === 'delete' && reason === 'NOT_FOUND') {
    return { kind: 'drop', code: 'delete-not-found', removeMutationIds: [rejection.mutationId] };
  }
  if (op === 'delete' && reason === 'CONFLICT' && isTombstone) {
    return { kind: 'drop', code: 'delete-over-tombstone', removeMutationIds: [rejection.mutationId] };
  }

  // 2. Update against a server row that is genuinely gone — a real choice.
  if (op === 'update' && reason === 'NOT_FOUND') {
    return { kind: 'escalate', code: 'update-not-found', representativeId: latestEdit(stack).id };
  }

  // 3. Create conflicts split on the tombstone flag.
  if (op === 'create' && reason === 'CONFLICT') {
    if (isTombstone) {
      // Recreate over own tombstone. If the stack now ends in a delete the tombstone already reflects the intent: drop,
      // never resurrect it as a live update. Otherwise `create @ 0` can never land on a surviving AggregateVersion row,
      // so convert the latest edit to `update @ currentVersion`.
      const latest = latestEdit(stack);
      if (latest.operation === 'delete') {
        // Poison train: clear every row in one pass; dropping only one would strand a sibling update that the next
        // flush pushes stale and escalates, breaking silent auto-resolve.
        return {
          kind: 'drop',
          code: 'delete-over-tombstone',
          removeMutationIds: stack.map((m) => m.id),
        };
      }
      return {
        kind: 'rebase',
        code: 'create-over-tombstone',
        operation: 'update',
        expectedVersion: currentVersion,
        payload: latest.payload,
      };
    }
    // Create over a LIVE row — a real remote object at this id. Never silent.
    return { kind: 'escalate', code: 'create-over-live', representativeId: latestEdit(stack).id };
  }

  // 4. Update/delete version conflicts route on the version comparison.
  if (reason === 'CONFLICT' && (op === 'update' || op === 'delete')) {
    if (currentVersion < rejected.expectedVersion) {
      // Optimistic-inflation poison: silent re-base to the latest edit.
      const latest = latestEdit(stack);
      return {
        kind: 'rebase',
        code: 'rebase-inflation',
        operation: latest.operation,
        expectedVersion: currentVersion,
        payload: latest.payload,
      };
    }
    if (currentVersion > rejected.expectedVersion) {
      // A genuine remote advance or the wedged counter: keep/discard. A re-based mutation that conflicts again lands
      // here (its expectedVersion now equals the prior currentVersion), so it escalates; bounded by version
      // monotonicity.
      return { kind: 'escalate', code: 'server-ahead', representativeId: latestEdit(stack).id };
    }
    // currentVersion === expectedVersion on a CONFLICT is unreachable (the push
    // would have succeeded). Never silently re-base onto an equal version.
    return { kind: 'passthrough', code: 'unreachable-equal' };
  }

  // 5. SCHEMA_MISMATCH, off-enum or anything else: a plain failed-conflict.
  return { kind: 'passthrough', code: 'unknown' };
}
