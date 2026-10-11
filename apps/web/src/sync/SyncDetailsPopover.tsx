/**
 * Unified badge-anchored sync details popover (replaces the error-only
 * `SyncErrorPopover.tsx`). Opens on a badge click in all 9 sync states
 * and surfaces: status sentence, last-synced time (relative + exact;
 * "Not synced yet" when never synced), pending count, conflict count,
 * connection (Online/Offline), and an adaptive per-state action button.
 * The `error` state additionally renders the structured error
 * envelope (`phase`/`code`/`status`/`traceId`/`message`) + "Copy details".
 *
 * Built on React Aria's `Popover`/`Dialog`. The
 * `DialogTrigger` lives on `SyncBadge` (the badge pill is the trigger);
 * this component is rendered as the trigger's popover child and reads
 * `useSync()` directly (it lives inside `SyncProvider`) rather than
 * threading props. React Aria owns anchored positioning, outside-press +
 * Esc-to-close, and focus management.
 *
 * The action button keeps the user in context: the popover stays
 * open while the action runs (button shows a "Working…" spinner), and
 * `syncRoundTrip`'s `{ok:false, reason}` renders an inline error line.
 * `retryNow`/`forceRefresh` surface their result via the resulting badge
 * state (the popover re-renders from `useSync()`).
 */
import React, { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Popover } from 'react-aria-components';
import { useSync } from './SyncContext.js';
import type { SyncErrorDetail } from './types.js';
import { describe as describeState, relativeTime } from './badge-format.js';
import { UnsyncedMutationList } from './UnsyncedMutationList.js';

function formatErrorReport(detail: SyncErrorDetail): string {
  const lines: string[] = [];
  if (detail.phase) lines.push(`Phase: ${detail.phase}`);
  if (detail.code) lines.push(`Code: ${detail.code}`);
  if (typeof detail.status === 'number') lines.push(`Status: ${detail.status}`);
  if (detail.traceId) lines.push(`Trace ID: ${detail.traceId}`);
  lines.push(`Message: ${detail.message}`);
  lines.push(`Timestamp: ${new Date().toISOString()}`);
  return lines.join('\n');
}

const DT_CLASS = 'w-20 shrink-0 font-medium text-muted';
const DD_CLASS = 'm-0 min-w-0 break-words';

const ROW_CLASS = 'flex gap-2.5 text-xs';
const ROW_VALUE_CLASS = 'm-0 min-w-0 break-words text-ink';

const ACTION_BUTTON_CLASS =
  'inline-flex items-center gap-1.5 self-start rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-ink outline-none transition-colors hover:bg-surface-sunken data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

// Small inline spinner reused by in-flight + pending-action buttons.
function Spinner(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width="0.9em"
      height="0.9em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="animate-spin motion-reduce:animate-none"
    >
      <path d="M21 12a9 9 0 11-2.5-6.2" />
    </svg>
  );
}

type ActionState = 'idle' | 'pending' | 'error';

