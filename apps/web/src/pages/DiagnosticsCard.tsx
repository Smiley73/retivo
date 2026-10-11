/**
 * Workspace page: Diagnostics card.
 *
 * On-device debugging surface. Three actions: Export diagnostics (a separate
 * gzipped `.json.gz` download, never synced), View recent activity (a
 * read-only modal that RE-QUERIES the IDB store on open, no aggregate
 * signal subscription), and Clear (a destructive confirm that empties both the
 * in-memory rings and the persisted store). The card carries the
 * on-device / "may contain personal data" note: diagnostics never leave
 * the device except by the explicit Export download, and gzip is not
 * encryption.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';
import { Modal } from '../components/Modal';
import { Muted } from '../components/Muted';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Alert } from '../components/Alert';
import { RepoLink } from '../components/RepoLink';
import { listDiagnosticLogs } from '../db/store';
import { clearAll as clearAllDiagnostics } from '../lib/diagnostics/logger';
import { exportDiagnostics } from '../lib/diagnostics/export';
import { useSync } from '../sync/SyncContext';
import {
  KEEP_BTN_COLORS,
  RESOLVE_BTN_BASE,
  UnsyncedMutationList,
} from '../sync/UnsyncedMutationList';
import type {
  DiagnosticEntry,
  DiagnosticLevel,
} from '../lib/diagnostics/logger';
import {
  SettingsCard,
  SuccessNotice,
  btnPrimarySmClass,
  btnSecondarySmClass,
  btnDangerSmClass,
  DownloadIcon,
  HistoryIcon,
  TrashIcon,
} from './profile-page-chrome';

interface Props {
  /** Current household id (null while booting) — stamped into the export. */
  householdId: string | null;
  /** Account email (unused today; kept for parity with the sibling cards). */
  email: string;
}

/** Tailwind text token per level so the chip reads at a glance. */
const LEVEL_TONE: Record<DiagnosticLevel, string> = {
  error: 'text-negative',
  warn: 'text-warning',
  info: 'text-muted',
  log: 'text-muted',
};

/** Full local date + time (with seconds) for an activity row's captured
 *  `ts`. Guards an unparseable `ts` by returning it raw rather than
 *  rendering "Invalid Date". Omits the year (recent diagnostics rarely
 *  cross a year boundary). */
function formatActivityTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** One viewer row: level chip + time + namespace + message, with an
 *  expandable redacted `detail` behind a React Aria Disclosure (never a raw
 *  <details>). Read-only, monospace detail. */
const ActivityRow: React.FC<{ entry: DiagnosticEntry }> = ({ entry }) => {
  const time = formatActivityTime(entry.ts);
  return (
    <li className="border-b border-line py-2 text-sm last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className={`font-semibold uppercase ${LEVEL_TONE[entry.level]}`}>
          {entry.level}
        </span>
        <span className="font-mono text-xs text-muted tabular-nums">{time}</span>
        {entry.namespace && (
          <span className="text-xs text-accent">[{entry.namespace}]</span>
        )}
        <span className="min-w-0 break-words text-ink">{entry.message}</span>
      </div>
      {entry.detail && (
        <Disclosure className="mt-1">
          <Heading className="m-0">
            <Button
              slot="trigger"
              className="text-xs text-accent-link underline underline-offset-2 outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring"
            >
              Details
            </Button>
          </Heading>
          <DisclosurePanel>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded border border-line bg-surface-sunken p-2 font-mono text-xs text-muted">
              {entry.detail}
            </pre>
          </DisclosurePanel>
        </Disclosure>
      )}
    </li>
  );
};

