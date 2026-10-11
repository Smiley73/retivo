/**
 * Cross-user data-leak guard. Two layers, both required:
 *
 * 1. **localStorage tracker.** Persist the most-recent JWT userId in
 *    `retivo.auth.lastUserId`. On the next login, mismatch → drop
 *    IndexedDB. Covers the common "logout → login as someone else"
 *    transition, including the case where the tracker is absent
 *    (fresh install on top of a device that already has stale IDB
 *    from before this fix shipped — `previous == null` while the
 *    store is non-empty must still drop).
 *
 * 2. **IndexedDB content audit.** Independently scan the working store
 *    for aggregates whose `householdId` differs from the JWT claim. An
 *    attacker with DevTools can wipe or fake the localStorage tracker
 *    to skip layer 1; they cannot fake the householdId stamped on
 *    every row written during the previous user's session, because
 *    those rows came from server-bootstrap snapshots tied to a
 *    specific household. If any foreign-household row exists, drop.
 *
 * Either layer firing triggers the drop. Same-user re-login passes
 * both checks and the local cache is preserved.
 *
 * **Fail-closed drop.** When a drop is
 * required but `dropLocalDatabase` rejects (another tab holds the IDB open
 * past the blocked-delete timeout), we do NOT store the new `lastUserId` and
 * we re-throw: the caller must not expose the new account's claims/household
 * over the previous account's stale rows. Before dropping we post a
 * same-origin nudge so other tabs close their IDB handle and a retry can
 * succeed once they release.
 *
 * Extracted from AuthContext so the logic can be unit-tested directly
 * without spinning up the full provider tree.
 */
import {
  dropLocalDatabase,
  hasForeignHouseholdData,
  nudgeOtherTabsToReleaseIdb,
} from '../db/store';
import { clear as clearDiagnosticsRings } from '../lib/diagnostics/logger';

const LAST_USER_STORAGE_KEY = 'retivo.auth.lastUserId';

interface JwtClaimsLike {
  userId: string;
  householdId: string;
}

export interface MaybeResetForNewUserDeps {
  /** Returns the tracker value, or null when absent / unsupported. */
  readLastUserId(): string | null;
  storeLastUserId(userId: string): void;
  /**
   * Resolves to `true` iff IndexedDB contains at least one aggregate
   * whose `householdId` differs from `expectedHouseholdId`.
   */
  hasForeignHouseholdData(expectedHouseholdId: string): Promise<boolean>;
  dropLocalDatabase(): Promise<void>;
  /**
   * Empty the diagnostics in-memory rings (+ cancel any pending flush) after a
   * successful cross-user drop. Dropping the IDB wipes the persisted
   * `diagnosticLogs` store but NOT the module-level rings, so the next account
   * would otherwise inherit the prior user's captured entries — a cross-user
   * PII leak. Defaults to `logger.clear`.
   */
  clearDiagnostics?: () => void;
  /**
   * Notify other same-origin tabs to close their IDB handle so a blocked
   * `deleteDatabase` can complete. Posted before the drop attempt. Defaults
   * to the BroadcastChannel nudge in `db/store`.
   */
  nudgeOtherTabsToReleaseIdb?: () => void;
  /** For warning messages; defaults to `console.warn`. */
  warn?: (...args: unknown[]) => void;
}

/**
 * Decide whether to drop the IDB working store before the new claims
 * take effect. Exported so the consumer (AuthContext) can await it
 * before propagating `householdId` to SyncProvider.
 */
export async function maybeResetForNewUser(
  claims: JwtClaimsLike | null,
  deps: MaybeResetForNewUserDeps,
): Promise<void> {
  if (!claims) return;
  const warn = deps.warn ?? console.warn.bind(console);

  let shouldDrop = deps.readLastUserId() !== claims.userId;
  if (!shouldDrop) {
    try {
      shouldDrop = await deps.hasForeignHouseholdData(claims.householdId);
    } catch (err) {
      // The audit query itself failed — IDB is in a weird state.
      // Drop defensively so the new user starts clean rather than
      // ride into an unknown working store.
      warn('[auth] Failed to audit local IndexedDB; dropping defensively:', err);
      shouldDrop = true;
    }
  }

  if (shouldDrop) {
    // Nudge other same-origin tabs to release their IDB handle so a blocked
    // delete can complete, then attempt the drop. On failure we fail closed:
    // re-throw WITHOUT storing the new lastUserId, so the caller does not
    // expose the new account over the previous account's stale rows. The
    // browser keeps the delete queued; a retry (after the
    // other tabs release) succeeds.
    (deps.nudgeOtherTabsToReleaseIdb ?? nudgeOtherTabsToReleaseIdb)();
    try {
      await deps.dropLocalDatabase();
    } catch (err) {
      warn('[auth] Failed to drop local IndexedDB on user transition; failing closed:', err);
      throw err;
    }
    // Drop succeeded → empty the diagnostics in-memory rings before the next
    // account's claims take effect, so it can't inherit the prior user's
    // captured entries. On the fail-closed re-throw path above the rings are
    // deliberately left intact (same user, no leak).
    (deps.clearDiagnostics ?? clearDiagnosticsRings)();
  }
  deps.storeLastUserId(claims.userId);
}

/**
 * Production binding. AuthContext uses this; tests inject their own
 * deps via the lower-level `maybeResetForNewUser`.
 */
export const productionDeps: MaybeResetForNewUserDeps = {
  readLastUserId(): string | null {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(LAST_USER_STORAGE_KEY);
  },
  storeLastUserId(userId: string): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LAST_USER_STORAGE_KEY, userId);
  },
  hasForeignHouseholdData,
  dropLocalDatabase,
  clearDiagnostics: clearDiagnosticsRings,
  nudgeOtherTabsToReleaseIdb,
};

/** Wipe the tracker. Used by account-deletion. */
export function clearLastUserId(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(LAST_USER_STORAGE_KEY);
}