export function SyncDetailsPopover(): React.ReactElement {
  const {
    state,
    pendingCount,
    conflictCount,
    pendingMutations,
    conflictMutations,
    failedErrorMutations,
    lastSyncedAt,
    syncRoundTrip,
    retryNow,
    forceRefresh,
    resolveConflict,
  } = useSync();

  const [actionState, setActionState] = useState<ActionState>('idle');
  const [actionError, setActionError] = useState<string>('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );

  // Auto-reset handle for the "Copied"/"Copy failed" label. Stored in a
  // ref so a popover close (unmount) before the 2s timeout fires cancels
  // it instead of calling setState on an unmounted component.
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) clearTimeout(copyResetRef.current);
    };
  }, []);

  const kind = state.kind;
  const isOffline = kind === 'offline';
  const inFlight = kind === 'syncing-push' || kind === 'syncing-pull';
  const running = actionState === 'pending';

  const onSyncNow = async (): Promise<void> => {
    setActionState('pending');
    setActionError('');
    const result = await syncRoundTrip();
    if (result.ok) {
      setActionState('idle');
    } else {
      setActionState('error');
      setActionError(result.reason);
    }
  };

  const onRetry = async (): Promise<void> => {
    setActionState('pending');
    setActionError('');
    await retryNow();
    // `retryNow` surfaces its result via the resulting badge state, not a
    // return value — clear the pending spinner once it settles.
    setActionState('idle');
  };

  const onRefresh = async (): Promise<void> => {
    setActionState('pending');
    setActionError('');
    await forceRefresh();
    setActionState('idle');
  };

  const onCopy = async (): Promise<void> => {
    if (state.kind !== 'error') return;
    try {
      await navigator.clipboard.writeText(formatErrorReport(state));
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    if (copyResetRef.current !== null) clearTimeout(copyResetRef.current);
    copyResetRef.current = setTimeout(() => setCopyState('idle'), 2000);
  };

  // Adaptive action button per state. `rollback-detected` renders no
  // button (a security explanation paragraph instead).
  function renderAction(): React.ReactNode {
    if (kind === 'rollback-detected') {
      return (
        <p className="m-0 text-xs text-muted">
          The server returned an out-of-date or tampered view. Sync is blocked
          to protect your data — there is no client-side retry that fixes a
          rollback. This device was sent data that wasn&rsquo;t sealed with
          your encryption key, so it was refused before anything was saved.
        </p>
      );
    }

    if (inFlight) {
      const label = kind === 'syncing-pull' ? 'Refreshing…' : 'Syncing…';
      return (
        <Button className={ACTION_BUTTON_CLASS} isDisabled>
          <Spinner />
          {label}
        </Button>
      );
    }

    if (running) {
      return (
        <Button className={ACTION_BUTTON_CLASS} isDisabled>
          <Spinner />
          Working…
        </Button>
      );
    }

    if (isOffline) {
      return (
        <div className="flex flex-col gap-1">
          <Button className={ACTION_BUTTON_CLASS} isDisabled>
            Sync now
          </Button>
          <p className="m-0 text-xs text-muted">
            You're offline. Will sync on reconnect.
          </p>
        </div>
      );
    }

    if (kind === 'error') {
      return (
        <Button
          className={ACTION_BUTTON_CLASS}
          onPress={onRetry}
        >
          Retry now
        </Button>
      );
    }

    if (kind === 'stale') {
      return (
        <Button
          className={ACTION_BUTTON_CLASS}
          onPress={onRefresh}
        >
          Refresh from server
        </Button>
      );
    }

    if (kind === 'update-available') {
      // A pulled row is at a schemaVersion this bundle can't read — only
      // a reload (not a retry) fixes it. Mirrors the VersionBanner reload.
      return (
        <Button
          className={ACTION_BUTTON_CLASS}
          onPress={() => window.location.reload()}
        >
          Reload to update
        </Button>
      );
    }

    // synced / pending → "Sync now".
    return (
      <Button
        className={ACTION_BUTTON_CLASS}
        onPress={onSyncNow}
      >
        Sync now
      </Button>
    );
  }

  return (
    <Popover offset={6} className="z-40 outline-none" aria-label="Cloud sync">
      <Dialog
        aria-label="Cloud sync"
        className="flex min-w-72 max-w-sm flex-col gap-2 rounded-lg border border-line bg-surface-raised p-3 shadow-lg outline-none"
      >
        <h3 className="m-0 text-sm font-semibold text-ink">Cloud sync</h3>
        <div className="flex flex-col gap-y-0.5">
          <div className={ROW_CLASS}>
            <span className={DT_CLASS}>Status</span>
            <span className={ROW_VALUE_CLASS}>{describeState(state)}</span>
          </div>
          <div className={ROW_CLASS}>
            <span className={DT_CLASS}>Last synced</span>
            {lastSyncedAt ? (
              <span className={ROW_VALUE_CLASS} title={lastSyncedAt}>
                {relativeTime(lastSyncedAt)}
              </span>
            ) : (
              <span className={ROW_VALUE_CLASS}>Not synced yet</span>
            )}
          </div>
          <div className={ROW_CLASS}>
            <span className={DT_CLASS}>Pending</span>
            <span className={ROW_VALUE_CLASS}>{pendingCount}</span>
          </div>
          <div className={ROW_CLASS}>
            <span className={DT_CLASS}>Conflicts</span>
            <span className={ROW_VALUE_CLASS}>{conflictCount}</span>
          </div>
          <div className={ROW_CLASS}>
            <span className={DT_CLASS}>Connection</span>
            <span className={ROW_VALUE_CLASS}>
              {isOffline ? 'Offline' : 'Online'}
            </span>
          </div>
        </div>

        {/* Inspector naming each un-synced / stuck item, with a per-row
            keep/discard Resolve control on each conflict (the callback is
            injected here, not reached via useSync() inside the shared list).
            Renders nothing when there are none. Defensive `?? []` reads so a
            partial mock / mid-mount context can't crash the render. */}
        <UnsyncedMutationList
          pending={pendingMutations ?? []}
          conflicts={conflictMutations ?? []}
          failedErrors={failedErrorMutations ?? []}
          resolveConflict={resolveConflict}
        />

        {renderAction()}
        {actionState === 'error' && actionError ? (
          <p className="m-0 text-xs text-negative">{actionError}</p>
        ) : null}

        {state.kind === 'error' ? (
          <>
            {/* Flex rows with a fixed label column (no arbitrary grid
                template). A single <div> grouping dt/dd pairs is valid
                inside <dl> (HTML5). */}
            <dl className="m-0 flex flex-col gap-y-0.5 border-t border-line pt-2 text-xs">
              {state.phase ? (
                <div className="flex gap-2.5">
                  <dt className={DT_CLASS}>Phase</dt>
                  <dd className={DD_CLASS}>{state.phase}</dd>
                </div>
              ) : null}
              {state.code ? (
                <div className="flex gap-2.5">
                  <dt className={DT_CLASS}>Code</dt>
                  <dd className={DD_CLASS}>
                    <code>{state.code}</code>
                  </dd>
                </div>
              ) : null}
              {typeof state.status === 'number' ? (
                <div className="flex gap-2.5">
                  <dt className={DT_CLASS}>Status</dt>
                  <dd className={DD_CLASS}>{state.status}</dd>
                </div>
              ) : null}
              {state.traceId ? (
                <div className="flex gap-2.5">
                  <dt className={DT_CLASS}>Trace ID</dt>
                  <dd className={DD_CLASS}>
                    <code>{state.traceId}</code>
                  </dd>
                </div>
              ) : null}
              <div className="flex gap-2.5">
                <dt className={DT_CLASS}>Message</dt>
                <dd className={DD_CLASS}>{state.message}</dd>
              </div>
            </dl>
            <Button className={ACTION_BUTTON_CLASS} onPress={onCopy}>
              {copyState === 'copied'
                ? 'Copied'
                : copyState === 'failed'
                  ? 'Copy failed'
                  : 'Copy details'}
            </Button>
          </>
        ) : null}
      </Dialog>
    </Popover>
  );
}