export const DiagnosticsCard: React.FC<Props> = ({ householdId }) => {
  // Defensive `?? []` reads so a partial `useSync` mock / mid-mount context
  // can't crash the render (this card is mounted via object-literal mocks in
  // the WorkspacePage tests that omit these arrays).
  const { pendingMutations, conflictMutations, failedErrorMutations, resolveConflict, checkAndRepair } =
    useSync();
  const pending = pendingMutations ?? [];
  const conflicts = conflictMutations ?? [];
  const failedErrors = failedErrorMutations ?? [];
  const hasUnsynced = pending.length + conflicts.length + failedErrors.length > 0;

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [entries, setEntries] = useState<DiagnosticEntry[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [repairing, setRepairing] = useState(false);

  // One-time short timezone abbreviation (e.g. "PST") for the recent-activity
  // note; omitted from the note when the runtime can't resolve one.
  const tzLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value,
    [],
  );

  // Re-query IDB, sorted by capture time (`ts`), newest first, `seq`
  // tiebreak. Used on viewer open + after a Clear success.
  // Read-only; no aggregate-signal subscription (wrong layer). An
  // unparseable `ts` sorts oldest rather than poisoning the comparator.
  const loadEntries = useCallback(async (): Promise<void> => {
    try {
      const rows = (await listDiagnosticLogs()) as unknown as DiagnosticEntry[];
      const sorted = [...rows].sort((a, b) => {
        const ta = new Date(a.ts).getTime();
        const tb = new Date(b.ts).getTime();
        return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta) || b.seq - a.seq;
      });
      setEntries(sorted);
    } catch {
      setEntries([]);
    }
  }, []);

  const onExport = useCallback(async () => {
    setError(null);
    try {
      await exportDiagnostics(householdId ?? undefined);
      setNotice('Diagnostics file downloaded.');
    } catch {
      setError('Could not export diagnostics. Please try again.');
    }
  }, [householdId]);

  const onView = useCallback(async () => {
    setError(null);
    await loadEntries();
    setViewerOpen(true);
  }, [loadEntries]);

  const onClearConfirm = useCallback(async () => {
    setClearing(true);
    setError(null);
    try {
      await clearAllDiagnostics();
      setConfirmClear(false);
      setNotice('Diagnostics cleared.');
      // Re-query so an open viewer reflects the now-empty store.
      await loadEntries();
    } catch {
      setError('Could not clear diagnostics. Please try again.');
    } finally {
      setClearing(false);
    }
  }, [loadEntries]);

  // Check & repair: re-drive the auto-repair pass over every parked conflict
  // (re-queue each with a fresh id → flush). Silently clears a since-fixed
  // conflict and rehydrates a legacy row's server facts so its keep/discard
  // unlocks; anything still a real-choice conflict stays for the per-row
  // keep/discard below. Best-effort — a transport hiccup surfaces the badge, so
  // no per-item error is duplicated here.
  const onCheckAndRepair = useCallback(async () => {
    // Defensive: a partial `useSync` mock (WorkspacePage-style object literal)
    // may omit `checkAndRepair` even though the real context always provides it.
    if (typeof checkAndRepair !== 'function') return;
    setError(null);
    setRepairing(true);
    try {
      await checkAndRepair();
    } catch {
      setError('Could not check and repair sync. Please try again.');
    } finally {
      setRepairing(false);
    }
  }, [checkAndRepair]);

  return (
    <>
      <SettingsCard
        title="Diagnostics"
        subtitle={
          <>
            Recent errors and activity are saved on this device so you can
            review them or download a file for your own records. Nothing is sent
            anywhere automatically.
          </>
        }
      >
        {error && (
          <Alert tone="error" className="mb-3">
            {error}
          </Alert>
        )}
        {notice && <SuccessNotice>{notice}</SuccessNotice>}

        <div className="flex flex-col">
          {/* eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock .kv 13.5px */}
          <div className="flex items-center justify-between gap-3 border-b border-line py-2.5 text-[13.5px]">
            <span className="text-ink">Export diagnostics</span>
            <button
              type="button"
              className={`${btnPrimarySmClass} min-w-24 gap-1.5`}
              onClick={() => void onExport()}
              aria-label="Export diagnostics"
            >
              <DownloadIcon />
              Export
            </button>
          </div>
          {/* eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock .kv 13.5px */}
          <div className="flex items-center justify-between gap-3 border-b border-line py-2.5 text-[13.5px]">
            <span className="text-ink">View recent activity</span>
            <button
              type="button"
              className={`${btnSecondarySmClass} min-w-24 gap-1.5`}
              onClick={() => void onView()}
              aria-label="View recent activity"
            >
              <HistoryIcon />
              View
            </button>
          </div>
          {/* eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock .kv 13.5px */}
          <div className="flex items-center justify-between gap-3 py-2.5 text-[13.5px]">
            <span className="text-ink">Clear diagnostics</span>
            <button
              type="button"
              className={`${btnDangerSmClass} min-w-24 gap-1.5`}
              onClick={() => setConfirmClear(true)}
              disabled={clearing}
              aria-label="Clear diagnostics"
            >
              <TrashIcon />
              {clearing ? 'Clearing…' : 'Clear'}
            </button>
          </div>
        </div>

        {hasUnsynced && (
          <Disclosure className="mt-3">
            <Heading className="m-0">
              <Button
                slot="trigger"
                className="text-xs text-accent-link underline underline-offset-2 outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring"
              >
                Show unsynced items
              </Button>
            </Heading>
            <DisclosurePanel>
              <div className="mt-2 flex flex-col gap-2">
                {conflicts.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      onPress={() => void onCheckAndRepair()}
                      isDisabled={repairing}
                      // Shared secondary-button look (single-sourced with the
                      // list's Keep control) + this card's looser px-2.5 py-1.
                      className={`${RESOLVE_BTN_BASE} px-2.5 py-1 ${KEEP_BTN_COLORS}`}
                    >
                      {repairing ? 'Checking…' : 'Check & repair'}
                    </Button>
                    <span className="text-xs text-muted">
                      Tries to clear stuck items automatically; anything needing your
                      call keeps its Keep/Discard buttons below.
                    </span>
                  </div>
                ) : null}
                <UnsyncedMutationList
                  pending={pending}
                  conflicts={conflicts}
                  failedErrors={failedErrors}
                  resolveConflict={resolveConflict}
                />
              </div>
            </DisclosurePanel>
          </Disclosure>
        )}

        <Muted as="p" className="mt-3 mb-0 text-xs">
          Diagnostics stay on this device and may contain personal data. The
          downloaded file is not encrypted, so never attach it to a public
          issue. Describe what happened instead: <RepoLink kind="issue" />.
        </Muted>
      </SettingsCard>

      <Modal
        open={viewerOpen}
        onClose={() => setViewerOpen(false)}
        title="Recent activity"
        size="3xl"
        scrollBodyLabel="Recent diagnostic activity"
      >
        {entries.length === 0 ? (
          <Muted as="p" className="mt-0">
            No diagnostics recorded yet.
          </Muted>
        ) : (
          <>
            <Muted as="p" className="mt-0 mb-3 text-xs">
              Times are shown in your timezone{tzLabel ? ` (${tzLabel})` : ''}.
            </Muted>
            <ul className="m-0 list-none p-0">
              {entries.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))}
            </ul>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmClear}
        size="lg"
        title="Clear diagnostics?"
        message="This permanently removes the saved errors and activity from this device. It does not affect your account or your workspace data."
        confirmLabel={clearing ? 'Clearing…' : 'Clear diagnostics'}
        cancelLabel="Cancel"
        onConfirm={() => void onClearConfirm()}
        onCancel={() => {
          if (clearing) return;
          setConfirmClear(false);
        }}
      />
    </>
  );
};
