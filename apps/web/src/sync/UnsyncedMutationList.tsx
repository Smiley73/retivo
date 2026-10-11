/**
 * Shared list of un-synced mutations (pending / failed-conflict / failed-error)
 * for the sync inspector. Shared by the badge details popover and the Workspace
 * → Diagnostics card so the two surfaces can't diverge.
 *
 * Each row shows a status pill (reason-accurate for a conflict), the friendly
 * type + resolved human name, a "queued <relative> ago" time (exact local
 * time on hover), and — for a conflict with a persisted reason — a
 * plain-English cause/action line. When the host injects a `resolveConflict`
 * callback, each surviving `failed-conflict` row also gains a **Resolve**
 * control (keep mine / discard) — a discard first names the exact edit it drops
 * in a `ConfirmDialog` so nothing is lost silently. A legacy conflict parked
 * before the resolve feature shipped (no persisted server version) shows the
 * controls disabled with a host-agnostic "Use Check & repair (Settings →
 * Workspace) to enable" hint — Check & repair lives on the Workspace
 * Diagnostics card, so the hint stays correct from the badge popover too.
 *
 * The list stays presentational: the `resolveConflict` effect is INJECTED as a
 * prop from each host (never reached via `useSync()` inside the shared list), so
 * the two hosts share exactly one row renderer. Names and times are
 * resolved/derived asynchronously from local IndexedDB / `mutation.timestamp`
 * and are display-only: they are never passed to any diagnostics sink (PII in
 * this zero-knowledge app).
 */
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

/** Injected resolve callback: keep re-bases the parked edit onto the server's
 *  true version and re-pushes; discard drops the edit and adopts the server
 *  copy. Supplied by each host (`SyncDetailsPopover`, `DiagnosticsCard`) from
 *  `useSync().resolveConflict`, never reached via `useSync()` inside this shared
 *  presentational list. */
type ResolveConflict = (
  mutation: PendingMutation,
  choice: 'keep' | 'discard',
) => Promise<void>;

interface Props {
  pending: readonly PendingMutation[];
  conflicts: readonly PendingMutation[];
  failedErrors: readonly PendingMutation[];
  /** When provided, each surviving `failed-conflict` row gets a keep/discard
   *  Resolve control. Absent → the list stays read-only. */
  resolveConflict?: ResolveConflict;
}

type RowKind = 'conflict' | 'error' | 'pending';

interface Row {
  mutation: PendingMutation;
  kind: RowKind;
}

/** Reason-accurate conflict pill label (layman's terms). */
const CONFLICT_PILL: Record<NonNullable<PendingMutation['reason']>, string> = {
  CONFLICT: 'Conflict',
  NOT_FOUND: 'Deleted',
  SCHEMA_MISMATCH: 'Update needed',
};

/** Plain-English cause/action line for each persisted conflict reason. */
const REASON_EXPLANATION: Record<NonNullable<PendingMutation['reason']>, string> = {
  CONFLICT: 'Someone changed this elsewhere — refresh to get the latest',
  NOT_FOUND: 'This was removed on another device',
  SCHEMA_MISMATCH: 'Reload the app to keep syncing',
};

/**
 * Short plain-English descriptor of an un-synced edit per rejection reason, for
 * the warn-before-discard copy that NAMES exactly what a discard would drop
 * (both the per-item Resolve dialog and the global "Reload from server" confirm).
 * Reused so the two warn surfaces phrase the loss identically. A row with no
 * persisted reason (a plain `pending` edit) reads as "not yet synced" at the
 * call site, so this map only covers the three server-rejection reasons.
 */
export const REASON_LABEL: Record<NonNullable<PendingMutation['reason']>, string> = {
  CONFLICT: 'changed on another device',
  NOT_FOUND: 'deleted on another device',
  SCHEMA_MISMATCH: 'waiting for an app update',
};

/** The warn-before-discard descriptor for one un-synced edit (a persisted
 *  reason via {@link REASON_LABEL}, else "not yet synced" for a plain pending
 *  row). */
function unsyncedEditDescriptor(mutation: PendingMutation): string {
  return mutation.reason ? REASON_LABEL[mutation.reason] : 'not yet synced';
}

/**
 * Status pill per row kind. Amber warning = the "Refresh needed" conflict
 * semantics; the negative (red) `disabled` tone is the only AA-cleared red
 * Badge tone, used for the (today inert) Error pill; Pending is the neutral
 * default. No new colours. A conflict row's label is reason-accurate
 * (`CONFLICT_PILL`) when a reason is persisted, else the generic "Conflict".
 */
const PILL: Record<Exclude<RowKind, 'conflict'>, { label: string; tone: BadgeTone }> = {
  error: { label: 'Error', tone: 'disabled' },
  pending: { label: 'Pending', tone: 'neutral' },
};

const CONFLICT_TONE: BadgeTone = 'modified';

