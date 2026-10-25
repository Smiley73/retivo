// Cross-user data-leak guard: drop IndexedDB when the `lastUserId` tracker mismatches (or is absent over a non-empty
// store) or a content audit finds a foreign-household row. Either drops; same-user re-login keeps the cache.
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
  readLastUserId(): string | null;
  storeLastUserId(userId: string): void;
  /**
   * True iff IDB holds an aggregate whose `householdId` differs from `expectedHouseholdId`. Backs the audit layer:
   * DevTools can fake the tracker, not the householdId stamped on every row.
   */
  hasForeignHouseholdData(expectedHouseholdId: string): Promise<boolean>;
  dropLocalDatabase(): Promise<void>;
  /**
   * Empties the diagnostics in-memory rings after a cross-user drop: the IDB drop wipes persisted logs but not the
   * module-level rings, so the next account would inherit the prior user's entries (a PII leak). Defaults to
   * `logger.clear`.
   */
  clearDiagnostics?: () => void;
  /**
   * Tells other same-origin tabs to close their IDB handle so a blocked delete can complete. Defaults to the `db/store`
   * BroadcastChannel nudge.
   */
  nudgeOtherTabsToReleaseIdb?: () => void;
  warn?: (...args: unknown[]) => void;
}

/**
 * Decides whether to drop the IDB working store before the new claims take effect; awaited before `householdId` reaches
 * SyncProvider. Fails closed: if a needed drop rejects (another tab holds the IDB past the blocked-delete timeout), the
 * new `lastUserId` is not stored and the error is re-thrown, so the new account never sits over the previous account's
 * stale rows.
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
      // The audit query failed, so IDB is in an unknown state: drop defensively.
      warn('[auth] Failed to audit local IndexedDB; dropping defensively:', err);
      shouldDrop = true;
    }
  }

  if (shouldDrop) {
    // Nudge other tabs to release the IDB so a blocked delete can complete; the browser keeps the delete queued, so a
    // retry succeeds once they release.
    (deps.nudgeOtherTabsToReleaseIdb ?? nudgeOtherTabsToReleaseIdb)();
    try {
      await deps.dropLocalDatabase();
    } catch (err) {
      warn('[auth] Failed to drop local IndexedDB on user transition; failing closed:', err);
      throw err;
    }
    // Empty the diagnostics rings before the next claims take effect; left intact on the fail-closed path (same user,
    // no leak).
    (deps.clearDiagnostics ?? clearDiagnosticsRings)();
  }
  deps.storeLastUserId(claims.userId);
}

/** Production deps; tests inject their own. */
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
