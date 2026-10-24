// Sync state for the UI via SyncContext. Wire envelopes come from `@retirement/contracts`, `payload` kept opaque there;
// here it narrows to plaintext or `EncryptedPayloadEnvelope` (sync-client decrypts envelopes in place).
import type { EncryptedPayloadEnvelope } from '../crypto/encryption-types.js';
import type {
  BootstrapResponseBody as WireBootstrapResponseBody,
  PullResponseBody as WirePullResponseBody,
  SnapshotAggregate as WireSnapshotAggregate,
  SyncChange as WireSyncChange,
} from '@retirement/contracts';

export type {
  PushedMutationRejected,
  PushResponseBody,
  SnapshotListItem,
} from '@retirement/contracts';

type WebPayload = Record<string, unknown> | EncryptedPayloadEnvelope;

interface SyncChange extends Omit<WireSyncChange, 'payload'> {
  payload: WebPayload;
}

interface SnapshotAggregate extends Omit<WireSnapshotAggregate, 'payload'> {
  payload: WebPayload;
}

export interface PullResponseBody extends Omit<WirePullResponseBody, 'changes'> {
  changes: SyncChange[];
}

export interface BootstrapResponseBody
  extends Omit<WireBootstrapResponseBody, 'workspaceSnapshot' | 'postSnapshotMutations'> {
  workspaceSnapshot: {
    householdId: string;
    aggregates: SnapshotAggregate[];
  };
  postSnapshotMutations: SyncChange[];
}

/** Detail for the `error` badge: the API envelope's `code`/`traceId` plus the HTTP status, for bug reports. */
export interface SyncErrorDetail {
  message: string;
  code?: string;
  traceId?: string;
  status?: number;
  /** Which sync leg failed; helps triage push vs pull vs bootstrap regressions. */
  phase?: 'push' | 'pull' | 'bootstrap';
  /**
   * Parsed `Retry-After` in ms; null/absent when missing or unparseable, distinct from a zero-length wait. The sync
   * loop's scheduler reads it off the thrown `SyncApiError` instead (refs, not reactive state).
   */
  retryAfterMs?: number | null;
}

export type SyncBadgeState =
  | { kind: 'synced'; lastSyncedAt: string | null }
  | { kind: 'syncing-push' }
  | { kind: 'syncing-pull' }
  | { kind: 'offline' }
  | ({ kind: 'error' } & SyncErrorDetail)
  | { kind: 'stale'; message?: string }
  | { kind: 'pending'; count: number }
  // Freshness rollback: a response carried a counter below this device's pin or a failed cursor tag; rejected before
  // any local write.
  | { kind: 'rollback-detected' }
  // Schema-ahead: a pulled row's `schemaVersion` is newer than this bundle's migration registry. Sync halted with no
  // IDB write and the version banner is armed; a calm badge, since a reload (not a retry) recovers.
  | { kind: 'update-available' };

export interface SyncSnapshot {
  state: SyncBadgeState;
  pendingCount: number;
  conflictCount: number;
  lastSyncedAt: string | null;
}
