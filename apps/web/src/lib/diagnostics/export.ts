/**
 * Diagnostics export: a separate gzipped JSON envelope, never synced; it leaves the device only by explicit download (gzip is not encryption).
 * Merges the persisted IDB store with the in-memory rings so an unflushed entry, such as the crash being reported, is still exported.
 */
import { listDiagnosticLogs } from '../../db/store.js';
import { CLIENT_BUILD_ID } from '../build-id.js';
import { gzipJson, triggerBrowserDownload } from '../data-export.js';
import { getEntries, type DiagnosticEntry } from './logger.js';

const DIAGNOSTICS_EXPORT_FORMAT = 'retivo-diagnostics';
const DIAGNOSTICS_EXPORT_VERSION = 1;

interface DiagnosticsExportEnvelope {
  format: typeof DIAGNOSTICS_EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  buildId: string;
  householdId?: string;
  entries: DiagnosticEntry[];
}

/** ISO date (YYYY-MM-DD); the full timestamp lives in `exportedAt`. */
function diagnosticsExportFilename(exportedAt: string): string {
  return `retivo-diagnostics-${exportedAt.slice(0, 10)}.json.gz`;
}

/**
 * Merge persisted rows and in-memory rings by `id` (in-memory wins: fresher `count`); falls back to
 * the rings alone on an IDB read failure.
 */
async function buildDiagnosticsEnvelope(
  householdId?: string,
): Promise<DiagnosticsExportEnvelope> {
  let entries: DiagnosticEntry[];
  try {
    const persisted = (await listDiagnosticLogs()) as unknown as DiagnosticEntry[];
    const persistedIds = new Set<string>(persisted.map((entry) => entry.id));
    const byId = new Map<string, DiagnosticEntry>();
    for (const entry of persisted) byId.set(entry.id, entry);
    for (const entry of getEntries()) byId.set(entry.id, entry);
    // Persisted rows by authoritative seq, then unflushed entries by ts: the IDB seq and
    // provisional memSeq counter spaces must not interleave.
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

/** Build, gzip and download the diagnostics envelope. */
export async function exportDiagnostics(householdId?: string): Promise<void> {
  const envelope = await buildDiagnosticsEnvelope(householdId);
  const blob = await gzipJson(envelope);
  triggerBrowserDownload(blob, diagnosticsExportFilename(envelope.exportedAt));
}
