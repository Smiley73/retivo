// The "clear data on this device" and account-deletion wipe; a new storage mechanism must extend `clearAllLocalData`.

import { dropLocalDatabase } from '../db/store';
import { clear as clearDiagnosticsRings } from './diagnostics/logger';

/** `preserveSessionKeys` keeps the account-deletion toast; `preserveLocalKeys` keeps the deviceId on that no-reload path, where a stale in-memory id against a wiped stored one would trip `DEVICE_MISMATCH` on re-login. */
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
 * Wipes every client-side storage surface without signing anyone out: `localStorage` and `sessionStorage` (minus the `preserve*` keys),
 * the `retirement` IndexedDB database, the diagnostics logger's in-memory ring buffers (outside IndexedDB, so the drop leaves them)
 * and Cache Storage (best-effort: a rejection never aborts the wipe). Cookies are untouched: the auth cookies are HTTP-only and
 * server-managed, so JS cannot clear them.
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
      // Best-effort.
    }
  }
}
