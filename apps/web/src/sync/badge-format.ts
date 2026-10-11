/**
 * Pure formatting helpers shared by the sync badge pill
 * (`SyncBadge.tsx`), the details popover (`SyncDetailsPopover.tsx`), and
 * the unsynced-items row list (`UnsyncedMutationList.tsx`).
 *
 * Lives in its own leaf module so those components don't import each
 * other: `SyncBadge` renders `SyncDetailsPopover` (via `DialogTrigger`)
 * and all three depend on these formatters, which avoids a bidirectional
 * module cycle.
 */
import type { SyncBadgeState } from './types.js';

/** Short human label describing what each badge state means. */
export function describe(state: SyncBadgeState): string {
  switch (state.kind) {
    case 'synced':
      return 'All edits are pushed.';
    case 'syncing-push':
      return 'Sending edits to the cloud.';
    case 'syncing-pull':
      return 'Fetching updates.';
    case 'offline':
      return 'No network. Edits saved locally; will sync on reconnect.';
    case 'error':
      return state.message ?? 'Last sync failed; click to retry.';
    case 'stale':
      return 'Your data was changed elsewhere. Click to refresh.';
    case 'pending':
      return `${state.count} edits queued.`;
    case 'rollback-detected':
      return (
        'The server returned an out-of-date or tampered view. Sync is blocked to protect your data. ' +
        "This device was sent data that wasn't sealed with your encryption key, so it was refused before anything was saved."
      );
    case 'update-available':
      return 'A newer app version is available. Reload to update.';
  }
}

/**
 * Relative-time string (e.g. "just now", "5m ago", "2h ago") from an
 * epoch-ms timestamp. A non-positive diff (a monotonic-clock or future
 * timestamp) reads as "just now" rather than a negative duration.
 */
export function relativeTimeFromMs(ms: number, now = Date.now()): string {
  const diffMs = now - ms;
  if (diffMs < 60_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/** Relative-time string (e.g. "just now", "5m ago", "2h ago"). */
export function relativeTime(isoString: string): string {
  return relativeTimeFromMs(new Date(isoString).getTime());
}

/**
 * Seconds remaining until `deadlineMs`, floored at 0 (never negative — a
 * deadline that already passed reads as "0s" for the instant before the
 * next tick clears it). Shared by the badge's live "Retrying in Ns"
 * countdown so both badge components
 * would compute it identically if a second one ever needed it.
 */
export function secondsUntil(deadlineMs: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((deadlineMs - now) / 1000));
}
