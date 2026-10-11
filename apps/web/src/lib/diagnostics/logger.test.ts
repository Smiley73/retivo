/**
 * Diagnostics logger tests. Ring cap/eviction (at-cap + below-cap), namespace
 * parse, must-not-throw, flush → IDB persistence, clear/clearAll. Uses
 * `fake-indexeddb/auto` so the real `db/store.ts` append+prune path runs.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clear,
  clearAll,
  flush,
  getEntries,
  parseNamespace,
  recordBreadcrumb,
  recordError,
  recordSyncWarn,
  recordWarn,
} from './logger';
import {
  clearDiagnosticLogs,
  listDiagnosticLogs,
} from '../../db/store';
import * as store from '../../db/store';

describe('parseNamespace', () => {
  it('should_extract_a_bracketed_namespace_from_the_first_string_arg', () => {
    expect(parseNamespace('[sync] pull failed')).toEqual({
      namespace: 'sync',
      rest: 'pull failed',
    });
  });

  it('should_return_no_namespace_when_the_first_arg_has_no_prefix', () => {
    expect(parseNamespace('plain message')).toEqual({ rest: 'plain message' });
  });

  it('should_return_no_namespace_when_the_first_arg_is_not_a_string', () => {
    const obj = { code: 'X' };
    expect(parseNamespace(obj)).toEqual({ rest: obj });
  });
});

describe('diagnostics logger', () => {
  beforeEach(async () => {
    clear();
    await clearDiagnosticLogs();
  });
  afterEach(() => {
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
    // Oldest 10 evicted → first surviving is e10.
    expect(errors[0].message).toBe('e10');
  });

  it('should_not_let_breadcrumbs_evict_error_history', () => {
    recordError('important error');
    for (let i = 0; i < 500; i += 1) recordBreadcrumb('log', `b${i}`);
    const errors = getEntries().filter((e) => e.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('important error');
    // Breadcrumb ring capped at 200.
    const crumbs = getEntries().filter((e) => e.level === 'log');
    expect(crumbs).toHaveLength(200);
  });

  it('should_parse_a_namespace_into_the_entry', () => {
    recordWarn('[sync] something happened');
    const [entry] = getEntries();
    expect(entry.namespace).toBe('sync');
    expect(entry.message).toBe('something happened');
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
    // The entry is still recorded (message captured; detail collapses safely).
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
    // IDB unavailable (private mode) — appendDiagnosticLogs rejects. flush()
    // must not throw, must keep the ring authoritative, and must re-queue the
    // drained batch so a later successful flush persists it.
    recordError('survives idb failure');
    const spy = vi
      .spyOn(store, 'appendDiagnosticLogs')
      .mockRejectedValueOnce(new Error('IDB unavailable'))
      .mockRejectedValueOnce(
        new DOMException('quota exceeded', 'QuotaExceededError'),
      );
    await expect(flush()).resolves.toBeUndefined();
    expect(getEntries().some((e) => e.message === 'survives idb failure')).toBe(true);
    // Nothing persisted on the failed attempt; the batch is re-queued.
    expect(await listDiagnosticLogs()).toHaveLength(0);
    // Second flush also rejects (quota) — still no throw, still re-queued.
    await expect(flush()).resolves.toBeUndefined();
    expect(await listDiagnosticLogs()).toHaveLength(0);
    // Restore the real append — the re-queued batch now persists.
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
    // A differing record starts a fresh entry (count resets).
    recordError('a different line');
    const after = getEntries();
    expect(after).toHaveLength(2);
    expect(after[1].message).toBe('a different line');
    expect(after[1].count ?? 1).toBe(1);
  });

  it('should_NOT_coalesce_two_different_Error_messages', () => {
    // JSON.stringify(new Error(...)) is '{}' for both, so a naive key would
    // over-coalesce and drop the second message. The Error-aware key keeps them
    // distinct.
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
    // `['ab','c']` and `['a','bc']` join to the same string under an empty-
    // string delimiter; the unit-separator delimiter keeps them distinct.
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
    // > MAX_FLUSH_BATCH (200) distinct entries so none coalesce.
    for (let i = 0; i < 250; i += 1) recordError(`batch-${i}`);
    // One flush drains at most 200 to IDB and re-schedules the remainder.
    await flush();
    let rows = await listDiagnosticLogs();
    expect(rows).toHaveLength(200);
    expect(rows[0].message).toBe('batch-0');
    expect(rows[199].message).toBe('batch-199');
    // A second flush drains the re-queued remainder (the reschedule's timer
    // would do the same; calling flush directly avoids fake-timer/IDB interop).
    await flush();
    rows = await listDiagnosticLogs();
    expect(rows).toHaveLength(250);
    expect(rows[249].message).toBe('batch-249');
  });

  it('should_NOT_resurrect_a_drained_batch_when_clear_interleaves_a_failing_flush', async () => {
    // Cross-user leak race: a flush drains user A's batch, then clear()
    // runs (cross-user dropLocalDatabase wipe) BEFORE appendDiagnosticLogs
    // rejects. The catch path must NOT re-queue the prior user's batch.
    recordError('user A secret');
    let rejectAppend: (reason?: unknown) => void = () => {};
    vi.spyOn(store, 'appendDiagnosticLogs').mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectAppend = reject;
        }),
    );
    const flushing = flush(); // drains the batch, now awaiting the append
    // User A logs out → cross-user wipe empties the rings + queue.
    clear();
    // The in-flight append now fails.
    rejectAppend(new Error('IDB unavailable'));
    await flushing;
    // The drained batch must NOT have been resurrected into the cleared queue.
    expect(getEntries()).toHaveLength(0);
    // A subsequent new-user record + flush persists ONLY the new entry.
    recordError('user B entry');
    await flush();
    const rows = await listDiagnosticLogs();
    expect(rows.map((r) => r.message)).toEqual(['user B entry']);
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
