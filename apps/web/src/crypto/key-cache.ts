// Device-local HDK cache, kept in the `keyCache` store of the `retirement` IDB via `db/store.ts` (never its own database),
// so the local-data teardown drops it with the IDB, not on a bare logout; see docs/security.md "Data on the device".
import {
  clearKeyCacheStore,
  KEY_CACHE_ID,
  readKeyCacheEntry,
  writeKeyCacheEntry,
} from '../db/store';
import { exportHdk, importHdk } from './key-wrapping';

/** Cached HDK for `householdId`, or null when none, another household's, or unimportable. Never throws. */
export async function loadCachedHdk(householdId: string): Promise<CryptoKey | null> {
  try {
    const entry = await readKeyCacheEntry();
    if (!entry || entry.householdId !== householdId) return null;
    return await importHdk(entry.hdkExported);
  } catch {
    // Corrupt or unsupported bytes: fall back to an explicit unlock.
    return null;
  }
}

/** Cache the HDK for `householdId` after a successful unlock. */
export async function cacheHdk(householdId: string, hdk: CryptoKey): Promise<void> {
  const hdkExported = await exportHdk(hdk);
  await writeKeyCacheEntry({ id: KEY_CACHE_ID, householdId, hdkExported });
}

/** Drops the cached HDK; also a belt-and-braces clear on logout and user transition. Never throws. */
export async function clearCachedHdk(): Promise<void> {
  try {
    await clearKeyCacheStore();
  } catch {
    // Best-effort: the IDB drop is the authoritative teardown.
  }
}
