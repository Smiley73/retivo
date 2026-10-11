/**
 * Unit tests for the cross-user IDB-leak guard. Exercises every
 * decision in `maybeResetForNewUser` with stubbed deps so the logic is
 * verified independently of IndexedDB + localStorage globals.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeResetForNewUser, productionDeps } from './user-transition';
import {
  clearDiagnosticLogs,
  dropLocalDatabase,
  hasForeignHouseholdData,
  listDiagnosticLogs,
} from './../db/store';
import {
  clear as clearDiagnosticsRings,
  flush as flushDiagnostics,
  getEntries as getDiagnosticsEntries,
  recordError as recordDiagnosticsError,
} from '../lib/diagnostics/logger';
import { buildDiagnosticsEnvelope } from '../lib/diagnostics/export';

interface StubState {
  storedUserId: string | null;
  hasForeign: boolean | (() => Promise<boolean>);
  dropFails?: boolean;
  dropCalls: number;
  nudgeCalls: number;
  clearDiagnosticsCalls: number;
  storeCalls: string[];
  warnings: unknown[][];
}

function makeDeps(state: StubState) {
  return {
    readLastUserId: () => state.storedUserId,
    storeLastUserId: (userId: string) => {
      state.storedUserId = userId;
      state.storeCalls.push(userId);
    },
    hasForeignHouseholdData: async (): Promise<boolean> => {
      const v = state.hasForeign;
      return typeof v === 'function' ? await v() : v;
    },
    dropLocalDatabase: async (): Promise<void> => {
      state.dropCalls += 1;
      if (state.dropFails) throw new Error('drop failed');
    },
    clearDiagnostics: () => {
      state.clearDiagnosticsCalls += 1;
    },
    nudgeOtherTabsToReleaseIdb: () => {
      state.nudgeCalls += 1;
    },
    warn: (...args: unknown[]) => {
      state.warnings.push(args);
    },
  };
}

function freshState(overrides: Partial<StubState> = {}): StubState {
  return {
    storedUserId: null,
    hasForeign: false,
    dropFails: false,
    dropCalls: 0,
    nudgeCalls: 0,
    clearDiagnosticsCalls: 0,
    storeCalls: [],
    warnings: [],
    ...overrides,
  };
}

const CLAIMS_A = { userId: 'user-A', householdId: 'hh-A' };
const CLAIMS_B = { userId: 'user-B', householdId: 'hh-B' };

describe('maybeResetForNewUser', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('does nothing when claims is null (malformed JWT)', async () => {
    const state = freshState({ storedUserId: 'user-A' });
    await maybeResetForNewUser(null, makeDeps(state));
    expect(state.dropCalls).toBe(0);
    expect(state.storeCalls).toEqual([]);
    expect(state.storedUserId).toBe('user-A');
  });

  it('drops + records userId on the first-ever login (no tracker, empty IDB)', async () => {
    // Rationale: `previous` (null) does not equal `claims.userId`, so
    // layer 1 fires. The drop on an empty IDB is a no-op cost.
    const state = freshState({ storedUserId: null, hasForeign: false });
    await maybeResetForNewUser(CLAIMS_A, makeDeps(state));
    expect(state.dropCalls).toBe(1);
    expect(state.storedUserId).toBe('user-A');
  });

  it('drops on the upgrade case (no tracker, IDB still holds prior household)', async () => {
    // Pre-fix devices have stale IDB from before this code shipped;
    // localStorage tracker is absent. Layer 1 catches it because
    // `null !== userId`.
    const state = freshState({ storedUserId: null, hasForeign: true });
    await maybeResetForNewUser(CLAIMS_B, makeDeps(state));
    expect(state.dropCalls).toBe(1);
    expect(state.storedUserId).toBe('user-B');
  });

  it('drops on a true user transition (tracker mismatch)', async () => {
    const state = freshState({ storedUserId: 'user-A', hasForeign: true });
    await maybeResetForNewUser(CLAIMS_B, makeDeps(state));
    expect(state.dropCalls).toBe(1);
    expect(state.storedUserId).toBe('user-B');
  });

  it('does NOT drop on same-user re-login (cache stays warm)', async () => {
    const state = freshState({ storedUserId: 'user-A', hasForeign: false });
    await maybeResetForNewUser(CLAIMS_A, makeDeps(state));
    expect(state.dropCalls).toBe(0);
    expect(state.storedUserId).toBe('user-A');
  });

  it('drops despite a matching tracker when IDB still holds foreign household data (DevTools tampering)', async () => {
    // Attack: attacker wipes/fakes the tracker to match their userId.
    // Layer 2's IDB audit catches the leak because aggregate rows
    // still carry the prior user's householdId.
    const state = freshState({ storedUserId: 'user-A', hasForeign: true });
    await maybeResetForNewUser(CLAIMS_A, makeDeps(state));
    expect(state.dropCalls).toBe(1);
    expect(state.storedUserId).toBe('user-A');
  });

  it('drops defensively when the IDB audit itself throws', async () => {
    const auditError = new Error('IDB corrupt');
    const state = freshState({
      storedUserId: 'user-A',
      hasForeign: () => Promise.reject(auditError),
    });
    await maybeResetForNewUser(CLAIMS_A, makeDeps(state));
    expect(state.dropCalls).toBe(1);
    expect(state.warnings).toHaveLength(1);
    expect(state.warnings[0][0]).toContain('Failed to audit');
  });

  it('fails closed on a drop failure: re-throws and does NOT record the new userId', async () => {
    // A blocked/failed drop must not let the new account ride over the
    // previous account's stale rows. The guard re-throws and leaves the
    // tracker unchanged so the caller does not expose the new household and
    // a retry (after other tabs release the IDB) re-runs the drop.
    const state = freshState({
      storedUserId: 'user-A',
      hasForeign: false,
      dropFails: true,
    });
    await expect(maybeResetForNewUser(CLAIMS_B, makeDeps(state))).rejects.toThrow(
      'drop failed',
    );
    expect(state.dropCalls).toBe(1);
    expect(state.storedUserId).toBe('user-A');
    expect(state.nudgeCalls).toBe(1);
    expect(state.warnings).toHaveLength(1);
    expect(state.warnings[0][0]).toContain('Failed to drop');
  });

  it('nudges other tabs before dropping, then records the new userId on success', async () => {
    const state = freshState({ storedUserId: 'user-A', hasForeign: true });
    await maybeResetForNewUser(CLAIMS_B, makeDeps(state));
    expect(state.nudgeCalls).toBe(1);
    expect(state.dropCalls).toBe(1);
    expect(state.storedUserId).toBe('user-B');
  });

  it('clears the diagnostics rings after a successful cross-user drop', async () => {
    // A different user must never inherit the prior user's in-memory
    // diagnostics rings — the drop wipes the persisted store but not the
    // module-level rings, so the guard clears them after a successful drop.
    const state = freshState({ storedUserId: 'user-A', hasForeign: true });
    await maybeResetForNewUser(CLAIMS_B, makeDeps(state));
    expect(state.dropCalls).toBe(1);
    expect(state.clearDiagnosticsCalls).toBe(1);
    expect(state.storedUserId).toBe('user-B');
  });

  it('does NOT clear the diagnostics rings on the fail-closed re-throw path (same user, no leak)', async () => {
    const state = freshState({
      storedUserId: 'user-A',
      hasForeign: false,
      dropFails: true,
    });
    await expect(maybeResetForNewUser(CLAIMS_B, makeDeps(state))).rejects.toThrow(
      'drop failed',
    );
    expect(state.clearDiagnosticsCalls).toBe(0);
  });

  it('does NOT clear the diagnostics rings on same-user re-login (no drop)', async () => {
    const state = freshState({ storedUserId: 'user-A', hasForeign: false });
    await maybeResetForNewUser(CLAIMS_A, makeDeps(state));
    expect(state.clearDiagnosticsCalls).toBe(0);
  });

  it('does not nudge when no drop is required (same-user re-login)', async () => {
    const state = freshState({ storedUserId: 'user-A', hasForeign: false });
    await maybeResetForNewUser(CLAIMS_A, makeDeps(state));
    expect(state.nudgeCalls).toBe(0);
    expect(state.dropCalls).toBe(0);
  });

  it('skips the audit query when the tracker already mismatches (perf: short-circuit)', async () => {
    const auditSpy = vi.fn().mockResolvedValue(false);
    const state = freshState({ storedUserId: 'user-A' });
    const deps = makeDeps(state);
    deps.hasForeignHouseholdData = auditSpy;
    await maybeResetForNewUser(CLAIMS_B, deps);
    expect(auditSpy).not.toHaveBeenCalled();
    expect(state.dropCalls).toBe(1);
  });

  it('records the new userId on legitimate first login (no drop) — covers null→A→A flow', async () => {
    // First call: null tracker → drops, records A.
    const state = freshState({ storedUserId: null, hasForeign: false });
    await maybeResetForNewUser(CLAIMS_A, makeDeps(state));
    expect(state.storedUserId).toBe('user-A');

    // Second call as same user: tracker matches, audit clean → no drop.
    state.dropCalls = 0;
    await maybeResetForNewUser(CLAIMS_A, makeDeps(state));
    expect(state.dropCalls).toBe(0);
  });

  it('integration: a real cross-user drop empties the rings, the IDB store, and the next-user export', async () => {
    // End-to-end leak closure: record + flush real entries as user A, run the
    // transition with the REAL logger.clear wired + REAL fake-indexeddb drop,
    // then assert user B inherits nothing — empty rings, empty persisted store,
    // empty export envelope.
    clearDiagnosticsRings();
    await clearDiagnosticLogs();
    recordDiagnosticsError('user A captured secret');
    await flushDiagnostics();
    expect(getDiagnosticsEntries()).toHaveLength(1);
    expect(await listDiagnosticLogs()).toHaveLength(1);

    const deps = {
      readLastUserId: (): string | null => 'user-A',
      storeLastUserId: (): void => {},
      hasForeignHouseholdData,
      dropLocalDatabase,
      // Real binding under test — not a spy.
      clearDiagnostics: clearDiagnosticsRings,
      nudgeOtherTabsToReleaseIdb: (): void => {},
      warn: (): void => {},
    };
    await maybeResetForNewUser(CLAIMS_B, deps);

    // User B: rings emptied, persisted store dropped, export carries nothing.
    expect(getDiagnosticsEntries()).toHaveLength(0);
    expect(await listDiagnosticLogs()).toHaveLength(0);
    const envelope = await buildDiagnosticsEnvelope('hh-B');
    expect(envelope.entries).toHaveLength(0);
  });

  it('production guard wires the real dropLocalDatabase, not the clear-data nuke (non-regression)', () => {
    // The cross-user transition guard keeps dropLocalDatabase()'s
    // selective IDB-only wipe (preserves deviceId/email) and must never be
    // swapped for the explicit clear-data clearAllLocalData() full nuke —
    // lock the binding so a future edit can't silently change it.
    expect(productionDeps.dropLocalDatabase).toBe(dropLocalDatabase);
  });
});
