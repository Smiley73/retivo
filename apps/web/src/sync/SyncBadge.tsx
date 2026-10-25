// Header badge for the cloud-sync state: a React Aria `DialogTrigger` pill that opens SyncDetailsPopover in every state.
// Tones are AA-safe pairs (contrast.ts); the spin on in-flight states respects `prefers-reduced-motion`.
import React, { useEffect, useState } from 'react';
import { Button, DialogTrigger } from 'react-aria-components';
import { useSync } from './SyncContext.js';
import { SyncDetailsPopover } from './SyncDetailsPopover.js';
import { describe, relativeTime, secondsUntil } from './badge-format.js';

type SyncKind = ReturnType<typeof useSync>['state']['kind'];

const BADGE_BASE =
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 ' +
  'text-xs font-medium transition-colors';

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
  // A security-relevant rejection of a stale or tampered server view: the popover explains it, but no client-side
  // action fixes a rollback.
  'rollback-detected':
    'cursor-pointer border-negative/40 bg-surface-sunken text-negative',
  // A calm "update needed" state, not a sync error.
  'update-available': 'cursor-pointer border-info/40 bg-surface-sunken text-info',
};

export function SyncBadge() {
  const { state, nextRetryAt } = useSync();
  const spinning =
    state.kind === 'syncing-push' || state.kind === 'syncing-pull';
  // Live countdown during an error-state backoff; the interval exists only while there is a deadline.
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
    // `aria-live` rides the inert wrapper: a live region on the focusable button is announced unreliably (some AT
    // suppress it while the control has focus). `title` rides it too: DialogTrigger renders no DOM and React Aria's
    // `Button` omits the global `title`. Both derive from `state` alone and the per-second countdown is `aria-hidden`,
    // so a screen reader is not re-announced every second.
    <span
      className="relative inline-flex items-center gap-1.5"
      aria-live="polite"
      title={describe(state)}
    >
      <DialogTrigger>
        <Button
          type="button"
          className={`${BADGE_BASE} ${BADGE_TONE[state.kind]}`}
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
            // The visible countdown is decorative and fully `aria-hidden`, so a screen reader never hears a dangling
            // "Retrying in s"; the `sr-only` sibling carries `textFor(state)`, which changes only on state transitions.
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
    case 'synced':
      return (
        <StatusSvg>
          <path d="M7 18a4 4 0 010-8 5 5 0 019.6-1.3A4 4 0 0117 18H7z" />
          <polyline points="9.5 13.5 11 15 14.5 11.5" />
        </StatusSvg>
      );
    case 'syncing-push':
    case 'syncing-pull':
      return (
        <StatusSvg>
          <path d="M21 12a9 9 0 11-2.5-6.2L21 8" />
          <polyline points="21 3 21 8 16 8" />
        </StatusSvg>
      );
    case 'offline':
      return (
        <StatusSvg>
          <path d="M5.8 8.4A4 4 0 007 18h9.5" />
          <path d="M21 16.4A4 4 0 0017 10a5 5 0 00-9.6-1.3" />
          <line x1="3" y1="3" x2="21" y2="21" />
        </StatusSvg>
      );
    case 'error':
      return (
        <StatusSvg>
          <path d="M10.3 3.86l-7.84 13.4A2 2 0 004.18 20h15.64a2 2 0 001.72-2.74L13.7 3.86a2 2 0 00-3.4 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12" y2="17" />
        </StatusSvg>
      );
    case 'stale':
      return (
        <StatusSvg>
          <path d="M7 18a4 4 0 010-8 5 5 0 019.6-1.3A4 4 0 0117 18" />
          <line x1="12" y1="10" x2="12" y2="17" />
          <polyline points="9.5 14.5 12 17 14.5 14.5" />
        </StatusSvg>
      );
    case 'pending':
      return (
        <StatusSvg>
          <path d="M7 18a4 4 0 010-8 5 5 0 019.6-1.3A4 4 0 0117 18" />
          <line x1="12" y1="10" x2="12" y2="17" />
          <polyline points="9.5 12.5 12 10 14.5 12.5" />
        </StatusSvg>
      );
    case 'rollback-detected':
      return (
        <StatusSvg>
          <path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="16" x2="12" y2="16" />
        </StatusSvg>
      );
    // Same glyph as syncing-push/-pull but static: `spinning` excludes this kind.
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
