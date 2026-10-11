/**
 * Persistent header badge surfacing the cloud-sync state.
 *
 * Tailwind-defaults styled. Per-state color is an AA-safe
 * Tailwind-default pair (contrast.ts); the spin on the in-flight
 * states uses Tailwind `animate-spin` and respects
 * `prefers-reduced-motion` via `motion-reduce:animate-none`. The badge pill is a React Aria `DialogTrigger` that opens
 * the unified details popover in every state (`SyncDetailsPopover.tsx`,
 * React Aria `Popover`).
 */
import React, { useEffect, useState } from 'react';
import { Button, DialogTrigger } from 'react-aria-components';
import { useSync } from './SyncContext.js';
import { SyncDetailsPopover } from './SyncDetailsPopover.js';
import { describe, relativeTime, secondsUntil } from './badge-format.js';

type SyncKind = ReturnType<typeof useSync>['state']['kind'];

const BADGE_BASE =
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 ' +
  'text-xs font-medium transition-colors';

// Per-state tone (legacy `.sync-badge--*`). Every state is now an
// interactive trigger that opens the details popover, so all get the
// `cursor-pointer` affordance.
const BADGE_TONE: Record<SyncKind, string> = {
  synced: 'cursor-pointer border-positive/40 bg-surface-sunken text-positive',
  'syncing-push': 'cursor-pointer border-info/40 bg-surface-sunken text-info',
  'syncing-pull': 'cursor-pointer border-info/40 bg-surface-sunken text-info',
  offline: 'cursor-pointer border-line bg-surface-sunken text-muted',
  error:
    'cursor-pointer border-negative/40 bg-surface-sunken text-negative hover:border-negative',
  stale:
    'cursor-pointer border-warning/40 bg-surface-sunken text-warning hover:border-warning',
  pending: 'cursor-pointer border-info/40 bg-surface-sunken text-info',
  // Rollback detected: a security-relevant rejection of a
  // stale/tampered server view. Reuses the negative palette (already
  // AA-registered in contrast.ts). The badge still opens the details
  // popover (showing the security explanation), but there is no
  // client-side action that fixes a rollback.
  'rollback-detected':
    'cursor-pointer border-negative/40 bg-surface-sunken text-negative',
  // Deploy-time schema-ahead: a calm "update
  // needed" state, not a sync error — reuses the same `info` tone as
  // the in-flight states (already AA-registered in contrast.ts).
  'update-available': 'cursor-pointer border-info/40 bg-surface-sunken text-info',
};

export function SyncBadge() {
  const { state, nextRetryAt } = useSync();
  const spinning =
    state.kind === 'syncing-push' || state.kind === 'syncing-pull';
  // Live countdown while waiting out an error-state backoff.
  // `now` only ticks while there is a
  // deadline to count down to, and the interval is torn down on leaving the
  // error state and on unmount — it does not exist at all otherwise.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.kind !== 'error' || nextRetryAt === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [state.kind, nextRetryAt]);
  const secondsLeft =
    state.kind === 'error' && nextRetryAt !== null ? secondsUntil(nextRetryAt, now) : null;
  return (
    // `aria-live` rides the inert wrapper, not the focusable button: a
    // live region on the interactive element itself is announced
    // unreliably (some AT suppress it while the control has focus). The
    // `title` hover tooltip also rides this wrapper: `DialogTrigger`
    // renders no DOM of its own, so the wrapper covers exactly the pill,
    // and React Aria's `Button` prop type omits the global `title` attr.
    // Both `title` and this wrapper's announced text are derived from
    // `state` alone (never `secondsLeft`), so they change on state
    // transitions only — the per-second countdown below is visible
    // decoration, excluded from announced content via `aria-hidden` on the
    // digits, so a screen reader is never re-announced once a second for
    // the length of the wait.
    <span
      className="relative inline-flex items-center gap-1.5"
      aria-live="polite"
      title={describe(state)}
    >
      <DialogTrigger>
        <Button
          type="button"
          className={`${BADGE_BASE} ${BADGE_TONE[state.kind]}`}
          // Stable state hook (visual tone is now utility classes; the
          // semantic state is exposed here so consumers/tests observe it
          // without coupling to styling).
          data-sync-state={state.kind}
        >
          <span
            aria-hidden="true"
            className={`inline-flex items-center justify-center leading-none ${
              spinning ? 'animate-spin motion-reduce:animate-none' : ''
            }`}
          >
            {iconFor(state.kind)}
          </span>
          {secondsLeft !== null ? (
            // The visible countdown is entirely
            // decorative (outer `aria-hidden`) — a screen reader must never
            // hear the ungrammatical "Retrying in s" left behind once only
            // the digits were hidden. The accessible name instead comes from
            // an `sr-only` sibling carrying `textFor(state)` ("Sync failed"),
            // so it still only changes on state transitions, never once a
            // second.
            <span>
              <span aria-hidden="true">
                Retrying in <span aria-hidden="true">{secondsLeft}</span>s
              </span>
              <span className="sr-only">{textFor(state)}</span>
            </span>
          ) : (
            <span>{textFor(state)}</span>
          )}
        </Button>
        <SyncDetailsPopover />
      </DialogTrigger>
    </span>
  );
}

