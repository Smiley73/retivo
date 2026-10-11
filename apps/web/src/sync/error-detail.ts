/**
 * Error-classification helpers for SyncContext's badge state: mapping a
 * thrown value to a structured `SyncErrorDetail`, recording the
 * schema-ahead breadcrumb, and detecting a zero-knowledge freshness
 * rejection. Split out of SyncContext.tsx to keep that file under the shape limit — pure functions,
 * no reference to provider state.
 */
import { SyncApiError, FreshnessRollbackError } from './sync-client.js';
import { FreshnessError } from '../crypto/freshness.js';
import type { SyncErrorDetail } from './types.js';
import { recordSchemaAhead } from '../lib/build-id.js';
import { recordSyncWarn } from '../lib/diagnostics/logger.js';
import { UnauthenticatedPayloadError, type SchemaAheadError } from './pull-apply.js';

/**
 * Single source of truth for "did the apply step bail because the
 * server is ahead of this bundle?". Pull and bootstrap both call into
 * `recordSchemaAhead` to surface the version banner. The caller sets its
 * own `update-available` badge state (a calm
 * "update needed" state, not a red sync error) and uses the returned
 * detail only to build its diagnostics breadcrumb, since the badge
 * carries no `code`/`message` of its own.
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
 * Rejections that surface as the `rollback-detected` badge (two unrelated
 * causes share it). The HTTP client throws each of these BEFORE returning a
 * response, so the caller never reaches its IDB write loop:
 *
 *  - `FreshnessRollbackError` / `FreshnessError`: a rollback
 *    or a tampered cursor-tag MAC. Never thrown without an HDK (no HDK → no
 *    head sent → no head echoed).
 *  - `UnauthenticatedPayloadError`: once an HDK is held,
 *    a served pull/bootstrap payload that isn't a strict encrypted envelope,
 *    or one whose GCM tag fails. Recorded through the diagnostics helper
 *    used elsewhere in the sync modules — the phase/reason only, never
 *    payload content.
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

/**
 * Global hook fired when a rollback-detected rejection (see
 * `isRollbackDetectedRejection` above) is caught OUTSIDE the normal
 * SyncProvider pull/bootstrap poll — currently only the forced-export
 * transport (`createExportSyncTransport`, `use-profile-export.ts`), which
 * runs its own `HttpSyncClient` and never touches `SyncProvider`'s
 * `setSyncState`. Registered by `SyncProvider` so a served/tampered payload
 * caught on that separate transport still flips the shared sync badge to
 * `rollback-detected` (a second, independent transport must flip shared UI
 * state). A no-op before `SyncProvider` mounts.
 */
let onRollbackDetectedOutsideSync: () => void = () => {};

export function setOnRollbackDetectedOutsideSync(handler: () => void): void {
  onRollbackDetectedOutsideSync = handler;
}

export function notifyRollbackDetectedOutsideSync(): void {
  onRollbackDetectedOutsideSync();
}

/**
 * Build a structured detail for the `error` badge variant from any
 * thrown value. SyncApiError carries the full envelope (code, message,
 * traceId, status) — those flow straight through. Other Errors only
 * have a `message`. The detail is what the SyncBadge popover renders
 * + copies, so users can paste a real bug report.
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
