/**
 * The explicit "nuke all local data" routine. Wipes EVERY client-side
 * storage surface this app touches, in one call. Used by the Workspace
 * "Clear data on this device" button (full wipe) and by the account-
 * deletion path (with selective carve-outs).
 *
 * Authoritative list of client-side storage surfaces (the safeguard in
 * eslint.config.js keeps this complete as new MECHANISMS are added):
 *   1. localStorage     — auth (deviceId/email/lastUserId/lastActivityAt),
 *                         theme, scenario workflow locks, page-local UI
 *                         prefs (balance-projection, optimizer). Blanket
 *                         `clear()` covers every key regardless of prefix.
 *   2. sessionStorage   — signoutReason, deletedNotice, versionBanner
 *                         dismissed build id. Blanket `clear()`.
 *   3. IndexedDB        — the single `retirement` DB, dropped via
 *                         `dropLocalDatabase()`. This ALREADY covers the
 *                         Monte Carlo cache, `selectedScenario`,
 *                         `deviceMetadata`, and the `diagnosticLogs` store —
 *                         they all live INSIDE that one DB, so there is no
 *                         separate clear to make here (a reviewer might
 *                         otherwise flag one). The diagnostics logger ALSO
 *                         keeps in-memory ring buffers OUTSIDE IDB; dropping
 *                         the DB does not empty them, so `logger.clear()` is
 *                         called below so the full nuke can't re-persist the
 *                         prior session's captured entries.
 *   4. Cache Storage    — best-effort, defensive: nothing uses it
 *                         today, but a future service worker could.
 *
 * NOT cleared here: `document.cookie`. The only cookie the client reads
 * is `csrf-token` (in AuthAwareProviders); the auth cookies are HTTP-only
 * and server-managed, not clearable from JS. This is a deliberate omission,
 * not a gap — the device-clear caller below
 * only reaches this wipe once it has PROVEN the server session is gone
 * (`AuthContext.signOutForDeviceClear`, which is what revokes the cookies
 * server-side, not this module); every other caller of this module is
 * unaffected by that rule and revokes/skips revocation on its own terms.
 *
 * This is distinct from the cross-user guard's SELECTIVE
 * `dropLocalDatabase()` (which deliberately preserves deviceId/email and
 * updates the tracker on a user switch). The two paths must not be merged.
 */
import { dropLocalDatabase } from '../db/store';
import { clear as clearDiagnosticsRings } from './diagnostics/logger';

/**
 * Options for selective preservation across the nuke. Both default to
 * empty (full wipe). `preserveSessionKeys` keeps the account-deletion
 * toast alive across the `sessionStorage.clear()`; `preserveLocalKeys`
 * keeps the deviceId on the account-deletion path — deletion does
 * not reload, so wiping the persisted deviceId while a stale in-memory
 * copy survives would let a same-tab re-login trip `DEVICE_MISMATCH`.
 * The clear-data button passes neither (full wipe, deviceId included —
 * safe because it hard-reloads, regenerating a fresh deviceId).
 */
export interface ClearAllLocalDataOptions {
  preserveLocalKeys?: readonly string[];
  preserveSessionKeys?: readonly string[];
}

/**
 * Snapshot the named keys, blanket-clear the store, then restore only the
 * keys whose value was non-null at snapshot time (a preserved-but-absent
 * key stays absent).
 */
function clearStoragePreserving(
  store: Storage,
  preserveKeys: readonly string[],
): void {
  const saved = new Map<string, string>();
  for (const key of preserveKeys) {
    const value = store.getItem(key);
    if (value !== null) saved.set(key, value);
  }
  store.clear();
  for (const [key, value] of saved) {
    store.setItem(key, value);
  }
}

/**
 * Wipe every client-side storage surface. Awaitable — callers run their own
 * sign-out first, then await this before reloading/navigating; this function
 * itself does not sign anyone out. The Workspace "Clear data on this device"
 * button (`WorkspaceToolsCard.onClearLocalConfirm`) proceeds to this call
 * ONLY after `AuthContext.signOutForDeviceClear` has proven the server
 * session is gone — an ambiguous or failed
 * sign-out attempt never reaches here. The account-deletion path is
 * unchanged: it runs after the server has already deleted the account. The
 * Cache Storage clear is best-effort: a rejection there must never
 * abort the real wipe (localStorage/sessionStorage/IDB) or the caller's
 * reload.
 */
export async function clearAllLocalData(
  opts: ClearAllLocalDataOptions = {},
): Promise<void> {
  clearStoragePreserving(localStorage, opts.preserveLocalKeys ?? []);
  clearStoragePreserving(sessionStorage, opts.preserveSessionKeys ?? []);
  // Empty the diagnostics in-memory rings + cancel any pending flush BEFORE
  // the DB drop: dropping the IDB wipes the persisted `diagnosticLogs`
  // store but NOT the module-level rings, which would otherwise re-persist the
  // prior session's captured entries after the nuke. Pure in-memory op, no
  // storage import — the `idb`/`indexedDB` ban exemption here is unaffected.
  clearDiagnosticsRings();
  await dropLocalDatabase();
  if ('caches' in globalThis) {
    try {
      for (const key of await globalThis.caches.keys()) {
        await globalThis.caches.delete(key);
      }
    } catch {
      /* best-effort — Cache Storage is defensive; never block the nuke */
    }
  }
}
