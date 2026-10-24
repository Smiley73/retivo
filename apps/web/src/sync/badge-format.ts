// Pure formatting helpers shared by SyncBadge, SyncDetailsPopover and UnsyncedMutationList.
// A leaf module so those components don't import each other (SyncBadge renders the popover): no module cycle.
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
 * "just now", "5m ago", "2h ago" from epoch ms; a non-positive diff (monotonic-clock or future timestamp) reads "just
 * now".
 */
export function relativeTimeFromMs(ms: number, now = Date.now()): string {
  const diffMs = now - ms;
  if (diffMs < 60_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/** As {@link relativeTimeFromMs}, from an ISO string. */
export function relativeTime(isoString: string): string {
  return relativeTimeFromMs(new Date(isoString).getTime());
}

/** Whole seconds until `deadlineMs`, floored at 0 so a passed deadline reads "0s" until the next tick clears it. */
export function secondsUntil(deadlineMs: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((deadlineMs - now) / 1000));
}