// Resolve-control buttons — React Aria `Button`
// with the RAC `data-[focus-visible]` ring variant (a plain `focus-visible:` one
// never fires on a RAC button). Semantic tokens only. The base omits padding so
// each call site composes its own; the base + `KEEP_BTN_COLORS` are exported and
// reused by the Diagnostics "Check & repair" button (same look, looser padding)
// so the two secondary buttons can't drift.
export const RESOLVE_BTN_BASE =
  'inline-flex items-center rounded-md border text-xs font-medium outline-none transition-colors data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
/** Keep/secondary button colour run — reused by the Diagnostics "Check & repair"
 *  button so the shared look stays single-sourced. */
export const KEEP_BTN_COLORS =
  'border-line-strong bg-surface-raised text-accent-link hover:bg-surface-sunken';
const KEEP_BTN_CLASS = `${RESOLVE_BTN_BASE} px-2 py-0.5 ${KEEP_BTN_COLORS}`;
const DISCARD_BTN_CLASS = `${RESOLVE_BTN_BASE} px-2 py-0.5 border-negative/40 bg-surface text-negative hover:bg-surface-sunken`;

function fallbackLabel(mutation: PendingMutation): ResolvedMutationLabel {
  return { typeLabel: AGGREGATE_TYPE_LABEL[mutation.aggregateType], name: mutation.aggregateId };
}

/** Exact local queued-at time for the row's `title` hover (mirrors
 *  `RestoreSnapshotModal.formatAbsolute`'s shape). */
function queuedAtTitle(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Resolve each mutation's human label async from local IndexedDB (throw-safe,
 * raw-id fallback), display-only (never logged). Shared by the inspector list
 * and the warn-before-discard list. Prunes labels for since-applied ids so the
 * Map can't grow unbounded, resolves only not-yet-known ids (immutable
 * type+id → never re-resolve), and cancels a settling promise after unmount /
 * a row-set change. The caller passes a MEMOIZED array so the effect keys on a
 * stable identity, not every render.
 */
function useResolvedLabels(
  mutations: readonly PendingMutation[],
): Map<string, ResolvedMutationLabel> {
  const [labels, setLabels] = useState<Map<string, ResolvedMutationLabel>>(() => new Map());
  // Mirror the latest resolved labels so the resolve effect can skip ids it has
  // already resolved without listing `labels` as a dep (which would restart the
  // async loop on every per-row setState).
  const labelsRef = useRef(labels);
  useEffect(() => {
    labelsRef.current = labels;
  }, [labels]);

  useEffect(() => {
    let cancelled = false;
    const ids = new Set(mutations.map((m) => m.id));
    // Prune labels for mutations no longer listed (applied / cleared) so the Map
    // can't grow unbounded and a stale label can't render for a since-applied
    // mutation.
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
        // A promise settling after unmount, or after the row set changed, must
        // not write state.
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

  // Resolve-control state. One in-flight resolve at a time (keeps the queue
  // writes serial and the UI legible); a per-row error/status note.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyChoice, setBusyChoice] = useState<'keep' | 'discard' | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  // The conflict awaiting the warn-before-discard confirmation (dialog open when
  // non-null).
  const [discardTarget, setDiscardTarget] = useState<PendingMutation | null>(null);
  // The id whose discard was attempted but the aggregate did not converge (the
  // wedge): `resolveConflict` leaves it parked, so the row persists and this
  // surfaces the "try keep, or Reload" note (the row is only rendered while it is
  // still a conflict — a converged discard removes it, so the note never lingers).
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
      // Discard resolves void on both outcomes: a converged discard removes the
      // row (so this note never renders), a wedge leaves it parked (row persists
      // → surface the recovery hint). No new engine behaviour is invented.
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

  // Empty input → render nothing (disabled / no-conflict workspaces stay
  // byte-identical). The confirm dialog only opens from a conflict row, so it
  // can't be stranded by this early return.
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
            // Legacy conflict parked before the resolve feature shipped: no
            // server version was persisted, so keep/discard can't re-base yet —
            // disable until Check & repair rehydrates it.
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
                    {/* a11y: the visible text is the same generic verb on every
                     *  row, so compose each button's accessible NAME from the
                     *  row's already-resolved type + name — a screen-reader user
                     *  navigating by control can then tell which stuck item each
                     *  acts on. Display-only, same content as the visible row
                     *  text (never logged), and `label` already falls back to the
                     *  raw id when the name is unresolved. */}
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
 * Names each un-synced edit a discard would drop, for the warn-before-discard
 * copy on the global "Reload from server" confirm (WorkspaceToolsCard). Resolves
 * each label async from local IndexedDB (display-only, never logged) and renders
 * a compact list: "<type> <name> — <what it was>" inside a named, keyboard-
 * focusable scroll region (`role="region"` + a content-describing `aria-label` +
 * `tabIndex={0}` + focus ring, mirroring `TableScroll` / the sync inspector
 * list) so a long, height-capped list stays reachable by keyboard. Renders
 * nothing for an empty list, so a zero-unsynced Reload dialog reads exactly as
 * it did before.
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
