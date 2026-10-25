/**
 * "Restore previous version" modal: pick an S3 snapshot, then confirm a destructive rollback of server and local
 * state.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CheckIcon, HistoryIcon } from './icons';
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import type { Selection } from 'react-aria-components';
import { Modal } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { TableScroll } from './TableScroll';
import { Alert } from './Alert';
import { Muted } from './Muted';
import { LoadingState } from './Skeleton';
import { useSync } from '../sync/SyncContext';
import { useAuth } from '../auth/AuthContext';
import type { SnapshotListItem } from '../sync/types';
import { btnDangerClass, btnSecondaryClass } from './dialog-chrome';
import { tableClass, thStickyClass, tdClass } from '../pages/profile-page-chrome';

interface RestoreSnapshotModalProps {
  open: boolean;
  onClose: () => void;
}

const rowClass =
  'cursor-pointer outline-none transition-colors ' +
  'data-[hovered]:bg-surface-sunken ' +
  'data-[selected]:bg-pretax-subtle data-[selected]:font-medium ' +
  'data-[focus-visible]:ring-2 data-[focus-visible]:ring-inset ' +
  'data-[focus-visible]:ring-ring';

const selectMarkClass = `${tdClass} w-8 text-center font-semibold text-accent-link`;

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatRelative(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const diffSec = Math.round((then - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return rtf.format(Math.round(diffSec), 'second');
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  return rtf.format(Math.round(diffSec / 86400), 'day');
}

export const RestoreSnapshotModal: React.FC<RestoreSnapshotModalProps> = ({
  open,
  onClose,
}) => {
  const { listSnapshots, restoreSnapshot } = useSync();
  const { recacheHdk } = useAuth();
  const [loading, setLoading] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // Reload the list on each open and reset transient state so a re-open starts clean.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSelectedId(null);
    setError(null);
    setConfirming(false);
    // Clear the prior list so a failed or in-flight reload never offers a stale snapshot.
    setSnapshots([]);
    setLoading(true);
    void (async () => {
      try {
        const items = await listSnapshots();
        if (!cancelled) setSnapshots(items);
      } catch {
        if (!cancelled) {
          setSnapshots([]);
          setError('Could not load your previous versions. Please try again.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, listSnapshots]);

  const onSelectionChange = useCallback((keys: Selection) => {
    if (keys === 'all') return;
    const first = keys.values().next().value;
    setSelectedId(first === undefined ? null : String(first));
  }, []);

  const selected = snapshots.find((s) => s.snapshotId === selectedId) ?? null;

  const onConfirmRestore = useCallback(async () => {
    if (restoring) return;
    if (!selectedId) return;
    setRestoring(true);
    setError(null);
    try {
      const result = await restoreSnapshot(selectedId);
      if (!result.ok) {
        // If local data was already wiped a reload is the recovery path (SyncContext's cursor-reset
        // invariant); surface the failure either way.
        setError(
          result.wiped
            ? 'Restore started but the refresh did not finish. Reload the page to continue.'
            : 'Could not restore this version. Please try again.',
        );
        setConfirming(false);
        return;
      }
      // Restore dropped the device key cache but the in-memory HDK survives; re-cache it so the
      // next refresh does not prompt for the password. Best-effort, so a failure must not flip the
      // success path.
      try {
        await recacheHdk();
      } catch {
      }
      setConfirming(false);
      onClose();
    } catch {
      setError('Could not restore this version. Please try again.');
      setConfirming(false);
    } finally {
      setRestoring(false);
    }
  }, [restoring, selectedId, restoreSnapshot, recacheHdk, onClose]);

  return (
    <>
      <Modal open={open} onClose={onClose} title="Restore previous version" size="2xl">
        <Muted as="p" className="mb-3 text-sm">
          Pick a saved version of your workspace to restore. Restoring
          replaces everything currently on this device with that version.
        </Muted>

        {error && (
          <Alert tone="error" className="mb-3">
            {error}
          </Alert>
        )}

        {loading ? (
          <LoadingState
            label="Loading previous versions…"
            variant="rows"
            className="py-2"
          />
        ) : snapshots.length === 0 ? (
          <Muted as="p" className="py-6 text-center text-sm">
            No previous versions are available yet. Versions are saved
            automatically about once an hour.
          </Muted>
        ) : (
          <TableScroll label="Available previous versions">
            <Table
              aria-label="Available previous versions"
              className={tableClass}
              selectionMode="single"
              selectionBehavior="toggle"
              selectedKeys={selectedId ? [selectedId] : []}
              onSelectionChange={onSelectionChange}
            >
              <TableHeader>
                <Column className={`${thStickyClass} w-8`} aria-label="Selected" />
                <Column isRowHeader className={thStickyClass}>
                  When
                </Column>
                <Column className={thStickyClass}>Date &amp; time</Column>
              </TableHeader>
              <TableBody>
                {snapshots.map((s) => (
                  <Row key={s.snapshotId} id={s.snapshotId} className={rowClass}>
                    <Cell className={selectMarkClass} aria-hidden="true">
                      {s.snapshotId === selectedId ? (
                        <span className="inline-flex justify-center">
                          <CheckIcon />
                        </span>
                      ) : null}
                    </Cell>
                    <Cell className={tdClass}>{formatRelative(s.timestamp)}</Cell>
                    <Cell className={`${tdClass} font-mono tabular-nums`}>
                      {formatAbsolute(s.timestamp)}
                    </Cell>
                  </Row>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        )}

        <div className="mt-4 flex justify-start gap-3">
          <button
            type="button"
            className={btnDangerClass}
            disabled={!selectedId || loading || restoring}
            onClick={() => setConfirming(true)}
          >
            Restore
          </button>
          <button type="button" className={btnSecondaryClass} onClick={onClose}>
            Cancel
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirming}
        size="lg"
        title="Restore this version?"
        message={
          <>
            All changes since{' '}
            <strong>{selected ? formatAbsolute(selected.timestamp) : 'this version'}</strong>{' '}
            (including any pending edits on this device) will be
            permanently lost. This cannot be undone.
            <span className="mt-2 block">
              If you&rsquo;ve changed your password since this version was saved,
              you may need your recovery key to unlock your data after restoring.
            </span>
          </>
        }
        confirmLabel={restoring ? 'Restoring…' : 'Restore'}
        confirmIcon={<HistoryIcon />}
        cancelLabel="Cancel"
        onConfirm={() => void onConfirmRestore()}
        onCancel={() => {
          if (restoring) return;
          setConfirming(false);
        }}
      />
    </>
  );
};
