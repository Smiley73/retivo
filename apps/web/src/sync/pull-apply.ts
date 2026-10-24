// Pull-side apply helpers for SyncContext: schema-ahead pre-flight, replaying pulled changes locally, push-rejection repair.
// Pure module-level functions with no reference to provider state.
import {
  collapseToFailedConflict,
  ConcurrentQueueMutationError,
  isKnownAggregateType,
  listMutationsByAggregate,
  parkFailedConflict,
  putAggregate,
  removeMutations,
  type Batch,
} from '../db/store.js';
import { currentSchemaVersion } from '../db/migrations.js';
import type { AggregateType, PendingMutation } from '../db/types.js';
import { collapseAndReQueue } from './mutation-queue.js';
import { decide, latestEdit, type RepairRejection } from './auto-repair.js';
import type { BootstrapResponseBody, PullResponseBody, PushedMutationRejected } from './types.js';
import { recordSyncWarn } from '../lib/diagnostics/logger.js';
import { isStrictEncryptedEnvelope } from '../crypto/key-wrapping.js';

/**
 * A sync response carried a payload at a `schemaVersion` above this client's migration registry. The caller halts the
 * whole batch (no IDB write, no cursor advance) and surfaces the version banner. See "The version guards" in
 * docs/architecture.md.
 */
export class SchemaAheadError extends Error {
  constructor(
    public readonly aggregateType: AggregateType,
    public readonly theirVersion: number,
    public readonly ourCurrent: number,
  ) {
    super(
      `Pulled ${aggregateType} at schemaVersion=${theirVersion}; this client only knows up to v${ourCurrent}`,
    );
    this.name = 'SchemaAheadError';
  }
}

export interface SchemaCarrier {
  aggregateType: string;
  schemaVersion: number;
}

/**
 * A served pull/bootstrap payload was not authenticated ciphertext although this device holds an HDK. The server
 * rejects non-envelope pushes for every household (`enforceEncryptionForMutation`), so a served plaintext, failed GCM
 * tag or undecrypted envelope can only be a bug or a compromised server. The transport guard and `plaintextPayload`
 * throw this same error so `error-detail.ts` maps all of them to the `rollback-detected` badge.
 */
export class UnauthenticatedPayloadError extends Error {
  constructor(
    public readonly phase: 'pull' | 'bootstrap' | 'apply',
    public readonly reason: 'not-envelope' | 'decrypt-failed' | 'undecrypted-at-write',
  ) {
    super(`[sync] Refused ${phase} payload (${reason}) — no local write occurred.`);
    this.name = 'UnauthenticatedPayloadError';
  }
}

// Known push-rejection reasons, derived from an exhaustiveness-checked Record so the allowlist can't drift from
// `PendingMutation['reason']` in either direction. An off-enum reason is normalised before the diagnostics serializer:
// `reason` is deliberately not in the global redaction allowlist, so free text must not reach an exported log.
const REJECTION_REASON_MEMBERS: Record<NonNullable<PendingMutation['reason']>, true> = {
  CONFLICT: true,
  NOT_FOUND: true,
  SCHEMA_MISMATCH: true,
};
const REJECTION_REASONS: ReadonlySet<string> = new Set(Object.keys(REJECTION_REASON_MEMBERS));

/**
 * Redaction-surviving id fragment for the rejection log: the first 8 hex chars of an aggregate id in 4-char groups
 * (`d3f08686-…` becomes `d3f0-8686`). At most 9 chars with no digit run over 4, it clears the redactor's 20-char
 * entropy and 7-digit thresholds unmodified, so an exported file can still correlate to the conflicting object; the
 * full UUID and the name are never logged. The grouping applies to short prefixes too (`1234567` becomes `1234-567`),
 * since a raw 7-digit prefix would be masked. Empty when the id is missing.
 */
export function idFragment(aggregateId: string | undefined): string {
  if (!aggregateId) return '';
  const hex = aggregateId.replace(/[^0-9a-fA-F]/g, '').slice(0, 8);
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 4) groups.push(hex.slice(i, i + 4));
  return groups.join('-');
}

/**
 * Auto-repairs the round's push rejections (at most one per aggregate per batch): reads the aggregate's full local
 * stack, classifies it with {@link decide}, and applies the one action (atomic re-base, stack fold to a parked
 * conflict, drop, or park-as-conflict). Logs one diagnostics line per rejection from validated enums, version ints and
 * the id fragment only, never the resolved name: the redactor does not catch a plain human name.
 */
