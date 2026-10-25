// `diagnosticLogs` store helpers: atomic append and prune in one transaction, monotonic seq, list ordering, prune backstop, clear, and survival across `clearAllStores()`.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendDiagnosticLogs,
  clearAllStores,
  clearDiagnosticLogs,
  listDiagnosticLogs,
  pruneDiagnosticLogs,
  type DiagnosticLogEntry,
} from './store';

function entry(id: string): DiagnosticLogEntry {
  return { id, seq: 0, message: id };
}

describe('diagnosticLogs store helpers', () => {
  beforeEach(async () => {
    await clearDiagnosticLogs();
  });
  afterEach(async () => {
    await clearDiagnosticLogs();
  });

  it('should_append_entries_and_allocate_monotonic_seq', async () => {
    const persisted = await appendDiagnosticLogs([entry('a'), entry('b')], 100);
    expect(persisted[0].seq).toBe(1);
    expect(persisted[1].seq).toBe(2);
    const rows = await listDiagnosticLogs();
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('should_continue_seq_across_separate_appends', async () => {
    await appendDiagnosticLogs([entry('a')], 100);
    const second = await appendDiagnosticLogs([entry('b')], 100);
    expect(second[0].seq).toBe(2);
  });

  it('should_prune_oldest_to_the_cap_in_the_same_transaction', async () => {
    await appendDiagnosticLogs([entry('a'), entry('b'), entry('c')], 100);
    await appendDiagnosticLogs([entry('d'), entry('e')], 3);
    const rows = await listDiagnosticLogs();
    expect(rows.map((r) => r.id)).toEqual(['c', 'd', 'e']);
  });

  it('pruneDiagnosticLogs_should_trim_to_cap_as_a_backstop', async () => {
    await appendDiagnosticLogs(
      [entry('a'), entry('b'), entry('c'), entry('d')],
      100,
    );
    await pruneDiagnosticLogs(2);
    const rows = await listDiagnosticLogs();
    expect(rows.map((r) => r.id)).toEqual(['c', 'd']);
  });

  it('clearDiagnosticLogs_should_empty_the_store', async () => {
    await appendDiagnosticLogs([entry('a')], 100);
    await clearDiagnosticLogs();
    expect(await listDiagnosticLogs()).toHaveLength(0);
  });

  it('should_be_preserved_across_clearAllStores', async () => {
    await appendDiagnosticLogs([entry('keep-me')], 100);
    await clearAllStores();
    const rows = await listDiagnosticLogs();
    expect(rows.map((r) => r.id)).toEqual(['keep-me']);
  });
});
