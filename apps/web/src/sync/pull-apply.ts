/**
 * Pull-side apply helpers for SyncContext: schema-ahead pre-flight,
 * replaying a pulled/bootstrapped change into the local aggregate store,
 * and auto-repairing push rejections. Split
 * out of SyncContext.tsx to keep that file under the shape limit — pure module-level functions with
 * no reference to provider state, only db/crypto imports.
 */
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
 * Raised when a sync response carries a payload at a `schemaVersion`
 * higher than this client's migration registry can produce. Caller
 * halts the entire batch (no IDB write, no cursor advance) and
 * surfaces the version banner so the user reloads to a newer bundle.
 * See "The version guards" in docs/architecture.md.
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
 * Raised when a served pull/bootstrap payload — once this device holds a
 * household data key (HDK) — is not authenticated ciphertext.
 * `enforceEncryptionForMutation` on the server (push.service.ts)
 * rejects a non-envelope payload or a missing freshness head for EVERY
 * household, keyed or not, so once a household's client holds
 * an HDK there is no legitimate server-side path that could have stored a
 * plaintext row — a served plaintext payload, a failed GCM tag, or an
 * envelope reaching the write path undecrypted can only be a bug or a
 * compromised server. `sync-client.ts`'s transport guard and this module's
 * `plaintextPayload` backstop both throw this SAME error so every caller
 * classifies the rejection identically (`error-detail.ts` maps it to the
 * `rollback-detected` badge alongside a genuine freshness rollback).
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

/**
 * Known server push-rejection reasons (mirrors `PushedMutationRejected.reason`
 * and the `PendingMutation['reason']` union). Derived from an
 * exhaustiveness-checked `Record` keyed by that union so the allowlist can't
 * silently drift from the type in EITHER direction: a future reason member
 * fails typecheck here (missing key) until it is listed, and a stray value is
 * rejected (excess key). Used to normalise the value before it reaches the
 * diagnostics serializer so a malformed/off-enum reason can never smuggle free
 * text into an exported log — `reason` is deliberately NOT in the global
 * redaction allowlist. Kept a `ReadonlySet<string>` so membership checks accept
 * the untrusted wire string as-is.
 */
const REJECTION_REASON_MEMBERS: Record<NonNullable<PendingMutation['reason']>, true> = {
  CONFLICT: true,
  NOT_FOUND: true,
  SCHEMA_MISMATCH: true,
};
const REJECTION_REASONS: ReadonlySet<string> = new Set(Object.keys(REJECTION_REASON_MEMBERS));

/**
 * Short, redaction-surviving id fragment for the rejection log. Takes the
 * first 8 hex chars of an aggregate id and splits them into 4-char groups
 * joined by '-' (e.g. `d3f08686-…` → `d3f0-8686`). This is ≤9 chars — below
 * the diagnostics redactor's 20-char entropy threshold (`ENTROPY_RE`) — and its
 * longest digit run is ≤4 — below the 7-digit threshold (`DIGIT_RUN_RE`) — so it
 * passes the redactor UNMODIFIED and can correlate an exported diagnostics file
 * to the conflicting object. Constructed to clear the redactor, NOT exempted
 * from it; the full UUID and the human name are never logged. Empty string when
 * the id is missing.
 *
 * The 4-char grouping applies to a SHORT prefix too (1–7 hex): a raw 7-hex
 * all-digit prefix (e.g. `1234567`) would itself trip `DIGIT_RUN_RE` and be
 * masked to `[redacted]`, defeating the correlator — so the same split runs on
 * every length (`1234567` → `1234-567`). The full 8-hex output stays
 * byte-identical to the prior two-group split.
 */
export function idFragment(aggregateId: string | undefined): string {
  if (!aggregateId) return '';
  const hex = aggregateId.replace(/[^0-9a-fA-F]/g, '').slice(0, 8);
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 4) groups.push(hex.slice(i, i + 4));
  return groups.join('-');
}

