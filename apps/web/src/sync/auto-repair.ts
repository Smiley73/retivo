/**
 * Pure auto-repair classifier for a rejected push mutation.
 * Given ONE server rejection plus the full local
 * queue stack for that aggregate, `decide()` returns the single action the
 * effectful reject loop (`SyncContext`) must take. It performs NO IO — all
 * re-queue / drop / park side effects live in the caller so this stays unit
 * testable.
 *
 * The routing table (see "Writing" under "Sync" in docs/architecture.md):
 *   - `NOT_FOUND` on a delete, or a delete over an existing tombstone
 *     (`CONFLICT` + `currentDeletedAt` set) → DROP (intent already holds).
 *     The tombstone check precedes the `<`/`>` version rules.
 *   - `NOT_FOUND` on an update → ESCALATE (server row genuinely gone; a real
 *     keep/discard choice — recreate vs accept the deletion).
 *   - `CONFLICT` on a create over a tombstone (`currentDeletedAt` set) →
 *     silent REBASE, converting the op to `update @ currentVersion` — UNLESS the
 *     stack's latest edit is a `delete` (created-then-deleted locally), in which
 *     case the tombstone already reflects the intent → DROP, never resurrect
 *     (operation-aware collapse).
 *   - `CONFLICT` on a create over a LIVE row (`currentDeletedAt` null) →
 *     ESCALATE (a real remote row exists; never silently overwrite).
 *   - `CONFLICT` on update/delete with `currentVersion < expectedVersion` →
 *     silent REBASE to `currentVersion` (the app's own optimistic-inflation
 *     poison).
 *   - `CONFLICT` on update/delete with `currentVersion > expectedVersion` →
 *     ESCALATE (a genuine remote advance OR the wedged counter — keep re-bases
 *     and pushes forward, which also heals the wedge).
 *   - `currentVersion == expectedVersion` on a CONFLICT is unreachable (the push
 *     would have succeeded) → PASSTHROUGH, never a silent re-base.
 *   - anything else (e.g. `SCHEMA_MISMATCH`, an off-enum reason) → PASSTHROUGH to
 *     today's `failed-conflict` + badge.
 *
 * The poison-train collapse lives here too: a REBASE or ESCALATE folds the
 * WHOLE aggregate stack (every `pending` + `failed-conflict` row for the
 * aggregate) into ONE representative — the latest edit, operation-aware (a
 * trailing delete wins, else the latest payload) — so a stacked poison train
 * heals in one pass rather than N. A DROP is scoped by `removeMutationIds`: a
 * simple delete-vs-deleted drop removes only the rejected row, but a
 * create-over-tombstone whose stack ends in a delete clears the WHOLE stack (the
 * final local intent is "deleted" and the server already agrees) so no stale
 * sibling survives to re-conflict.
 */
import type { PendingMutation } from '../db/types.js';

/** The rejection facts auto-repair routes on — the wire rejection plus the
 *  server-reported tombstone flag. `reason` is the raw wire string so an
 *  off-enum value routes to PASSTHROUGH rather than being coerced. */
export interface RepairRejection {
  mutationId: string;
  aggregateId: string;
  reason: string;
  currentVersion: number;
  currentUpdatedAt: string;
  currentDeletedAt: string | null;
}

/**
 * The reject-loop action for one aggregate. Every `code` is a fixed enum for
 * the PII-safe diagnostics line (never free text / a resolved name).
 */
