// Workspace export envelope: the bundle shape, the download primitives, and `buildExportBundle`, a local-only
// bundle for the round-trip drill (the real download is `server-data-export.ts`).

import { listAggregates } from '../db/store';
import type { Aggregate, AggregateType, PendingMutation } from '../db/types';
import { CLIENT_BUILD_ID } from './build-id';

export const EXPORT_BUNDLE_FORMAT = 'retivo-export';
/** Marker on exports made before the rename; the importer still accepts it, and new exports carry `EXPORT_BUNDLE_FORMAT`. */
export const LEGACY_EXPORT_BUNDLE_FORMAT = 'retirement-export';
export const EXPORT_BUNDLE_VERSION = 1;

// Parents before children, so the importer's replay keeps referential integrity; scenarios are also sorted by ancestor depth.
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
 * An aggregate whose importable view was resolved from retained unsynced local
 * intent rather than the server baseline, emitted for every id still carrying a
 * retained queue row so a newer server update is never silently lost. Both
 * variants are nullable and tombstone-preserving (`null` means absent on that
 * side); `queuedMutations` is the full ordered stack.
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
  /** Present only when retained local intent was merged over the server baseline; omitted otherwise (byte-compatible with a version-1 bundle). */
  unresolvedLocalChanges?: UnresolvedLocalChange[];
  /**
     * Account-record section on every server-authoritative export: field-level
     * projections only, never key material or other credentials (see
     * `apps/api/src/auth/account-export.service.ts`). Omitted by the local-only drill,
     * so the version stays 1. The importer never reads it.
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
  // Bytes via Response(Blob): `Blob.stream()` is missing in jsdom, and a hand-rolled stream trips a TS variance error; the cast avoids the SharedArrayBuffer check.
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const body = new Response(new Blob([bytes.buffer as ArrayBuffer])).body;
  if (!body) throw new Error('Response body unavailable in this runtime.');
  return new Response(body.pipeThrough(new CompressionStream('gzip'))).blob();
}

export function exportFilename(householdId: string, exportedAt: string): string {
  const datePart = exportedAt.slice(0, 10);
  return `retivo-export-${householdId}-${datePart}.json.gz`;
}

/** Uncompressed variant of `exportFilename`, for a reader or a tool that cannot gunzip. */
export function exportFilenameJson(householdId: string, exportedAt: string): string {
  const datePart = exportedAt.slice(0, 10);
  return `retivo-export-${householdId}-${datePart}.json`;
}

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
