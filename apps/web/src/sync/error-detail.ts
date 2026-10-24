// Error-classification helpers for SyncContext's badge: thrown value to SyncErrorDetail, schema-ahead breadcrumb,
// and the freshness-rejection check. Pure; no reference to provider state.
import { SyncApiError, FreshnessRollbackError } from './sync-client.js';
import { FreshnessError } from '../crypto/freshness.js';
import type { SyncErrorDetail } from './types.js';
import { recordSchemaAhead } from '../lib/build-id.js';
import { recordSyncWarn } from '../lib/diagnostics/logger.js';
import { UnauthenticatedPayloadError, type SchemaAheadError } from './pull-apply.js';

/**
 * Single place for "did apply bail because the server is ahead of this bundle?": arms the version banner via
 * `recordSchemaAhead`. The caller sets its own calm `update-available` badge and uses the returned detail only for its
 * diagnostics breadcrumb.
 */
export function handleSchemaAhead(err: SchemaAheadError): SyncErrorDetail {
  recordSchemaAhead();
  return {
    phase: 'pull',
    code: 'SCHEMA_AHEAD',
    message: `${err.aggregateType} payload is at v${err.theirVersion}; this app only knows v${err.ourCurrent}. Reload to update.`,
  };
}

/**
 * Rejections that surface as the `rollback-detected` badge, thrown before the caller reaches its IDB write loop:
 * `FreshnessRollbackError`/`FreshnessError` (a rollback or tampered cursor-tag MAC; never thrown without an HDK), and
 * `UnauthenticatedPayloadError` (with an HDK held, a served payload that isn't a strict envelope or fails its GCM tag).
 * The latter is recorded as phase/reason only, never payload content.
 */
export function isRollbackDetectedRejection(err: unknown): boolean {
  if (err instanceof FreshnessRollbackError || err instanceof FreshnessError) return true;
  if (err instanceof UnauthenticatedPayloadError) {
    recordSyncWarn(
      `[sync] rejected served payload — ${err.phase}/${err.reason}: not authenticated, no local write`,
    );
    return true;
  }
  return false;
}

// Fired when a rollback-detected rejection is caught outside the SyncProvider poll (the forced-export transport in
// `use-profile-export.ts` runs its own HttpSyncClient), so it still flips the shared badge. A no-op before SyncProvider
// mounts.
let onRollbackDetectedOutsideSync: () => void = () => {};

export function setOnRollbackDetectedOutsideSync(handler: () => void): void {
  onRollbackDetectedOutsideSync = handler;
}

export function notifyRollbackDetectedOutsideSync(): void {
  onRollbackDetectedOutsideSync();
}

/**
 * Structured detail for the `error` badge from any thrown value: a SyncApiError passes its envelope (code, message,
 * traceId, status) through; other errors carry only a message. The popover renders and copies it for bug reports.
 */
export function buildErrorDetail(
  err: unknown,
  phase: SyncErrorDetail['phase'],
  fallbackMessage: string,
): SyncErrorDetail {
  if (err instanceof SyncApiError) {
    return {
      phase,
      code: err.code,
      message: err.message,
      status: err.status,
      traceId: err.traceId,
      retryAfterMs: err.retryAfterMs,
    };
  }
  return {
    phase,
    message: err instanceof Error ? err.message : fallbackMessage,
  };
}