export type RepairDecision =
  /** Silent + safe: the delete intent already holds — remove exactly
   *  `removeMutationIds`. A simple delete-vs-deleted drop removes only the
   *  rejected row (a legitimate sibling stays queued for the next round to route
   *  on its own); a create-over-tombstone whose stack ends in a delete removes the
   *  WHOLE stack (the poison train). */
  | { kind: 'drop'; code: RepairCode; removeMutationIds: readonly string[] }
  /** Silent + safe: collapse the stack to ONE fresh mutation re-based to the
   *  server's true version. `operation` may differ from the rejected op
   *  (create-over-tombstone → update). */
  | {
      kind: 'rebase';
      code: RepairCode;
      operation: PendingMutation['operation'];
      expectedVersion: number;
      payload: Record<string, unknown>;
    }
  /** A real choice (keep/discard): collapse the stack to ONE parked
   *  `failed-conflict` representative (the latest edit) awaiting the user. */
  | { kind: 'escalate'; code: RepairCode; representativeId: string }
  /** Undecided / not-yet-handled reason → leave as today's `failed-conflict`. */
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
 * The latest edit in a stack, operation-aware. Highest `timestamp` wins;
 * `listPendingMutations` guarantees strictly-monotonic timestamps so there is
 * no tie to break. A trailing delete therefore wins automatically (it was
 * queued last), collapsing "edit, edit, delete" to the delete.
 */
export function latestEdit(stack: readonly PendingMutation[]): PendingMutation {
  return stack.reduce((a, b) => (b.timestamp >= a.timestamp ? b : a));
}

/**
 * Classify one rejection against its full aggregate stack. Pure. The caller
 * supplies the stack = every local `mutations` row for the aggregate (pending +
 * failed-conflict), not just this chunk's rejection, so a later pending sibling
 * can't re-poison the aggregate after the collapse.
 */
export function decide(
  rejection: RepairRejection,
  stack: readonly PendingMutation[],
): RepairDecision {
  const rejected = stack.find((m) => m.id === rejection.mutationId);
  // Defensive: the rejected mutation is not in the stack (should never happen —
  // the caller reads the stack fresh). Nothing safe to infer → passthrough.
  if (!rejected) return { kind: 'passthrough', code: 'unknown' };

  const op = rejected.operation;
  const { reason, currentVersion, currentDeletedAt } = rejection;
  const isTombstone = currentDeletedAt != null;

  // 1. Delete whose intent already holds — drop, regardless of version. This
  //    precedes the `<`/`>` rules below.
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
      // Recreate-over-own-tombstone. Collapse the stack operation-aware:
      // if the local intent has since become a delete (the user created then
      // deleted the same local draft before the create's rejection was
      // processed), the tombstone already reflects "deleted" — DROP rather than
      // resurrecting the aggregate as a live `update` (that would silently
      // recreate a locally-deleted row on the server, a data-integrity
      // violation). Otherwise a `create @ 0` can never land against a surviving
      // AggregateVersion row, so convert the latest edit to
      // `update @ currentVersion`.
      const latest = latestEdit(stack);
      if (latest.operation === 'delete') {
        // Poison train: the whole stack is a created-then-deleted local draft
        // the server already tombstoned. Clear EVERY row in one pass — a
        // single-row drop would strand a sibling `update`, which the next flush
        // would push stale against the already-tombstoned version and escalate
        // to failed-conflict, breaking the silent-auto-resolve guarantee.
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

  // 4. Update / delete version conflicts route on the version comparison. Both
  //    operations run these branches.
  if (reason === 'CONFLICT' && (op === 'update' || op === 'delete')) {
    if (currentVersion < rejected.expectedVersion) {
      // Pure optimistic-inflation poison → silent re-base, collapse to the
      // latest edit (operation-aware).
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
      // Genuine remote advance OR the wedged counter → keep/discard. A
      // re-based mutation that conflicts AGAIN lands here (its expectedVersion
      // now equals the prior currentVersion, so a further server advance is
      // strictly greater), so it escalates rather than re-basing twice —
      // bounded by version monotonicity, never a loop.
      return { kind: 'escalate', code: 'server-ahead', representativeId: latestEdit(stack).id };
    }
    // currentVersion === expectedVersion on a CONFLICT is unreachable (the push
    // would have succeeded). Never silently re-base onto an equal version.
    return { kind: 'passthrough', code: 'unreachable-equal' };
  }

  // 5. SCHEMA_MISMATCH / off-enum / anything else → today's failed-conflict.
  return { kind: 'passthrough', code: 'unknown' };
}
