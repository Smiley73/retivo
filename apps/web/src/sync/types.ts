/**
 * Sync state surfaced to the UI via SyncContext. Mirrors the badge
 * states.
 *
 * The wire envelope shapes (push / pull / bootstrap) are defined once in
 * `@retirement/contracts` and re-exported / narrowed here. The shared contract
 * keeps every `payload` field OPAQUE (`unknown`) to preserve the API's
 * zero-knowledge boundary (the server never has a typed opinion about payload
 * shape). This module narrows that opaque payload to the web-local
 * `Record<string, unknown> | EncryptedPayloadEnvelope` union the client
 * actually handles — the sync-client decrypts any encrypted envelope in place
 * before the response reaches SyncContext. `EncryptedPayloadEnvelope` stays
 * web-local (crypto/encryption-types) and is deliberately NOT hoisted into the
 * shared package.
 */
import type { EncryptedPayloadEnvelope } from '../crypto/encryption-types.js';
import type {
  BootstrapResponseBody as WireBootstrapResponseBody,
  PullResponseBody as WirePullResponseBody,
  SnapshotAggregate as WireSnapshotAggregate,
  SyncChange as WireSyncChange,
} from '@retirement/contracts';

// Wire shapes that carry no `payload` are identical FE/BE — re-export verbatim.
export type {
  PushedMutationRejected,
  PushResponseBody,
  SnapshotListItem,
} from '@retirement/contracts';

/**
 * Web-local decrypted-or-encrypted payload union. The wire contract types keep
 * `payload: unknown`; the web narrows to this at the point of use.
 */
type WebPayload = Record<string, unknown> | EncryptedPayloadEnvelope;

/** One pulled change / post-snapshot mutation, payload narrowed to the
 *  web-local union (see module note). */
interface SyncChange extends Omit<WireSyncChange, 'payload'> {
  payload: WebPayload;
}

/** One bootstrap snapshot aggregate, payload narrowed to the web-local union. */
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

/**
 * Structured detail for the `error` badge state. Carries everything a
 * user needs to copy into a bug report — the API error envelope's
 * `code`/`traceId` plus the HTTP status — without leaking it into the
 * other (happy-path) variants.
 */
export interface SyncErrorDetail {
  message: string;
  code?: string;
  traceId?: string;
  status?: number;
  /** Which sync leg failed; helps triage push vs pull vs bootstrap regressions. */
  phase?: 'push' | 'pull' | 'bootstrap';
  /** Parsed `Retry-After` from the failing response, in ms — `null`/absent when the header was missing or unparseable,
   *  distinct from a real zero-length wait. Carried here so the badge-facing
   *  projection has it too, even though the sync loop's own scheduler reads the
   *  value off the thrown `SyncApiError` directly (refs, not reactive state). */
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
  // Zero-knowledge freshness rollback: a sync response
  // served a freshness counter below this device's pin, or the cursor
  // tag failed verification. The client rejects the response before any
  // local write — surfaced so the user can investigate a tampered/stale
  // server view.
  | { kind: 'rollback-detected' }
  // Deploy-time schema-ahead: a pulled/bootstrapped
  // row is at a `schemaVersion` this bundle's migration registry can't
  // read yet. Sync has already halted (no IDB write, no cursor advance)
  // and the `<VersionBanner>` is armed via `recordSchemaAhead` — this is
  // a calm "update needed" badge, not a red sync error, since a reload
  // (not a retry) is the only recovery path.
  | { kind: 'update-available' };

export interface SyncSnapshot {
  state: SyncBadgeState;
  pendingCount: number;
  conflictCount: number;
  lastSyncedAt: string | null;
}
