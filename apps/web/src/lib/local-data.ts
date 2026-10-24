// The "clear data on this device" wipe and the account-deletion wipe. Adding a
// storage mechanism means extending `clearAllLocalData`.

import { dropLocalDatabase } from '../db/store';
import { clear as clearDiagnosticsRings } from './diagnostics/logger';

/**
 * `preserveSessionKeys` keeps the account-deletion toast across the
 * `sessionStorage.clear()`. `preserveLocalKeys` keeps the deviceId there: that
 * path does not reload, so a stale in-memory deviceId against a wiped stored
 * one would trip `DEVICE_MISMATCH` on re-login. The clear-data button passes
 * neither and hard-reloads, which regenerates the deviceId.
 */
export interface ClearAllLocalDataOptions {
  preserveLocalKeys?: readonly string[];
  preserveSessionKeys?: readonly string[];
}

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
 * Wipes every client-side storage surface; does not sign anyone out. The
 * device-clear caller reaches it only after `AuthContext.signOutForDeviceClear`
 * has proven the server session is gone.
 *
 * Surfaces covered:
 * 1. `localStorage` and `sessionStorage`, cleared wholesale whatever the key,
 *    minus the `preserve*` keys.
 * 2. The single `retirement` IndexedDB database, which already holds the Monte
 *    Carlo cache, `selectedScenario`, `deviceMetadata` and `diagnosticLogs`.
 * 3. The diagnostics logger's in-memory ring buffers, which live outside
 *    IndexedDB and survive the drop.
 * 4. Cache Storage, best-effort: a rejection never aborts the wipe or the reload.
 *
 * Cookies are not touched: the auth cookies are HTTP-only and server-managed,
 * so JS cannot clear them.
 */
export async function clearAllLocalData(
  opts: ClearAllLocalDataOptions = {},
): Promise<void> {
  clearStoragePreserving(localStorage, opts.preserveLocalKeys ?? []);
  clearStoragePreserving(sessionStorage, opts.preserveSessionKeys ?? []);
  // Before the DB drop, so the rings cannot re-persist the prior session's entries.
  clearDiagnosticsRings();
  await dropLocalDatabase();
  if ('caches' in globalThis) {
    try {
      for (const key of await globalThis.caches.keys()) {
        await globalThis.caches.delete(key);
      }
    } catch {
      // Best-effort: never block the wipe.
    }
  }
}
