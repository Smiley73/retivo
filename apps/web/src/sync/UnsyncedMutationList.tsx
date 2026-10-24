// Shared list of un-synced mutations (pending, failed-conflict, failed-error) for the badge popover and Diagnostics card.
// Presentational: `resolveConflict` is injected, never read via `useSync()`. Names and times are display-only PII, never logged.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import type { PendingMutation } from '../db/types.js';
import { Badge, type BadgeTone } from '../components/Badge.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { relativeTimeFromMs } from './badge-format.js';
import {
  AGGREGATE_TYPE_LABEL,
  resolveMutationLabel,
  type ResolvedMutationLabel,
} from './mutation-label.js';

// Injected resolve callback: keep re-bases the parked edit onto the server's true version and re-pushes; discard drops
// it and adopts the server copy.
type ResolveConflict = (
  mutation: PendingMutation,
  choice: 'keep' | 'discard',
) => Promise<void>;

interface Props {
  pending: readonly PendingMutation[];
  conflicts: readonly PendingMutation[];
  failedErrors: readonly PendingMutation[];
  /**
   * When provided, each surviving `failed-conflict` row gets a keep/discard Resolve control; absent, the list is
   * read-only.
   */
  resolveConflict?: ResolveConflict;
}

type RowKind = 'conflict' | 'error' | 'pending';

interface Row {
  mutation: PendingMutation;
  kind: RowKind;
}

const CONFLICT_PILL: Record<NonNullable<PendingMutation['reason']>, string> = {
  CONFLICT: 'Conflict',
  NOT_FOUND: 'Deleted',
  SCHEMA_MISMATCH: 'Update needed',
};

const REASON_EXPLANATION: Record<NonNullable<PendingMutation['reason']>, string> = {
  CONFLICT: 'Someone changed this elsewhere — refresh to get the latest',
  NOT_FOUND: 'This was removed on another device',
  SCHEMA_MISMATCH: 'Reload the app to keep syncing',
};

/**
 * Plain-English descriptor of an un-synced edit per rejection reason, shared by the per-item discard dialog and the
 * global "Reload from server" confirm so both phrase the loss identically. A plain `pending` row has no reason and
 * reads "not yet synced" at the call site.
 */
export const REASON_LABEL: Record<NonNullable<PendingMutation['reason']>, string> = {
  CONFLICT: 'changed on another device',
  NOT_FOUND: 'deleted on another device',
  SCHEMA_MISMATCH: 'waiting for an app update',
};

function unsyncedEditDescriptor(mutation: PendingMutation): string {
  return mutation.reason ? REASON_LABEL[mutation.reason] : 'not yet synced';
}

// The negative `disabled` tone is the only AA-cleared red Badge tone; amber `modified` matches "Refresh needed".
const PILL: Record<Exclude<RowKind, 'conflict'>, { label: string; tone: BadgeTone }> = {
  error: { label: 'Error', tone: 'disabled' },
  pending: { label: 'Pending', tone: 'neutral' },
};

const CONFLICT_TONE: BadgeTone = 'modified';

// Resolve buttons are RAC `Button`s with the `data-[focus-visible]` ring variant (a plain `focus-visible:` one never
// fires on a RAC button). The base omits padding and is reused with KEEP_BTN_COLORS by the Diagnostics "Check & repair"
// button so the two can't drift.
export const RESOLVE_BTN_BASE =
  'inline-flex items-center rounded-md border text-xs font-medium outline-none transition-colors data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
export const KEEP_BTN_COLORS =
  'border-line-strong bg-surface-raised text-accent-link hover:bg-surface-sunken';
const KEEP_BTN_CLASS = `${RESOLVE_BTN_BASE} px-2 py-0.5 ${KEEP_BTN_COLORS}`;
const DISCARD_BTN_CLASS = `${RESOLVE_BTN_BASE} px-2 py-0.5 border-negative/40 bg-surface text-negative hover:bg-surface-sunken`;

function fallbackLabel(mutation: PendingMutation): ResolvedMutationLabel {
  return { typeLabel: AGGREGATE_TYPE_LABEL[mutation.aggregateType], name: mutation.aggregateId };
}

