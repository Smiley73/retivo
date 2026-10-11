/**
 * Self-service workspace export envelope: the bundle shape, the download
 * primitives (`gzipJson` / `exportFilename` / `triggerBrowserDownload`), and a
 * local-only `buildExportBundle` used by the round-trip import drill.
 *
 * The actual "Export my data" download is now the SERVER-AUTHORITATIVE path in
 * `server-data-export.ts`: it fetches and
 * decrypts current server state, overlays only retained unsynced local intent,
 * and preserves both variants in `unresolvedLocalChanges`. `buildExportBundle`
 * here reads IndexedDB only and is NOT the download path.
 */
import { listAggregates } from '../db/store';
import type { Aggregate, AggregateType, PendingMutation } from '../db/types';
import { CLIENT_BUILD_ID } from './build-id';

export const EXPORT_BUNDLE_FORMAT = 'retivo-export';
/**
 * Envelope marker written by exports made before the RETIVO rename. The
 * importer accepts it so files exported earlier keep importing; new exports
 * always carry `EXPORT_BUNDLE_FORMAT`.
 */
export const LEGACY_EXPORT_BUNDLE_FORMAT = 'retirement-export';
export const EXPORT_BUNDLE_VERSION = 1;

// Dependency order: parents before children. The importer iterates this
// order so referential integrity (e.g. accountBalance.accountId →
// account.id, scenario.parentScenarioId → scenario.id) holds during
// the replay. Within `scenario`, the import path additionally sorts by
// ancestor depth so a child never lands before its parent.
export const AGGREGATE_TYPES_IN_DEPENDENCY_ORDER: AggregateType[] = [
  'household',
  'householdMember',
  'account',
  'accountBalance',
  'socialSecurityBenefit',
  'expenseCategory',
  'expense',
  'incomeStream',
  'scenario',
];

/**
 * One aggregate whose importable `aggregates` view was resolved from retained
 * unsynced local intent rather than the server-authoritative baseline.
 * Emitted for every aggregate id that
 * still carries a retained mutation-queue row (`pending` / `pushing` /
 * `failed-conflict` / `failed-error`) at export time, so a newer server update
 * that the importable local-wins view drops is never silently lost.
 *
 * Both `serverAggregate` and `localAggregate` are nullable and
 * tombstone-preserving: a `deletedAt`-carrying row is retained as-is (not
 * collapsed to `null`), and `null` means the row is genuinely absent on that
 * side. `queuedMutations` is the full, deterministically ordered retained queue
 * stack for the id (including any `reason` / `currentVersion` /
 * `currentUpdatedAt` rejection metadata the rows carry). Additive and optional
 * on {@link ExportBundle}, so a version-1 importer that ignores
 * the field still restores the main `aggregates` view unchanged.
 */
export interface UnresolvedLocalChange {
  aggregateType: AggregateType;
  aggregateId: string;
  exportedResolution: 'local_view';
  serverAggregate: Aggregate | null;
  localAggregate: Aggregate | null;
  queuedMutations: PendingMutation[];
}

export interface ExportBundle {
  format: typeof EXPORT_BUNDLE_FORMAT;
  version: number;
  exportedAt: string;
  exportedByBuildId: string;
  householdId: string;
  deviceId: string;
  aggregates: Record<AggregateType, Aggregate[]>;
  /**
   * Additive supplemental record. Present and non-empty only when the
   * export merged retained unsynced local intent over the server baseline; each
   * entry preserves both variants so the local-wins importable view is never
   * lossy. Omitted when there is no retained intent (byte-compatible with a
   * version-1 bundle without it).
   */
  unresolvedLocalChanges?: UnresolvedLocalChange[];
  /**
   * Additive account-record section. Present on every
   * server-authoritative export: the readable account record, the whole
   * retained sign-in/security history, key-envelope metadata, and every other
   * database store carrying rows attributable to
   * the signed-in person — as field-level projections (never a wrapped key,
   * KDF salt, token hash, or other credential material; see
   * `apps/api/src/auth/account-export.service.ts`). Optional so the shape
   * stays byte-compatible with a bundle that lacks it (`EXPORT_BUNDLE_VERSION`
   * stays `1`, the same additive precedent `unresolvedLocalChanges` set) and
   * so the local-only round-trip drill (`buildExportBundle`) — which has no
   * server session to read the account half from — omits it entirely. The
   * importer (`data-import.ts`) never reads this field: an imported file's
   * account section is never written to IndexedDB or pushed to the server.
   */
  account?: Record<string, unknown>;
}

export async function buildExportBundle(
  householdId: string,
  deviceId: string,
): Promise<ExportBundle> {
  const aggregates = {} as Record<AggregateType, Aggregate[]>;
  for (const type of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) {
    aggregates[type] = await listAggregates(type);
  }
  return {
    format: EXPORT_BUNDLE_FORMAT,
    version: EXPORT_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    exportedByBuildId: CLIENT_BUILD_ID,
    householdId,
    deviceId,
    aggregates,
  };
}

export async function gzipJson(value: unknown): Promise<Blob> {
  // Encode to bytes first, then pipe via Response(Blob).body. Cannot
  // use new Blob().stream() (jsdom gap), nor a hand-rolled
  // ReadableStream<Uint8Array> (TS variance error against
  // CompressionStream's writable type). Casting the underlying buffer
  // sidesteps the SharedArrayBuffer-lurking-in-ArrayBufferLike check.
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const body = new Response(new Blob([bytes.buffer as ArrayBuffer])).body;
  if (!body) throw new Error('Response body unavailable in this runtime.');
  return new Response(body.pipeThrough(new CompressionStream('gzip'))).blob();
}

export function exportFilename(householdId: string, exportedAt: string): string {
  // ISO date (YYYY-MM-DD) for readability; full timestamp lives inside
  // the bundle as `exportedAt`.
  const datePart = exportedAt.slice(0, 10);
  return `retivo-export-${householdId}-${datePart}.json.gz`;
}

/**
 * Uncompressed-JSON filename variant — offered
 * alongside the gzipped file so a person who wants to read (or hand to a
 * tool that can't gunzip) their export doesn't need one. Same naming
 * convention as {@link exportFilename}, `.json` instead of `.json.gz`.
 */
export function exportFilenameJson(householdId: string, exportedAt: string): string {
  const datePart = exportedAt.slice(0, 10);
  return `retivo-export-${householdId}-${datePart}.json`;
}

/** Plain (uncompressed) JSON `Blob` — the uncompressed download choice. */
export function plainJson(value: unknown): Blob {
  return new Blob([JSON.stringify(value)], { type: 'application/json' });
}

export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
