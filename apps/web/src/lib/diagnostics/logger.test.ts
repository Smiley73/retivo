import 'fake-indexeddb/auto';
import { forceCloseDatabase } from 'fake-indexeddb';
// eslint-disable-next-line no-restricted-imports -- unwrap the cached handle so fake-indexeddb can force-close it
import { unwrap } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clear,
  clearAll,
  flush,
  getEntries,
  recordBreadcrumb,
  recordError,
  recordSyncWarn,
  recordWarn,
  resumeRecording,
  suspendRecording,
} from './logger';
import {
  clearDiagnosticLogs,
  listDiagnosticLogs,
} from '../../db/store';
import * as store from '../../db/store';

describe('diagnostics logger', () => {
  beforeEach(async () => {
    clear();
    await clearDiagnosticLogs();
  });
  afterEach(() => {
    resumeRecording();
    clear();
    vi.restoreAllMocks();
  });

  it('should_keep_below_cap_entries_without_eviction', () => {
    recordError('one');
    recordWarn('two');
    const entries = getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe('one');
    expect(entries[1].level).toBe('warn');
  });

  it('should_evict_oldest_error_entries_at_cap', () => {
    for (let i = 0; i < 1010; i += 1) recordError(`e${i}`);
    const errors = getEntries().filter((e) => e.level === 'error');
    expect(errors).toHaveLength(1000);
    expect(errors[0].message).toBe('e10');
  });

  it('should_not_let_breadcrumbs_evict_error_history', () => {
    recordError('important error');
    for (let i = 0; i < 500; i += 1) recordBreadcrumb('log', `b${i}`);
    const errors = getEntries().filter((e) => e.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('important error');
    const crumbs = getEntries().filter((e) => e.level === 'log');
    expect(crumbs).toHaveLength(200);
  });

  it('should_parse_a_namespace_into_the_entry', () => {
    recordWarn('[sync] something happened');
    const [entry] = getEntries();
    expect(entry.namespace).toBe('sync');
    expect(entry.message).toBe('something happened');
  });

  it('should_record_no_namespace_for_an_unprefixed_or_non_string_first_arg', () => {
    recordWarn('plain message');
    recordWarn({ code: 'X' });
    const entries = getEntries();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.namespace === undefined)).toBe(true);
    expect(entries[0].message).toBe('plain message');
  });

  it('should_record_recordSyncWarn_as_a_warn_level_sync_entry_in_the_durable_ring', () => {
    recordSyncWarn('[sync] refresh needed — 2 unresolved conflict(s)');
    const [entry] = getEntries();
    expect(entry.level).toBe('warn');
    expect(entry.source).toBe('sync');
    expect(entry.namespace).toBe('sync');
    expect(entry.message).toBe('refresh needed — 2 unresolved conflict(s)');
  });

  it('should_capture_extra_summary_string_args_into_the_detail', () => {
    recordSyncWarn(
      '[sync] push rejected 1 mutation(s) — refresh needed',
      'CONFLICT account/update (local v3 → server v5)',
    );
    const [entry] = getEntries();
    expect(entry.detail).toContain('CONFLICT');
    expect(entry.detail).toContain('account/update');
    expect(entry.detail).toContain('local v3 → server v5');
  });

  it('should_not_throw_when_recordSyncWarn_arg_serialization_explodes', () => {
    const hostile = {
      get reason(): string {
        throw new Error('boom');
      },
    };
    expect(() => recordSyncWarn('[sync] refresh needed', hostile)).not.toThrow();
    expect(getEntries().length).toBeGreaterThan(0);
  });

  it('should_not_throw_when_an_arg_serialization_explodes', () => {
    const hostile = {
      get code(): string {
        throw new Error('boom');
      },
    };
    expect(() => recordError('msg', hostile)).not.toThrow();
    expect(getEntries().length).toBeGreaterThan(0);
  });

  it('should_persist_queued_entries_to_idb_on_flush', async () => {
    recordError('persist me');
    await flush();
    const rows = await listDiagnosticLogs();
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('persist me');
    expect(typeof rows[0].seq).toBe('number');
  });

  it('should_allocate_monotonic_seq_across_separate_flushes', async () => {
    recordError('first');
    await flush();
    recordError('second');
    await flush();
    const rows = await listDiagnosticLogs();
    expect(rows.map((r) => r.message)).toEqual(['first', 'second']);
    expect(rows[1].seq).toBeGreaterThan(rows[0].seq);
  });

  it('should_not_throw_and_requeue_the_batch_when_idb_append_rejects', async () => {
    // IDB unavailable (private mode): flush() must not throw and must re-queue the drained batch.
    recordError('survives idb failure');
    const spy = vi
      .spyOn(store, 'appendDiagnosticLogs')
      .mockRejectedValueOnce(new Error('IDB unavailable'))
      .mockRejectedValueOnce(
        new DOMException('quota exceeded', 'QuotaExceededError'),
      );
    await expect(flush()).resolves.toBeUndefined();
    expect(getEntries().some((e) => e.message === 'survives idb failure')).toBe(true);
    expect(await listDiagnosticLogs()).toHaveLength(0);
    await expect(flush()).resolves.toBeUndefined();
    expect(await listDiagnosticLogs()).toHaveLength(0);
    spy.mockRestore();
    await flush();
    const rows = await listDiagnosticLogs();
    expect(rows.map((r) => r.message)).toEqual(['survives idb failure']);
  });

  it('should_coalesce_consecutive_identical_records_into_one_entry_with_count', () => {
    for (let i = 0; i < 5; i += 1) recordError('identical loop');
    const entries = getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('identical loop');
    expect(entries[0].count).toBe(5);
    recordError('a different line');
    const after = getEntries();
    expect(after).toHaveLength(2);
    expect(after[1].message).toBe('a different line');
    expect(after[1].count ?? 1).toBe(1);
  });

  it('should_NOT_coalesce_two_different_Error_messages', () => {
    // JSON.stringify(new Error(...)) is '{}', so a naive coalesce key would drop the second message.
    recordError(new Error('first'));
    recordError(new Error('second'));
    const entries = getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].count ?? 1).toBe(1);
    expect(entries[1].count ?? 1).toBe(1);
  });

  it('should_coalesce_two_identical_Error_messages_into_one_entry', () => {
    recordError(new Error('same boom'));
    recordError(new Error('same boom'));
    const entries = getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(2);
  });

  it('should_NOT_over_coalesce_on_token_boundary_collisions', () => {
    // ['ab','c'] and ['a','bc'] join to the same string under an empty delimiter; the unit-separator keeps them distinct.
    recordError('ab', 'c');
    recordError('a', 'bc');
    const entries = getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].count ?? 1).toBe(1);
    expect(entries[1].count ?? 1).toBe(1);
  });

  it('should_persist_the_coalesced_count_on_flush', async () => {
    recordError('coalesced persist');
    recordError('coalesced persist');
    recordError('coalesced persist');
    await flush();
    const rows = await listDiagnosticLogs();
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
  });

  it('should_drain_at_most_MAX_FLUSH_BATCH_per_flush_and_reschedule_the_remainder', async () => {
    for (let i = 0; i < 250; i += 1) recordError(`batch-${i}`);
    await flush();
    let rows = await listDiagnosticLogs();
    expect(rows).toHaveLength(200);
    expect(rows[0].message).toBe('batch-0');
    expect(rows[199].message).toBe('batch-199');
    await flush();
    rows = await listDiagnosticLogs();
    expect(rows).toHaveLength(250);
    expect(rows[249].message).toBe('batch-249');
  });

  it('should_NOT_resurrect_a_drained_batch_when_clear_interleaves_a_failing_flush', async () => {
    // Cross-user leak race: clear() runs after a flush drained user A's batch but before the append rejects; the catch path must not re-queue it.
    recordError('user A secret');
    let rejectAppend: (reason?: unknown) => void = () => {};
    vi.spyOn(store, 'appendDiagnosticLogs').mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectAppend = reject;
        }),
    );
    const flushing = flush(); // drains the batch, now awaiting the append
    clear();
    rejectAppend(new Error('IDB unavailable'));
    await flushing;
    expect(getEntries()).toHaveLength(0);
    recordError('user B entry');
    await flush();
    const rows = await listDiagnosticLogs();
    expect(rows.map((r) => r.message)).toEqual(['user B entry']);
  });

  it('should_NOT_persist_or_serve_entries_recorded_before_suspension', async () => {
    recordError('user A queued');
    suspendRecording();
    expect(getEntries()).toHaveLength(0);
    await flush();
    expect(await listDiagnosticLogs()).toHaveLength(0);
  });

  it('should_NOT_resurrect_an_in_flight_batch_when_suspension_hits_and_the_append_rejects', async () => {
    recordError('user A secret');
    let rejectAppend: (reason?: unknown) => void = () => {};
    vi.spyOn(store, 'appendDiagnosticLogs').mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectAppend = reject;
        }),
    );
    const flushing = flush();
    suspendRecording();
    rejectAppend(new Error('handle closed'));
    await flushing;
    resumeRecording();
    await flush();
    expect(getEntries()).toHaveLength(0);
    expect(await listDiagnosticLogs()).toHaveLength(0);
  });

  it('should_NOT_persist_a_batch_whose_database_open_resolves_after_suspension_and_a_foreign_delete', async () => {
    // Open the cached handle, then let the browser terminate it (fires `terminated()`, clearing the cached open).
    const handle = await store.db();
    // fake-indexeddb types the argument as the IDBDatabase constructor, not an instance.
    forceCloseDatabase(unwrap(handle) as unknown as Parameters<typeof forceCloseDatabase>[0]);
    // A sibling tab holds a connection, so another tab's deleteDatabase queues behind it.
    const sibling = await new Promise<IDBDatabase>((resolve, reject) => {
      // eslint-disable-next-line no-restricted-properties -- a second connection standing in for another tab
      const req = indexedDB.open('retirement');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const deleted = new Promise<void>((resolve, reject) => {
      // eslint-disable-next-line no-restricted-properties -- another tab deleting the database
      const req = indexedDB.deleteDatabase('retirement');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    recordError('user A queued entry');
    const flushing = flush(); // drains the batch; its reopen queues behind the delete
    suspendRecording();
    sibling.close(); // delete completes, then the open resolves against the replacement database
    await deleted;
    await flushing;
    resumeRecording();
    expect(getEntries()).toHaveLength(0);
    expect(await listDiagnosticLogs()).toHaveLength(0);
  });

  it('should_drop_entries_recorded_while_suspended_and_write_nothing_on_flush', async () => {
    suspendRecording();
    recordError('captured while stale');
    await flush();
    resumeRecording();
    expect(getEntries()).toHaveLength(0);
    await flush();
    expect(await listDiagnosticLogs()).toHaveLength(0);
  });

  it('clearAll_should_still_wipe_the_store_while_suspended', async () => {
    recordError('persisted');
    await flush();
    suspendRecording();
    await clearAll();
    expect(await listDiagnosticLogs()).toHaveLength(0);
  });

  it('should_record_and_persist_again_after_resume', async () => {
    suspendRecording();
    resumeRecording();
    recordError('user B entry');
    expect(getEntries()).toHaveLength(1);
    await flush();
    expect((await listDiagnosticLogs()).map((r) => r.message)).toEqual(['user B entry']);
  });

  it('resume_should_leave_a_never_suspended_logger_unchanged', async () => {
    recordError('kept');
    resumeRecording();
    expect(getEntries().map((e) => e.message)).toEqual(['kept']);
    await flush();
    expect(await listDiagnosticLogs()).toHaveLength(1);
  });

  it('clear_should_empty_rings_and_pending_flush', () => {
    recordError('gone');
    clear();
    expect(getEntries()).toHaveLength(0);
  });

  it('clearAll_should_empty_rings_and_the_idb_store', async () => {
    recordError('wipe me');
    await flush();
    await clearAll();
    expect(getEntries()).toHaveLength(0);
    expect(await listDiagnosticLogs()).toHaveLength(0);
  });
});
