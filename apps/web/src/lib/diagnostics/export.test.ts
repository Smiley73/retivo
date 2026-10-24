import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportDiagnostics } from './export';
import { clear, flush, recordError } from './logger';
import * as logger from './logger';
import * as store from '../../db/store';
import { clearDiagnosticLogs } from '../../db/store';
import type { DiagnosticEntry } from './logger';

interface ExportedEnvelope {
  format: string;
  version: number;
  exportedAt: string;
  householdId?: string;
  entries: DiagnosticEntry[];
}

/** Runs the real export, capturing the downloaded blob and filename and gunzipping the blob. */
async function runExport(
  householdId?: string,
): Promise<{ envelope: ExportedEnvelope; filename: string; clicks: number }> {
  let filename = '';
  let clicks = 0;
  let blob: Blob | undefined;
  const createEl = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = createEl(tag);
    if (tag === 'a') {
      (el as HTMLAnchorElement).click = () => {
        clicks += 1;
        filename = (el as HTMLAnchorElement).download;
      };
    }
    return el;
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
    blob = b as Blob;
    return 'blob:diag';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  await exportDiagnostics(householdId);
  const text = await new Response(
    new Response(blob).body!.pipeThrough(new DecompressionStream('gzip')),
  ).text();
  return { envelope: JSON.parse(text) as ExportedEnvelope, filename, clicks };
}

describe('diagnostics export', () => {
  beforeEach(async () => {
    clear();
    await clearDiagnosticLogs();
  });
  afterEach(() => {
    clear();
    vi.restoreAllMocks();
  });

  it('should_download_a_dated_gzip_envelope_with_format_and_entries', async () => {
    recordError('captured');
    await flush();
    const { envelope: env, filename, clicks } = await runExport('hh-1');
    expect(clicks).toBe(1);
    expect(filename).toBe(`retivo-diagnostics-${env.exportedAt.slice(0, 10)}.json.gz`);
    expect(env.format).toBe('retivo-diagnostics');
    expect(env.version).toBe(1);
    expect(env.householdId).toBe('hh-1');
    expect(env.entries.some((e) => e.message === 'captured')).toBe(true);
  });

  it('should_build_an_empty_envelope_when_nothing_captured', async () => {
    const { envelope: env } = await runExport();
    expect(env.entries).toHaveLength(0);
    expect(env.householdId).toBeUndefined();
  });

  it('should_merge_a_persisted_row_with_a_newer_unflushed_in_memory_entry_ordered_by_seq', async () => {
    // The persisted-only path used to drop the unflushed entry (the ErrorBoundary crash being reported).
    recordError('persisted older');
    await flush();
    recordError('in-memory newer');
    const { envelope: env } = await runExport();
    const messages = env.entries.map((e) => e.message);
    expect(messages).toContain('persisted older');
    expect(messages).toContain('in-memory newer');
    expect(messages.indexOf('persisted older')).toBeLessThan(
      messages.indexOf('in-memory newer'),
    );
  });

  it('should_order_an_unflushed_entry_with_a_lower_provisional_seq_after_a_persisted_row', async () => {
    // In-memory `memSeq` and IDB `seq` are independent counter spaces: an unflushed entry (e.g. from another tab) can carry a lower seq than a persisted row and must still order last.
    const persistedRow: DiagnosticEntry = {
      id: 'persisted-1',
      seq: 50,
      ts: '2026-06-29T00:00:00.000Z',
      level: 'error',
      source: 'console',
      message: 'persisted high seq',
      buildId: 'b',
      path: '/',
    };
    const unflushedRow: DiagnosticEntry = {
      id: 'unflushed-1',
      seq: 2,
      ts: '2026-06-29T00:00:01.000Z',
      level: 'error',
      source: 'console',
      message: 'unflushed low provisional seq',
      buildId: 'b',
      path: '/',
    };
    vi.spyOn(store, 'listDiagnosticLogs').mockResolvedValue([
      persistedRow,
    ] as never);
    vi.spyOn(logger, 'getEntries').mockReturnValue([unflushedRow]);

    const { envelope: env } = await runExport();
    const messages = env.entries.map((e) => e.message);
    expect(messages).toEqual([
      'persisted high seq',
      'unflushed low provisional seq',
    ]);
  });
});