/**
 * Auto-repair the round's push rejections. There
 * is at most one rejection per `aggregateId` per batch. For each, read the
 * FULL local queue stack for that aggregate (pending + failed-conflict), classify
 * it with the pure {@link decide}, and apply the single resulting action —
 * atomic collapse/re-queue for a silent re-base, a stack-fold for an escalation,
 * a drop for a delete whose intent already holds, or today's park-as-conflict for
 * an undecided reason. Records ONE diagnostics line built ONLY from validated
 * enums + version ints + a redaction-surviving id fragment — never the resolved
 * name / PII (the redactor does not catch a plain human name, so the safe shape
 * is enforced here at the call site).
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
    // Normalise the wire reason to the allowlist before persisting (an off-enum
    // value persists as absent — never a raw string / free text).
    const facts = {
      reason: REJECTION_REASONS.has(r.reason) ? r.reason : undefined,
      currentVersion: r.currentVersion,
      currentUpdatedAt: r.currentUpdatedAt,
    };
    // The rejection reason normalised to the known set (an off-enum value reads
    // as 'UNKNOWN', never the raw wire string). Joined with the aggregate
    // type/op, a redaction-surviving id fragment, and small version ints —
    // never the resolved name / PII (the redactor does not catch a plain human
    // name, so the safe shape is enforced here at the call site). The trailing
    // action tag is appended per-outcome below.
    const reasonLabel = REJECTION_REASONS.has(r.reason) ? r.reason : 'UNKNOWN';
    const frag = idFragment(r.aggregateId);
    const fragPart = frag ? ` ${frag}` : '';
    const prefix = `${reasonLabel} ${rejectedLocal?.aggregateType ?? '?'}/${rejectedLocal?.operation ?? '?'}${fragPart} (local v${rejectedLocal?.expectedVersion ?? '?'} → server v${r.currentVersion})`;
    try {
      switch (decision.kind) {
        case 'drop':
          // The delete intent already holds — remove exactly the ids the
          // decision scoped, in ONE transaction. A simple delete-vs-deleted drop
          // scopes to just the rejected row, so a legitimate sibling (e.g. a
          // later recreate at the same id) is left for the next round to route on
          // its own. A create-over-tombstone whose local stack ends in a delete
          // scopes to the WHOLE stack — the final local intent is "deleted"
          // and the server already agrees, so no stale sibling may survive to
          // push stale against the tombstoned version and re-escalate.
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
          // Fold the whole stack into one parked representative awaiting the
          // user's keep/discard, so sibling rows don't re-conflict and churn the
          // badge each poll.
          await collapseToFailedConflict({
            aggregateId: r.aggregateId,
            representativeId: decision.representativeId,
            removeMutationIds: stackIds,
            facts,
          });
          break;
        case 'passthrough':
          // Leave today's single failed-conflict row; siblings stay pending.
          await parkFailedConflict(r.mutationId, facts);
          break;
      }
    } catch (err) {
      // Concurrency abort: a `queueLocalMutation` from a user edit to this
      // SAME aggregate landed between the stack read above and the collapse
      // commit. The transactional collapse re-read the stack, saw the extra row,
      // and aborted rather than stomping it. Leave the rejection pending so the
      // next flush round re-reads the full stack (now including that edit) and
      // re-routes it — never a silent lost update. Any other error propagates.
      if (err instanceof ConcurrentQueueMutationError) {
        summaries.push(`${prefix} [raced-retry]`);
        continue;
      }
      throw err;
    }
    // `decision.code` records the auto-repair action actually committed.
    summaries.push(`${prefix} [${decision.code}]`);
  }
  recordSyncWarn(
    `[sync] push rejected — auto-repair evaluated ${summaries.length} mutation(s)`,
    ...summaries,
  );
}

/**
 * Pre-flight check before any IDB write. Throws `SchemaAheadError` on
 * the first row whose schemaVersion is ahead of this bundle's registry,
 * so neither pull nor bootstrap mutate local state when the response
 * cannot be applied wholesale (per the "halt all sync" choice in this
 * change's design Q6 — partial-apply was rejected to avoid orphan
 * references between aggregate types).
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
 * Replay one server-side mutation into the local aggregate store.
 * Honors `operation`: a `delete` mutation must mark `deletedAt` so
 * `listAggregates` filters it out. Without this, pull/bootstrap would
 * resurrect any aggregate the server has tombstoned (which manifests as
 * "duplicate accounts" after a cross-household import: Phase 1 deletes
 * are replayed back as live rows, alongside Phase 2 creates).
 *
 * Returns `true` if the change was applied, `false` if it was skipped
 * (currently: unknown aggregateType — defense against retired types
 * lingering on the server). Callers must still advance the sync cursor
 * past skipped rows so they don't get replayed forever.
 *
 * Schema-ahead rows are caught upstream by `assertNoSchemaAhead` before
 * this function runs, so the writer never has to reason about a payload
 * it can't handle.
 */
export async function applyPulledChange(
  change: PullResponseBody['changes'][number],
  householdId: string,
  batch?: Batch,
): Promise<boolean> {
  if (!isKnownAggregateType(change.aggregateType)) {
    // Server's egress filter should already have stripped these. Warn
    // loudly so a retired-type leak is observable instead of silent.
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
    // Plaintext by this point: the HTTP client decrypts any encrypted
    // envelope in place before the response reaches here, and
    // on the dark path it was already a plaintext record.
    payload: plaintextPayload(change.payload),
  }, batch);
  return true;
}

/**
 * Narrow a synced payload to the plaintext record the local store holds.
 * The HTTP client always hands back decrypted payloads (it decrypts
 * encrypted envelopes in place when the HDK is unlocked); on the dark
 * path the payload is already plaintext. This is the single coercion
 * point so the store writers stay typed against `Record<string, unknown>`.
 *
 * Write-path backstop: every apply path funnels through
 * this one function, so it is also the defense-in-depth check that a future
 * decrypt-path regression in `sync-client.ts` fails closed at the IndexedDB
 * boundary rather than writing ciphertext in as though it were plaintext. An
 * envelope-shaped payload here means the transport guard was bypassed — the
 * HTTP client should have decrypted (or rejected) it before this point ever
 * ran — so it throws the same {@link UnauthenticatedPayloadError} rather than
 * coercing.
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
 * Schema-ahead rows can appear in the snapshot half of a bootstrap
 * response too, not just in the post-snapshot mutation list. Both
 * carriers must be inspected before any IDB write.
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
