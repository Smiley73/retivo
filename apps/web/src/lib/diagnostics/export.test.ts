/**
 * Diagnostics export tests. Envelope shape, filename style, gzip download,
 * and the empty-store case. Mirrors data-export.test.ts.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDiagnosticsEnvelope,
  diagnosticsExportFilename,
  exportDiagnostics,
  DIAGNOSTICS_EXPORT_FORMAT,
} from './export';
import { clear, flush, recordError } from './logger';
import * as logger from './logger';
import * as store from '../../db/store';
import { clearDiagnosticLogs } from '../../db/store';
import type { DiagnosticEntry } from './logger';

describe('diagnostics export', () => {
  beforeEach(async () => {
    clear();
    await clearDiagnosticLogs();
  });
  afterEach(() => {
    clear();
    vi.restoreAllMocks();
  });

  it('diagnosticsExportFilename_uses_the_iso_date', () => {
    expect(diagnosticsExportFilename('2026-06-29T12:34:56.000Z')).toBe(
      'retivo-diagnostics-2026-06-29.json.gz',
    );
  });

  it('should_build_an_envelope_with_format_and_entries', async () => {
    recordError('captured');
    await flush();
    const env = await buildDiagnosticsEnvelope('hh-1');
    expect(env.format).toBe(DIAGNOSTICS_EXPORT_FORMAT);
    expect(env.version).toBe(1);
    expect(env.householdId).toBe('hh-1');
    expect(env.entries.some((e) => e.message === 'captured')).toBe(true);
  });

  it('should_build_an_empty_envelope_when_nothing_captured', async () => {
    const env = await buildDiagnosticsEnvelope();
    expect(env.entries).toHaveLength(0);
    expect(env.householdId).toBeUndefined();
  });

  it('should_merge_a_persisted_row_with_a_newer_unflushed_in_memory_entry_ordered_by_seq', async () => {
    // A first entry is captured AND flushed (persisted). A second is captured
    // but NOT yet flushed (the ErrorBoundary crash being reported). The export
    // must include BOTH, ordered by seq — the persisted-only path used to drop
    // the un-flushed entry.
    recordError('persisted older');
    await flush();
    recordError('in-memory newer');
    const env = await buildDiagnosticsEnvelope();
    const messages = env.entries.map((e) => e.message);
    expect(messages).toContain('persisted older');
    expect(messages).toContain('in-memory newer');
    // Ordered by seq ascending — the persisted (older) entry precedes the
    // un-flushed (newer) one.
    expect(messages.indexOf('persisted older')).toBeLessThan(
      messages.indexOf('in-memory newer'),
    );
  });

  it('should_order_an_unflushed_entry_with_a_lower_provisional_seq_after_a_persisted_row', async () => {
    // Provisional in-memory `memSeq` and IDB-authoritative `seq` are two
    // independent counter spaces. An unflushed in-memory entry can carry a LOWER
    // provisional seq than a persisted row's authoritative seq (e.g. across
    // tabs). It must still order LAST — never interleave by raw seq.
    const persistedRow: DiagnosticEntry = {
      id: 'persisted-1',
      seq: 50, // authoritative IDB seq — HIGHER than the unflushed provisional
      ts: '2026-06-29T00:00:00.000Z',
      level: 'error',
      source: 'console',
      message: 'persisted high seq',
      buildId: 'b',
      path: '/',
    };
    const unflushedRow: DiagnosticEntry = {
      id: 'unflushed-1',
      seq: 2, // provisional memSeq — LOWER than the persisted seq
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

    const env = await buildDiagnosticsEnvelope();
    const messages = env.entries.map((e) => e.message);
    // Despite its lower provisional seq, the unflushed entry sorts AFTER the
    // persisted row.
    expect(messages).toEqual([
      'persisted high seq',
      'unflushed low provisional seq',
    ]);
  });

  it('should_trigger_a_gzip_download', async () => {
    const click = vi.fn();
    const createEl = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = createEl(tag);
      if (tag === 'a') (el as HTMLAnchorElement).click = click;
      return el;
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:diag');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    recordError('download me');
    await flush();
    await exportDiagnostics('hh-1');
    expect(click).toHaveBeenCalledTimes(1);
  });
});
