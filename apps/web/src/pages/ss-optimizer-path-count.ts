/**
 * Path-count selection persistence + validation for the MC tab. Owns
 * the `retivo.optimizer.pathCount` localStorage key, the valid-value set
 * (1k / 5k / 10k), and the read/write helpers the page wires to its
 * SegmentedRadioGroup. Kept in a small sibling so neither the page
 * nor the larger helpers module accrues the ceremony.
 */

/** Persisted MC path-count selection. Page-local UI pref under the
 *  `retivo.*` namespace (all client-side keys are now prefixed so the
 *  clear-data nuke + storage audit cover them uniformly). */
export const PATH_COUNT_STORAGE_KEY = 'retivo.optimizer.pathCount';

const VALID_PATH_COUNTS: ReadonlySet<number> = new Set([1000, 5000, 10000]);

/** True when `n` is one of the values the MC toolbar selector exposes
 *  (1k / 5k / 10k). Guards both `localStorage` reads and the
 *  `onPathCountChange` handler against off-menu values. */
export function isValidPathCount(n: number): boolean {
  return VALID_PATH_COUNTS.has(n);
}

/** Read the persisted path count, falling back to `fallback` (the
 *  runner's default 1k) when the value is missing / invalid /
 *  localStorage is unavailable. */
export function readPathCountFromStorage(fallback: number): number {
  try {
    const v = Number(window.localStorage.getItem(PATH_COUNT_STORAGE_KEY));
    if (isValidPathCount(v)) return v;
  } catch {
    /* localStorage unavailable. */
  }
  return fallback;
}

/** Persist the selected path count. Silently no-ops when localStorage
 *  is unavailable (private browsing / quota exceeded); the page's
 *  in-memory `pathCount` state still carries the selection for the
 *  current session. */
export function writePathCountToStorage(n: number): void {
  try {
    window.localStorage.setItem(PATH_COUNT_STORAGE_KEY, String(n));
  } catch {
    /* localStorage unavailable. */
  }
}
