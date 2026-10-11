/**
 * Diagnostics export. A SEPARATE gzipped JSON envelope — NOT part of the
 * household `ExportBundle`, never synced. Reuses `gzipJson()` +
 * `triggerBrowserDownload()` + the `data-export.ts` filename style so there is
 * one download mechanism. The file NEVER leaves the device except by this
 * explicit, user-initiated download; it carries a "may contain personal data"
 * warning in the card — gzip is NOT encryption.
 *
 * The export MERGES the persisted IDB store (survives reload) with the
 * in-memory rings by `id` (the in-memory entry wins on an id collision, since
 * it may carry a fresher coalesced `count`). Ordering partitions the union:
 * persisted rows first, ordered by their IDB-authoritative `seq`, then any
 * UNFLUSHED in-memory entry (one whose id is not in the persisted set, still
 * carrying only the module-local provisional `memSeq`) ordered by `ts`. The two
 * counter spaces (authoritative IDB `seq` vs provisional `memSeq`) thus never
 * interleave — an unflushed entry with a lower provisional seq than a persisted
 * row still sorts last. The merge guarantees a freshly-captured-but-not-yet-
 * flushed entry (e.g. the crash the ErrorBoundary "Export diagnostics" is
 * reporting) is still exported. On an IDB read failure it falls back to the
 * in-memory rings alone, so a private-mode session can still export what it
 * captured.
 */
import { listDiagnosticLogs } from '../../db/store.js';
import { CLIENT_BUILD_ID } from '../build-id.js';
import { gzipJson, triggerBrowserDownload } from '../data-export.js';
import { getEntries, type DiagnosticEntry } from './logger.js';

export const DIAGNOSTICS_EXPORT_FORMAT = 'retivo-diagnostics';
const DIAGNOSTICS_EXPORT_VERSION = 1;

export interface DiagnosticsExportEnvelope {
  format: typeof DIAGNOSTICS_EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  buildId: string;
  householdId?: string;
  entries: DiagnosticEntry[];
}

/** ISO date (YYYY-MM-DD); the full timestamp lives in `exportedAt`. */
export function diagnosticsExportFilename(exportedAt: string): string {
  return `retivo-diagnostics-${exportedAt.slice(0, 10)}.json.gz`;
}

/**
 * Build the export envelope by merging the persisted store with the in-memory
 * rings by `id` (in-memory wins on collision). Persisted rows order by their
 * authoritative `seq`; unflushed in-memory entries follow, ordered by `ts`, so
 * the two counter spaces never interleave. Never throws on an IDB read
 * failure — falls back to the in-memory rings alone.
 */
export async function buildDiagnosticsEnvelope(
  householdId?: string,
): Promise<DiagnosticsExportEnvelope> {
  let entries: DiagnosticEntry[];
  try {
    const persisted = (await listDiagnosticLogs()) as unknown as DiagnosticEntry[];
    // Merge persisted + in-memory by id; the in-memory entry wins on a collision
    // (it may carry a fresher coalesced count). A not-yet-flushed in-memory entry
    // is thus always present in the export.
    const persistedIds = new Set<string>(persisted.map((entry) => entry.id));
    const byId = new Map<string, DiagnosticEntry>();
    for (const entry of persisted) byId.set(entry.id, entry);
    for (const entry of getEntries()) byId.set(entry.id, entry);
    // Partition the union: persisted rows (authoritative IDB seq) first, then
    // unflushed in-memory entries (provisional memSeq) by ts. The two counter
    // spaces must not interleave — an unflushed entry whose provisional seq is
    // lower than a persisted seq still sorts last.
    const merged = [...byId.values()];
    const persistedRows = merged
      .filter((entry) => persistedIds.has(entry.id))
      .sort((a, b) => a.seq - b.seq);
    const unflushedRows = merged
      .filter((entry) => !persistedIds.has(entry.id))
      .sort((a, b) => a.ts.localeCompare(b.ts));
    entries = [...persistedRows, ...unflushedRows];
  } catch {
    entries = getEntries();
  }
  return {
    format: DIAGNOSTICS_EXPORT_FORMAT,
    version: DIAGNOSTICS_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    buildId: CLIENT_BUILD_ID,
    ...(householdId ? { householdId } : {}),
    entries,
  };
}

/**
 * Build, gzip, and download the diagnostics envelope. Called by the card's
 * Export action and the ErrorBoundary fallback's Export action.
 */
export async function exportDiagnostics(householdId?: string): Promise<void> {
  const envelope = await buildDiagnosticsEnvelope(householdId);
  const blob = await gzipJson(envelope);
  triggerBrowserDownload(blob, diagnosticsExportFilename(envelope.exportedAt));
}
