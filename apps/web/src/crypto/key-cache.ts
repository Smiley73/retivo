/**
 * Device-local cache of the household data key (HDK) for the zero-knowledge
 * encryption boundary (see "Data on the device" in docs/security.md).
 *
 * Reads/writes the HDK via the `db/store.ts` helpers — it **never** opens its
 * own IndexedDB. The HDK lives in the `keyCache` store *inside* the `retirement`
 * IDB, so it rides the centralized `dropLocalDatabase()` / `clearAllLocalData()`
 * teardown (dropped exactly when the IDB is dropped — not on a bare same-user
 * logout, matching how plaintext aggregates already persist for fast re-login).
 *
 * The HDK is held as exported raw bytes (a structured-clone-safe `ArrayBuffer`)
 * and re-imported on read. The cache is a singleton; the stored `householdId`
 * is checked on read so a stale entry from a prior household is never trusted.
 */
import {
  clearKeyCacheStore,
  KEY_CACHE_ID,
  readKeyCacheEntry,
  writeKeyCacheEntry,
} from '../db/store';
import { exportHdk, importHdk } from './key-wrapping';

/**
 * Load the cached HDK for `householdId`, or null when none is cached (or the
 * cached entry belongs to a different household, or re-import fails — all of
 * which mean the caller must unlock fresh). Never throws.
 */
export async function loadCachedHdk(householdId: string): Promise<CryptoKey | null> {
  try {
    const entry = await readKeyCacheEntry();
    if (!entry || entry.householdId !== householdId) return null;
    return await importHdk(entry.hdkExported);
  } catch {
    // Corrupt bytes / unsupported import — treat as no cache so the caller
    // falls back to an explicit unlock rather than riding an unusable key.
    return null;
  }
}

/** Cache the HDK for `householdId` after a successful unlock. */
export async function cacheHdk(householdId: string, hdk: CryptoKey): Promise<void> {
  const hdkExported = await exportHdk(hdk);
  await writeKeyCacheEntry({ id: KEY_CACHE_ID, householdId, hdkExported });
}

/**
 * Drop the cached HDK. Called from the centralized local-data teardown and as a
 * belt-and-braces clear on logout/user-transition (the IDB drop already covers
 * it; this handles timing edge cases). Never throws.
 */
export async function clearCachedHdk(): Promise<void> {
  try {
    await clearKeyCacheStore();
  } catch {
    // Best-effort: the IDB drop is the authoritative teardown.
  }
}
