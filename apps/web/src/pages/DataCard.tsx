/**
 * Workspace page: Data card (export / import / restore).
 *
 * Owns the standalone export re-auth gate (export requires a password on every
 * click — a full-household download is never silent), the five-modal import
 * pipeline (unknown-types → cross-household → password → confirm → result), and
 * the Restore-previous-version modal. The export verify+download primitive is
 * shared with the delete-account flow via `useProfileExport`. Self-sources auth
 * + sync from `useAuth` / `useSync`.
 */
import React, { useCallback, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { ApiRequestError } from '../api/client';
import {
  isRollbackDetectedRejection,
  notifyRollbackDetectedOutsideSync,
} from '../sync/error-detail';
import { describe as describeSyncState } from '../sync/badge-format';
import { Alert } from '../components/Alert';
import { RepoLink } from '../components/RepoLink';
import { Modal } from '../components/Modal';
import { Muted } from '../components/Muted';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { RestoreSnapshotModal } from '../components/RestoreSnapshotModal';
import { listPendingMutations } from '../db/store';
import { DEV_DEFAULT_PASSWORD } from '../lib/dev-credentials';
import { type ExportBundle } from '../lib/data-export';
import {
  DataImportError,
  applyImport,
  parseImportFile,
  validateBundle,
  type ApplyImportResult,
  type DataImportErrorCode,
} from '../lib/data-import';
import { useProfileExport } from './use-profile-export';
import {
  SettingsCard,
  SuccessNotice,
  PasswordPromptModal,
  btnPrimaryClass,
  btnSecondaryClass,
  btnDangerClass,
  btnPrimarySmClass,
  btnSecondarySmClass,
  DownloadIcon,
  UploadIcon,
  HistoryIcon,
} from './profile-page-chrome';

const IMPORT_ERROR_HINTS: Record<DataImportErrorCode, React.ReactNode> = {
  MALFORMED_BUNDLE: 'File is not a retirement export, or is corrupted.',
  BUNDLE_VERSION_UNSUPPORTED: 'This file was created by a newer version of the app. Update the app and try again.',
  AGGREGATE_VERSION_UNSUPPORTED: 'This file contains data from a newer version of the app. Update the app and try again.',
  BUNDLE_TOO_LARGE: (
    <>
      File exceeds the import size limit. Confirm the file came from this app,
      and <RepoLink kind="issue" /> if a legitimate export is being rejected.
      Describe what happened; never attach or paste the export, because it
      holds your financial data.
    </>
  ),
  BUNDLE_FORBIDDEN_KEY: 'File contains object keys that this app rejects for safety reasons. Confirm the file came from this app.',
  BUNDLE_TOO_DEEP: 'File nesting is too deep for the importer. Confirm the file came from this app.',
  BUNDLE_OBJECT_TOO_WIDE: 'File contains an object with too many keys. Confirm the file came from this app.',
  BUNDLE_ARRAY_TOO_LONG: 'File contains an array that exceeds the importer’s safe limit. Confirm the file came from this app.',
};

interface Props {
  /** Current household id (null while booting). */
  householdId: string | null;
  /** Account email for the password re-auth prompt's hidden username. */
  email: string;
  /** Page-level error sink (single top-of-page Alert). */
  onError: (message: string | null) => void;
}

export const DataCard: React.FC<Props> = ({ householdId, email, onError }) => {
  const { verifyPassword } = useAuth();
  const { notifyPending, syncRoundTrip } = useSync();
  const { verifyForExport, downloadExport } = useProfileExport();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);
  // Count of unresolved local-change records included in the last export;
  // > 0 tells the user their file merged
  // unsynced local changes over the server copy and keeps both variants, so it
  // is worth retaining even after an import.
  const [exportUnresolvedCount, setExportUnresolvedCount] = useState(0);
  // Export re-auth modal. Mirrors the
  // import-password pattern: the gate prompts on every "Export my data"
  // click and only runs the export after a successful verifyPassword.
  const [exportPassword, setExportPassword] = useState(false);
  const [exportPasswordValue, setExportPasswordValue] = useState('');
  const [exportPasswordError, setExportPasswordError] = useState<string | null>(null);
  const [exportPasswordVerifying, setExportPasswordVerifying] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<React.ReactNode>(null);
  const [importSuccess, setImportSuccess] = useState<ApplyImportResult | null>(null);
  // Self-service "Restore previous version" modal.
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [unknownPrompt, setUnknownPrompt] = useState<{
    bundle: ExportBundle;
    unknownTypes: Array<{ type: string; count: number }>;
  } | null>(null);
  const [crossHouseholdPrompt, setCrossHouseholdPrompt] = useState<{
    bundle: ExportBundle;
  } | null>(null);
  const [importPassword, setImportPassword] = useState<{
    bundle: ExportBundle;
  } | null>(null);
  const [importPasswordValue, setImportPasswordValue] = useState('');
  const [importPasswordError, setImportPasswordError] = useState<string | null>(null);
  const [importPasswordVerifying, setImportPasswordVerifying] = useState(false);
  const [importConfirm, setImportConfirm] = useState<{
    bundle: ExportBundle;
    pendingCount: number;
  } | null>(null);

  const onExportClick = useCallback(() => {
    if (!householdId) return;
    onError(null);
    setExportSuccess(false);
    // Mirror the import/demo local-dev prefill (DEV_DEFAULT_PASSWORD is empty
    // off a local-dev build, so this is blank on every real deployment).
    setExportPasswordValue(DEV_DEFAULT_PASSWORD);
    setExportPasswordError(null);
    setExportPassword(true);
  }, [householdId, onError]);

  const closeExportPasswordModal = useCallback(() => {
    if (exportPasswordVerifying) return;
    setExportPassword(false);
    setExportPasswordValue('');
    setExportPasswordError(null);
  }, [exportPasswordVerifying]);

  const onExportPasswordContinue = useCallback(async () => {
    // Re-entrancy guard: onEnter can fire while a verify+export is already in
    // flight (rapid Enter presses), which would double-verify and double-export.
    if (exportPasswordVerifying) return;
    if (!householdId || !exportPasswordValue) return;
    setExportPasswordError(null);
    setExportPasswordVerifying(true);
    try {
      const accessToken = await verifyForExport(exportPasswordValue);
      // Re-auth passed: tear down the modal, then run the existing export.
      setExportPassword(false);
      setExportPasswordValue('');
      setExporting(true);
      try {
        const { unresolvedCount } = await downloadExport(householdId, accessToken);
        setExportUnresolvedCount(unresolvedCount);
        setExportSuccess(true);
        setTimeout(() => setExportSuccess(false), 8000);
      } catch (err) {
        // The forced-export transport (`createExportSyncTransport`) runs its
        // own bootstrap()/pull() outside SyncProvider's poll, so a
        // rollback-detected rejection (a served payload
        // that isn't sealed with this household's key, or a tampered
        // freshness head) never reaches SyncProvider's error handling on its
        // own. Detect it here, flip the shared sync badge via the same hook
        // SyncProvider registers, and show the SAME non-retry tamper
        // explanation the badge shows — a plain "try again" would be wrong:
        // retrying reaches the same compromised/out-of-date server state.
        if (isRollbackDetectedRejection(err)) {
          notifyRollbackDetectedOutsideSync();
          onError(describeSyncState({ kind: 'rollback-detected' }));
        } else {
          onError('Failed to export data. Please try again.');
        }
      } finally {
        setExporting(false);
      }
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setExportPasswordError(err.error.message);
      } else {
        setExportPasswordError('Failed to verify password. Please try again.');
      }
    } finally {
      setExportPasswordVerifying(false);
    }
  }, [
    householdId,
    exportPasswordValue,
    exportPasswordVerifying,
    verifyForExport,
    downloadExport,
    onError,
  ]);

  const promptForImportPassword = useCallback((bundle: ExportBundle) => {
    // Mirror the local-dev prefill (see lib/dev-credentials.ts for the
    // build-mode + local-host gate): seed the dev user's password so devs
    // don't re-type credentials on every workspace reset.
    // `DEV_DEFAULT_PASSWORD` is empty off a local-dev build, so this is
    // blank on every real deployment.
    setImportPasswordValue(DEV_DEFAULT_PASSWORD);
    setImportPasswordError(null);
    setImportPassword({ bundle });
  }, []);

  // Stage the next modal in the import flow given a validated bundle.
  // Cross-household bundles get an extra warning before the password
  // step; same-household bundles go straight to the password modal.
  const advanceAfterValidation = useCallback(
    (bundle: ExportBundle) => {
      if (householdId && bundle.householdId !== householdId) {
        setCrossHouseholdPrompt({ bundle });
      } else {
        promptForImportPassword(bundle);
      }
    },
    [householdId, promptForImportPassword],
  );

  const onImportClick = useCallback(() => {
    setImportError(null);
    setImportSuccess(null);
    fileInputRef.current?.click();
  }, []);

  const onImportFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!householdId) return;
      const file = e.target.files?.[0];
      // Reset the input value so re-selecting the same file fires
      // change again. The filesystem reference is captured above.
      if (e.target) e.target.value = '';
      if (!file) return;
      try {
        const parsed = await parseImportFile(file);
        const { bundle, unknownTypes } = validateBundle(parsed);
        if (unknownTypes.length > 0) {
          setUnknownPrompt({ bundle, unknownTypes });
        } else {
          advanceAfterValidation(bundle);
        }
      } catch (err) {
        if (err instanceof DataImportError) {
          setImportError(IMPORT_ERROR_HINTS[err.code]);
        } else {
          setImportError('Failed to read file.');
        }
      }
    },
    [householdId, advanceAfterValidation],
  );

  const onUnknownContinue = useCallback(() => {
    if (!unknownPrompt) return;
    const bundle = unknownPrompt.bundle;
    setUnknownPrompt(null);
    advanceAfterValidation(bundle);
  }, [unknownPrompt, advanceAfterValidation]);

  const onCrossHouseholdContinue = useCallback(() => {
    if (!crossHouseholdPrompt) return;
    const bundle = crossHouseholdPrompt.bundle;
    setCrossHouseholdPrompt(null);
    promptForImportPassword(bundle);
  }, [crossHouseholdPrompt, promptForImportPassword]);

  const closeImportPasswordModal = useCallback(() => {
    if (importPasswordVerifying) return;
    setImportPassword(null);
    setImportPasswordValue('');
    setImportPasswordError(null);
  }, [importPasswordVerifying]);

  const onImportPasswordContinue = useCallback(async () => {
    if (!importPassword || !importPasswordValue) return;
    setImportPasswordError(null);
    setImportPasswordVerifying(true);
    try {
      await verifyPassword(importPasswordValue);
      const bundle = importPassword.bundle;
      // Tear down the password modal *before* opening the confirm
      // dialog so they don't briefly stack.
      setImportPassword(null);
      setImportPasswordValue('');
      const pending = await listPendingMutations();
      setImportConfirm({ bundle, pendingCount: pending.length });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setImportPasswordError(err.error.message);
      } else {
        setImportPasswordError('Failed to verify password. Please try again.');
      }
    } finally {
      setImportPasswordVerifying(false);
    }
  }, [importPassword, importPasswordValue, verifyPassword]);

  const onImportConfirm = useCallback(async () => {
    if (!importConfirm || !householdId) return;
    setImporting(true);
    setImportError(null);
    try {
      // Force a sync round-trip before Phase 1 tombstones anything.
      // `applyImport` enumerates local aggregates only; server-side
      // rows the local hasn't pulled yet survive the wipe and
      // reappear on the next pull alongside the imported bundle.
      const sync = await syncRoundTrip();
      if (!sync.ok) {
        setImportError(`Cannot import: ${sync.reason}`);
        setImportConfirm(null);
        return;
      }
      const result = await applyImport(importConfirm.bundle, householdId);
      notifyPending();
      setImportConfirm(null);
      setImportSuccess(result);
      setTimeout(() => setImportSuccess(null), 6000);
    } catch (err) {
      setImportError(
        err instanceof Error
          ? `Failed to import data: ${err.message}`
          : 'Failed to import data.',
      );
      setImportConfirm(null);
    } finally {
      setImporting(false);
    }
  }, [importConfirm, householdId, notifyPending, syncRoundTrip]);

  return (
    <>
      <SettingsCard
        title="Data"
        subtitle="Save a full copy of your data to a file, bring a saved copy back in, or roll your workspace back to an earlier version."
      >
        {importError && (
          <Alert tone="error" className="mb-3">
            {importError}
          </Alert>
        )}
        {exportSuccess && (
          <SuccessNotice>
            Export ready. Check your downloads.
            {exportUnresolvedCount > 0 &&
              ` It includes ${exportUnresolvedCount} change${
                exportUnresolvedCount === 1 ? '' : 's'
              } from this device that hadn't finished syncing, with both the device and server copy of each kept in the file — keep this file even after you import it.`}
          </SuccessNotice>
        )}
        {importSuccess && (
          <SuccessNotice>
            Imported {importSuccess.total} record{importSuccess.total === 1 ? '' : 's'}.
          </SuccessNotice>
        )}
        {/* Mock `.kvs`/`.kv` key/value rows — label-left, action-right,
            hairline divider between — matching the Workspace tools card.
            Replaces the prior row of three competing primary buttons: only
            Export (the most common, safe action) keeps the accent fill; the
            rest are neutral secondary. Each control's accessible name is the
            full action (label + verb) so intent stays clear. */}
        <div className="flex flex-col">
          {/* eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock .kv 13.5px */}
          <div className="flex items-center justify-between gap-3 border-b border-line py-2.5 text-[13.5px]">
            <span className="flex flex-col">
              <span className="text-ink">Export my data</span>
              <span className="text-xs text-muted">
                Your account record, sign-in and security history, and everything else tied to your account, plus your saved data.
              </span>
            </span>
            <button
              type="button"
              className={`${btnPrimarySmClass} min-w-24 gap-1.5`}
              onClick={onExportClick}
              disabled={exporting || !householdId}
              aria-label="Export my data"
            >
              <DownloadIcon />
              {exporting ? 'Exporting…' : 'Export'}
            </button>
          </div>
          {/* eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock .kv 13.5px */}
          <div className="flex items-center justify-between gap-3 border-b border-line py-2.5 text-[13.5px]">
            <span className="flex flex-col">
              <span className="text-ink">Import from file</span>
              <span className="text-xs text-muted">
                Replaces what&apos;s here with a copy you exported earlier.
              </span>
            </span>
            <button
              type="button"
              className={`${btnSecondarySmClass} min-w-24 gap-1.5`}
              onClick={onImportClick}
              disabled={importing || !householdId}
              aria-label="Import from file"
            >
              <UploadIcon />
              {importing ? 'Importing…' : 'Import'}
            </button>
          </div>
          {/* eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock .kv 13.5px */}
          <div className="flex items-center justify-between gap-3 py-2.5 text-[13.5px]">
            <span className="flex flex-col">
              <span className="text-ink">Restore previous version</span>
              <span className="text-xs text-muted">
                Roll your workspace back to an earlier saved snapshot.
              </span>
            </span>
            <button
              type="button"
              className={`${btnSecondarySmClass} min-w-24 gap-1.5`}
              onClick={() => setShowRestoreModal(true)}
              disabled={!householdId}
              aria-label="Restore previous version"
            >
              <HistoryIcon />
              Restore
            </button>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json.gz,.gz,.json,application/gzip,application/json"
          onChange={onImportFileChange}
          className="hidden"
          aria-hidden="true"
        />
      </SettingsCard>

      <PasswordPromptModal
        open={exportPassword}
        onClose={closeExportPasswordModal}
        title="Export your data?"
        intro="This downloads a compressed file with your saved data plus your account record, sign-in and security history, and everything else tied to your account. Short-lived server and storage access logs aren't included. Keep it somewhere private. Enter your password to continue."
        error={exportPasswordError}
        inputId="export-pw"
        value={exportPasswordValue}
        onValueChange={setExportPasswordValue}
        email={email}
        onContinue={onExportPasswordContinue}
        continueLabel={exportPasswordVerifying ? 'Exporting…' : 'Export'}
        continueDisabled={!exportPasswordValue || exportPasswordVerifying}
        cancelDisabled={exportPasswordVerifying}
      />

      <Modal
        open={!!unknownPrompt}
        onClose={() => setUnknownPrompt(null)}
        title="Unknown data types in file"
        size="md"
      >
        <p className="mt-0 text-ink">
          The file contains data types this version of the app doesn&apos;t know about. They&apos;ll be skipped if you continue, which might leave some imported records pointing at things that aren&apos;t there.
        </p>
        {unknownPrompt && (
          <ul className="mb-4 ml-5 list-disc text-ink">
            {unknownPrompt.unknownTypes.map((u) => (
              <li key={u.type}>
                <code className="rounded bg-surface-raised px-1 py-0.5 font-mono text-sm">
                  {u.type}
                </code>: {u.count} record{u.count === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
        )}
        <Muted as="p" className="text-xs">
          Update the app to import these records, or skip and continue without them.
        </Muted>
        {/* Left-aligned, primary first — AGENTS modal rule. */}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          {/* Benign: skipping unknown data types and proceeding with the
              import the user already chose is recoverable, not destructive. */}
          <button type="button" className={btnPrimaryClass} onClick={onUnknownContinue}>
            Skip and continue
          </button>
          <button
            type="button"
            className={btnSecondaryClass}
            onClick={() => setUnknownPrompt(null)}
          >
            Cancel
          </button>
        </div>
      </Modal>

      <Modal
        open={!!crossHouseholdPrompt}
        onClose={() => setCrossHouseholdPrompt(null)}
        title="File is from a different account"
        size="md"
      >
        <p className="mt-0 text-ink">
          This export was created under a different household than the one you&apos;re signed in to. Importing will reassign every record in the file to your account.
        </p>
        <Muted as="p" className="text-xs">
          The original household id stays in the file but is overwritten on this device. The next sync push will register the data under your account on the server.
        </Muted>
        {/* Left-aligned, primary first — AGENTS modal rule. */}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={btnDangerClass}
            onClick={onCrossHouseholdContinue}
          >
            Reassign and continue
          </button>
          <button
            type="button"
            className={btnSecondaryClass}
            onClick={() => setCrossHouseholdPrompt(null)}
          >
            Cancel
          </button>
        </div>
      </Modal>

      <PasswordPromptModal
        open={!!importPassword}
        onClose={closeImportPasswordModal}
        title="Confirm with your password"
        intro="Importing will replace all your data on this device. Enter your password to continue."
        error={importPasswordError}
        inputId="import-pw"
        value={importPasswordValue}
        onValueChange={setImportPasswordValue}
        email={email}
        onContinue={onImportPasswordContinue}
        continueLabel={importPasswordVerifying ? 'Verifying…' : 'Continue'}
        continueDisabled={!importPasswordValue || importPasswordVerifying}
        cancelDisabled={importPasswordVerifying}
      />

      <ConfirmDialog
        open={!!importConfirm}
        size="lg"
        title="Replace workspace with file contents?"
        message={
          importConfirm
            ? `This replaces all your data on this device with the file's contents. Anything you've changed but haven't synced yet will be lost.${
                importConfirm.pendingCount > 0
                  ? ` You have ${importConfirm.pendingCount} unsynced edit${importConfirm.pendingCount === 1 ? '' : 's'} that will be discarded.`
                  : ''
              }`
            : ''
        }
        confirmLabel={importing ? 'Importing…' : 'Replace and import'}
        confirmIcon={<UploadIcon />}
        cancelLabel="Cancel"
        onConfirm={onImportConfirm}
        onCancel={() => {
          if (importing) return;
          setImportConfirm(null);
        }}
      />

      <RestoreSnapshotModal
        open={showRestoreModal}
        onClose={() => setShowRestoreModal(false)}
      />
    </>
  );
};