export async function repairRejections(
  rejected: readonly PushedMutationRejected[],
  householdId: string,
): Promise<void> {
  const summaries: string[] = [];
  for (const r of rejected) {
    const stack = await listMutationsByAggregate(r.aggregateId);
    const rejection: RepairRejection = {
      mutationId: r.mutationId,
      aggregateId: r.aggregateId,
      reason: r.reason,
      currentVersion: r.currentVersion,
      currentUpdatedAt: r.currentUpdatedAt,
      currentDeletedAt: r.currentDeletedAt,
    };
    const decision = decide(rejection, stack);
    const stackIds = stack.map((m) => m.id);
    const rejectedLocal = stack.find((m) => m.id === r.mutationId);
    // An off-enum wire reason persists as absent, never a raw string.
    const facts = {
      reason: REJECTION_REASONS.has(r.reason) ? r.reason : undefined,
      currentVersion: r.currentVersion,
      currentUpdatedAt: r.currentUpdatedAt,
    };
    // Reason normalised to the known set ('UNKNOWN' for off-enum), joined with type/op, the id fragment and version
    // ints; never the name (see above). The action tag is appended per outcome.
    const reasonLabel = REJECTION_REASONS.has(r.reason) ? r.reason : 'UNKNOWN';
    const frag = idFragment(r.aggregateId);
    const fragPart = frag ? ` ${frag}` : '';
    const prefix = `${reasonLabel} ${rejectedLocal?.aggregateType ?? '?'}/${rejectedLocal?.operation ?? '?'}${fragPart} (local v${rejectedLocal?.expectedVersion ?? '?'} → server v${r.currentVersion})`;
    try {
      switch (decision.kind) {
        case 'drop':
          // The delete intent already holds: remove exactly the ids the decision scoped in one transaction (just the
          // rejected row, so a legitimate sibling such as a later recreate is routed next round, or the whole
          // created-then-deleted stack).
          await removeMutations(decision.removeMutationIds);
          break;
        case 'rebase': {
          const latest = latestEdit(stack);
          await collapseAndReQueue({
            aggregateType: latest.aggregateType,
            aggregateId: r.aggregateId,
            householdId,
            operation: decision.operation,
            expectedVersion: decision.expectedVersion,
            schemaVersion: latest.schemaVersion,
            payload: decision.payload,
            removeMutationIds: stackIds,
          });
          break;
        }
        case 'escalate':
          // Fold the stack into one parked representative awaiting keep/discard, so siblings don't re-conflict each
          // poll.
          await collapseToFailedConflict({
            aggregateId: r.aggregateId,
            representativeId: decision.representativeId,
            removeMutationIds: stackIds,
            facts,
          });
          break;
        case 'passthrough':
          // Leave a single failed-conflict row; siblings stay pending.
          await parkFailedConflict(r.mutationId, facts);
          break;
      }
    } catch (err) {
      // A user edit to this aggregate landed between the stack read and the collapse commit; the transactional collapse
      // saw the extra row and aborted rather than stomp it. Leave the rejection pending so the next flush re-reads and
      // re-routes it; any other error propagates.
      if (err instanceof ConcurrentQueueMutationError) {
        summaries.push(`${prefix} [raced-retry]`);
        continue;
      }
      throw err;
    }
    summaries.push(`${prefix} [${decision.code}]`);
  }
  recordSyncWarn(
    `[sync] push rejected — auto-repair evaluated ${summaries.length} mutation(s)`,
    ...summaries,
  );
}

/**
 * Pre-flight before any IDB write: throws `SchemaAheadError` on the first row ahead of this bundle's registry, so pull
 * and bootstrap never partially apply (which would orphan references between aggregate types).
 */
export function assertNoSchemaAhead(rows: readonly SchemaCarrier[]): void {
  for (const row of rows) {
    if (!isKnownAggregateType(row.aggregateType)) continue;
    const ours = currentSchemaVersion(row.aggregateType);
    if (row.schemaVersion > ours) {
      throw new SchemaAheadError(row.aggregateType, row.schemaVersion, ours);
    }
  }
}

/**
 * Replays one server mutation into the local store. A `delete` must set `deletedAt`, else pull/bootstrap would
 * resurrect tombstoned rows (duplicate accounts after a cross-household import). Returns false when skipped (unknown
 * aggregateType); callers still advance the cursor past skipped rows. Schema-ahead rows are caught upstream by
 * `assertNoSchemaAhead`.
 */
export async function applyPulledChange(
  change: PullResponseBody['changes'][number],
  householdId: string,
  batch?: Batch,
): Promise<boolean> {
  if (!isKnownAggregateType(change.aggregateType)) {
    // The server's egress filter should already strip these; warn loudly so a retired-type leak is observable.
    console.warn(
      `[sync] Skipping pulled change with unknown aggregateType=${change.aggregateType} (aggregateId=${change.aggregateId})`,
    );
    return false;
  }
  const isDelete = change.operation === 'delete';
  await putAggregate(change.aggregateType, {
    id: change.aggregateId,
    householdId,
    aggregateType: change.aggregateType,
    schemaVersion: change.schemaVersion,
    version: change.version,
    updatedAt: change.updatedAt,
    deletedAt: isDelete ? change.updatedAt : undefined,
    deviceId: change.deviceId,
    payload: plaintextPayload(change.payload),
  }, batch);
  return true;
}

/**
 * Narrows a synced payload to the plaintext record the store holds; the one coercion point. Also the write-path
 * backstop: every apply funnels here, so a decrypt regression in `sync-client.ts` fails closed at the IndexedDB
 * boundary instead of writing ciphertext as plaintext, throwing the same {@link UnauthenticatedPayloadError}.
 */
export function plaintextPayload(
  payload: Record<string, unknown> | { encryptionVersion?: unknown },
): Record<string, unknown> {
  if (isStrictEncryptedEnvelope(payload)) {
    throw new UnauthenticatedPayloadError('apply', 'undecrypted-at-write');
  }
  return payload as Record<string, unknown>;
}

/**
 * Schema-ahead rows can sit in a bootstrap's snapshot as well as its post-snapshot mutations; both must be inspected
 * before any IDB write.
 */
export function bootstrapSchemaCarriers(body: BootstrapResponseBody): SchemaCarrier[] {
  return [
    ...body.workspaceSnapshot.aggregates.map((a) => ({
      aggregateType: a.aggregateType,
      schemaVersion: a.schemaVersion,
    })),
    ...body.postSnapshotMutations.map((m) => ({
      aggregateType: m.aggregateType,
      schemaVersion: m.schemaVersion,
    })),
  ];
}