// All status icons share dimensions + stroke conventions so the badge
// looks consistent across states. The wrapper sets size + stroke once
// and each per-state component supplies its own paths.
function StatusSvg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1.8em"
      height="1.8em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function iconFor(kind: ReturnType<typeof useSync>['state']['kind']): React.ReactNode {
  switch (kind) {
    // Cloud + check: synced.
    case 'synced':
      return (
        <StatusSvg>
          <path d="M7 18a4 4 0 010-8 5 5 0 019.6-1.3A4 4 0 0117 18H7z" />
          <polyline points="9.5 13.5 11 15 14.5 11.5" />
        </StatusSvg>
      );
    // Circular arrow: in-flight sync (the existing CSS spin animation
    // rotates the icon span, so the SVG inherits the rotation).
    case 'syncing-push':
    case 'syncing-pull':
      return (
        <StatusSvg>
          <path d="M21 12a9 9 0 11-2.5-6.2L21 8" />
          <polyline points="21 3 21 8 16 8" />
        </StatusSvg>
      );
    // Cloud crossed out: offline.
    case 'offline':
      return (
        <StatusSvg>
          <path d="M5.8 8.4A4 4 0 007 18h9.5" />
          <path d="M21 16.4A4 4 0 0017 10a5 5 0 00-9.6-1.3" />
          <line x1="3" y1="3" x2="21" y2="21" />
        </StatusSvg>
      );
    // Alert triangle: sync failed (clickable to retry).
    case 'error':
      return (
        <StatusSvg>
          <path d="M10.3 3.86l-7.84 13.4A2 2 0 004.18 20h15.64a2 2 0 001.72-2.74L13.7 3.86a2 2 0 00-3.4 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12" y2="17" />
        </StatusSvg>
      );
    // Cloud-with-down-arrow: server has changes, click to refresh.
    case 'stale':
      return (
        <StatusSvg>
          <path d="M7 18a4 4 0 010-8 5 5 0 019.6-1.3A4 4 0 0117 18" />
          <line x1="12" y1="10" x2="12" y2="17" />
          <polyline points="9.5 14.5 12 17 14.5 14.5" />
        </StatusSvg>
      );
    // Cloud-with-up-arrow: local edits queued, awaiting push.
    case 'pending':
      return (
        <StatusSvg>
          <path d="M7 18a4 4 0 010-8 5 5 0 019.6-1.3A4 4 0 0117 18" />
          <line x1="12" y1="10" x2="12" y2="17" />
          <polyline points="9.5 12.5 12 10 14.5 12.5" />
        </StatusSvg>
      );
    // Shield-with-alert: freshness rollback / tampered server view.
    case 'rollback-detected':
      return (
        <StatusSvg>
          <path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="16" x2="12" y2="16" />
        </StatusSvg>
      );
    // Circular arrow (same glyph as syncing-push/-pull, rendered static —
    // `spinning` below deliberately excludes this kind): a newer app
    // version is available, reload to update.
    case 'update-available':
      return (
        <StatusSvg>
          <path d="M21 12a9 9 0 11-2.5-6.2L21 8" />
          <polyline points="21 3 21 8 16 8" />
        </StatusSvg>
      );
  }
}

function textFor(state: ReturnType<typeof useSync>['state']): string {
  switch (state.kind) {
    case 'synced':
      return state.lastSyncedAt ? `Synced ${relativeTime(state.lastSyncedAt)}` : 'Synced';
    case 'syncing-push':
      return 'Syncing…';
    case 'syncing-pull':
      return 'Refreshing…';
    case 'offline':
      return 'Offline';
    case 'error':
      return 'Sync failed';
    case 'stale':
      return 'Refresh needed';
    case 'pending':
      return `Pending (${state.count})`;
    case 'rollback-detected':
      return 'Sync blocked';
    case 'update-available':
      return 'Update available';
  }
}