function queuedAtTitle(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Resolves each mutation's label async from local IDB (throw-safe, raw-id fallback; display-only, never logged). Prunes
// labels for since-applied ids, resolves only unknown ids (type+id is immutable), and ignores a promise settling after
// unmount or a row-set change. The caller passes a memoized array so the effect keys on a stable identity.
function useResolvedLabels(
  mutations: readonly PendingMutation[],
): Map<string, ResolvedMutationLabel> {
  const [labels, setLabels] = useState<Map<string, ResolvedMutationLabel>>(() => new Map());
  // Mirror of the latest labels so the effect can skip resolved ids without listing `labels` as a dep, which would
  // restart the loop on every per-row setState.
  const labelsRef = useRef(labels);
  useEffect(() => {
    labelsRef.current = labels;
  }, [labels]);

  useEffect(() => {
    let cancelled = false;
    const ids = new Set(mutations.map((m) => m.id));
    setLabels((prev) => {
      let changed = false;
      const next = new Map<string, ResolvedMutationLabel>();
      for (const [id, value] of prev) {
        if (ids.has(id)) next.set(id, value);
        else changed = true;
      }
      return changed ? next : prev;
    });
    void (async () => {
      const known = labelsRef.current;
      for (const m of mutations) {
        if (known.has(m.id)) continue;
        const resolved = await resolveMutationLabel(m);
        if (cancelled) return;
        setLabels((prev) => new Map(prev).set(m.id, resolved));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mutations]);

  return labels;
}

export function UnsyncedMutationList({
  pending,
  conflicts,
  failedErrors,
  resolveConflict,
}: Props): React.ReactElement | null {
  // Conflicts first, then failed-errors, then pending.
  const rows = useMemo<Row[]>(
    () => [
      ...conflicts.map((mutation) => ({ mutation, kind: 'conflict' as const })),
      ...failedErrors.map((mutation) => ({ mutation, kind: 'error' as const })),
      ...pending.map((mutation) => ({ mutation, kind: 'pending' as const })),
    ],
    [conflicts, failedErrors, pending],
  );
  const mutations = useMemo(() => rows.map((row) => row.mutation), [rows]);
  const labels = useResolvedLabels(mutations);

  // One in-flight resolve at a time, keeping queue writes serial.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyChoice, setBusyChoice] = useState<'keep' | 'discard' | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [discardTarget, setDiscardTarget] = useState<PendingMutation | null>(null);
  // Set when a discard did not converge (the wedge): `resolveConflict` leaves the row parked, so this surfaces the "try
  // keep, or Reload" note; a converged discard removes the row.
  const [discardStuckId, setDiscardStuckId] = useState<string | null>(null);

  const runResolve = async (
    mutation: PendingMutation,
    choice: 'keep' | 'discard',
  ): Promise<void> => {
    if (!resolveConflict) return;
    setBusyId(mutation.id);
    setBusyChoice(choice);
    setRowError(null);
    setDiscardStuckId(null);
    try {
      await resolveConflict(mutation, choice);
      // Discard resolves void either way: a converged one removes the row, a wedge leaves it parked, so mark it to
      // surface the recovery hint.
      if (choice === 'discard') setDiscardStuckId(mutation.id);
    } catch {
      setRowError({
        id: mutation.id,
        message:
          choice === 'keep'
            ? "Couldn't keep your change. Please try again."
            : "Couldn't discard your change. Please try again.",
      });
    } finally {
      setBusyId(null);
      setBusyChoice(null);
    }
  };

  const onDiscardConfirm = (): void => {
    const target = discardTarget;
    setDiscardTarget(null);
    if (target) void runResolve(target, 'discard');
  };

  const busy = busyId !== null;
  const discardLabel = discardTarget
    ? labels.get(discardTarget.id) ?? fallbackLabel(discardTarget)
    : null;

  // Render nothing for empty input; the confirm dialog opens only from a conflict row, so this early return can't
  // strand it.
  if (rows.length === 0) return null;

  return (
    <>
      <div
        role="region"
        aria-label="Unsynced items"
        tabIndex={0}
        className="max-h-64 overflow-y-auto rounded-md border border-line outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ul className="m-0 list-none p-0">
          {rows.map(({ mutation, kind }) => {
            const label = labels.get(mutation.id) ?? fallbackLabel(mutation);
            const why =
              kind === 'conflict' && mutation.reason ? REASON_EXPLANATION[mutation.reason] : null;
            const pill =
              kind === 'conflict'
                ? { label: mutation.reason ? CONFLICT_PILL[mutation.reason] : 'Conflict', tone: CONFLICT_TONE }
                : PILL[kind];
            // A legacy conflict (no persisted server version) can't re-base yet: disable until Check & repair
            // rehydrates it.
            const isLegacy = mutation.currentVersion == null;
            const showResolve = kind === 'conflict' && resolveConflict != null;
            const rowBusy = busy && busyId === mutation.id;
            return (
              <li
                key={mutation.id}
                className="flex flex-col gap-0.5 border-b border-line px-2.5 py-1.5 text-xs last:border-b-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={pill.tone}>{pill.label}</Badge>
                  <span className="text-muted">{label.typeLabel}</span>
                  <span className="min-w-0 break-words font-medium text-ink">{label.name}</span>
                  {label.detail ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-muted">{label.detail}</span>
                    </>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted">
                  <span title={queuedAtTitle(mutation.timestamp)}>
                    queued {relativeTimeFromMs(mutation.timestamp)}
                  </span>
                  {why ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-warning">{why}</span>
                    </>
                  ) : null}
                </div>
                {showResolve ? (
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    {/* a11y: the visible text is the same generic verb on every row, so each button's accessible name
                        is  composed from the row's type + name; a screen-reader user navigating by control can tell
                        which stuck  item it acts on. Display-only, never logged. */}
                    <Button
                      className={KEEP_BTN_CLASS}
                      aria-label={`Keep mine — ${label.typeLabel} ${label.name}`}
                      isDisabled={isLegacy || busy}
                      onPress={() => void runResolve(mutation, 'keep')}
                    >
                      {rowBusy && busyChoice === 'keep' ? 'Keeping…' : 'Keep mine'}
                    </Button>
                    <Button
                      className={DISCARD_BTN_CLASS}
                      aria-label={`Discard — ${label.typeLabel} ${label.name}`}
                      isDisabled={isLegacy || busy}
                      onPress={() => {
                        setRowError(null);
                        setDiscardStuckId(null);
                        setDiscardTarget(mutation);
                      }}
                    >
                      {rowBusy && busyChoice === 'discard' ? 'Discarding…' : 'Discard'}
                    </Button>
                    {isLegacy ? (
                      <span className="text-muted">
                        Use Check &amp; repair (Settings → Workspace) to enable
                      </span>
                    ) : null}
                    {rowError?.id === mutation.id ? (
                      <span className="text-negative">{rowError.message}</span>
                    ) : null}
                    {discardStuckId === mutation.id && rowError?.id !== mutation.id ? (
                      <span className="text-warning">
                        Couldn&apos;t discard — keep your change, or use Reload from server.
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      <ConfirmDialog
        open={discardTarget != null}
        size="lg"
        title="Discard your unsynced change?"
        message={
          discardLabel ? (
            <>
              This drops your unsynced change to{' '}
              <strong>
                {discardLabel.typeLabel} {discardLabel.name}
              </strong>
              {discardTarget?.reason ? <> (it was {REASON_LABEL[discardTarget.reason]})</> : null}{' '}
              and replaces it with the server&apos;s copy. This can&apos;t be undone.
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Discard my change"
        cancelLabel="Keep editing"
        onConfirm={onDiscardConfirm}
        onCancel={() => setDiscardTarget(null)}
      />
    </>
  );
}

/**
 * Names each un-synced edit a discard would drop, for the global "Reload from server" confirm (WorkspaceToolsCard). The
 * height-capped list sits in a named, keyboard-focusable scroll region (`role="region"`, `aria-label`, `tabIndex={0}`,
 * focus ring, like `TableScroll`) so it stays reachable by keyboard. Renders nothing when empty.
 */
export function UnsyncedEditsWarningList({
  mutations,
}: {
  mutations: readonly PendingMutation[];
}): React.ReactElement | null {
  const labels = useResolvedLabels(mutations);
  if (mutations.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Unsynced edits that will be discarded"
      tabIndex={0}
      className="max-h-40 overflow-y-auto rounded-md border border-line outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ul className="m-0 list-disc py-1 pl-5 pr-2 text-sm">
        {mutations.map((mutation) => {
          const label = labels.get(mutation.id) ?? fallbackLabel(mutation);
          return (
            <li key={mutation.id} className="text-ink">
              <span className="text-muted">{label.typeLabel}</span>{' '}
              <span className="font-medium">{label.name}</span>
              {label.detail ? <span className="text-muted"> ({label.detail})</span> : null}{' '}
              <span className="text-muted">— {unsyncedEditDescriptor(mutation)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
