/** Path-count selection persistence for the MC tab: the retivo.optimizer.pathCount key, the valid set (1k / 5k / 10k) and the read/write helpers. */

/** Page-local UI pref under the `retivo.*` namespace so the clear-data nuke and storage audit cover it. */
export const PATH_COUNT_STORAGE_KEY = 'retivo.optimizer.pathCount';

const VALID_PATH_COUNTS: ReadonlySet<number> = new Set([1000, 5000, 10000]);

/** Guards both localStorage reads and the onPathCountChange handler against off-menu values. */
export function isValidPathCount(n: number): boolean {
  return VALID_PATH_COUNTS.has(n);
}

/** Falls back to `fallback` (the runner's default 1k) when the value is missing, invalid or localStorage is unavailable. */
export function readPathCountFromStorage(fallback: number): number {
  try {
    const v = Number(window.localStorage.getItem(PATH_COUNT_STORAGE_KEY));
    if (isValidPathCount(v)) return v;
  } catch {
    /* localStorage unavailable. */
  }
  return fallback;
}

/** Silently no-ops without localStorage (private browsing, quota); the in-memory state still carries the selection for the session. */
export function writePathCountToStorage(n: number): void {
  try {
    window.localStorage.setItem(PATH_COUNT_STORAGE_KEY, String(n));
  } catch {
    /* localStorage unavailable. */
  }
}
