/** Workspace tools card: demo load, reload from server, clear this device, and server-authoritative workspace delete. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Checkbox } from 'react-aria-components';
import { useAuth, type DeviceClearAttempt } from '../auth/AuthContext';
import { useSync, WorkspaceClearCleanupError } from '../sync/SyncContext';
import { UnsyncedEditsWarningList } from '../sync/UnsyncedMutationList';
import { ApiRequestError } from '../api/client';
import { SyncApiError } from '../sync/sync-client';
import { Alert } from '../components/Alert';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  clearAllStores,
  listAggregates,
  readKeyCacheEntry,
  writeKeyCacheEntry,
} from '../db/store';
import type { AggregateType } from '../db/types';
import { clearAllLocalData } from '../lib/local-data';
import { bannerDismissedKey, bannerPendingKey } from '../components/HouseholdReadyBanner';
import { DEV_DEFAULT_PASSWORD } from '../lib/dev-credentials';
import {
  DemoDataExistsError,
  loadDemoData,
  wipeWorkspaceForDemoReload,
} from '../lib/demo-data-loader';
import {
  WORKSPACE_HISTORY_NOT_ERASED_KEY,
  WORKSPACE_NOTICE_KEY,
  clearReloadFromServerLocalCaches,
} from './profile-page-shared';
import {
  SettingsCard,
  SuccessNotice,
  PasswordPromptModal,
  btnPrimarySmClass,
  btnSecondarySmClass,
  btnDangerSmClass,
  SparklesIcon,
  RefreshIcon,
  TrashIcon,
} from './profile-page-chrome';

const COUNTED_AGGREGATE_TYPES: readonly AggregateType[] = [
  'account',
  'accountBalance',
  'socialSecurityBenefit',
  'householdMember',
  'scenario',
  'expense',
  'expenseCategory',
  'incomeStream',
];

// A reload after a failed clearAllStores() would show the deleted aggregates: the cursor is already '0', so bootstrap won't re-wipe.
const LOCAL_WIPE_ATTEMPTS = 3;
const LOCAL_WIPE_RETRY_MS = 60;

// Server clear committed but local cleanup could not finish: never show the pre-commit "couldn't delete" copy or reload; Delete again retries.
const LOCAL_CLEANUP_INCOMPLETE_MESSAGE =
  "Your workspace data was deleted from our servers, but we couldn't finish clearing it from this device. To remove it here, use the Clear data on this device button, or try Delete again.";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Props {
  /** Current household id (null while booting). */
  householdId: string | null;
  /** Account email for the password re-auth prompts' hidden username. */
  email: string;
  /** Signed-in member display info (demo loader needs email + display name). */
  me: { email: string; displayName: string } | null;
}

export const WorkspaceToolsCard: React.FC<Props> = ({ householdId, email, me }) => {
  const { verifyPassword, signOutForDeviceClear, recacheHdk } = useAuth();
  const {
    notifyPending,
    syncRoundTrip,
    forceRefresh,
    runDestructive,
    clearWorkspace,
    pendingMutations,
    conflictMutations,
    failedErrorMutations,
  } = useSync();
  const unsyncedEdits = useMemo(
    () => [
      ...(conflictMutations ?? []),
      ...(failedErrorMutations ?? []),
      ...(pendingMutations ?? []),
    ],
    [conflictMutations, failedErrorMutations, pendingMutations],
  );

  const [confirmLoadDemo, setConfirmLoadDemo] = useState<
    null | { willOverwrite: boolean; stage: 'first' | 'second' }
  >(null);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [demoPasswordOpen, setDemoPasswordOpen] = useState(false);
  const [demoPasswordValue, setDemoPasswordValue] = useState('');
  const [demoPasswordError, setDemoPasswordError] = useState<string | null>(null);
  const [demoPasswordVerifying, setDemoPasswordVerifying] = useState(false);
  const [resetPasswordOpen, setResetPasswordOpen] = useState(false);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [resetPasswordError, setResetPasswordError] = useState<string | null>(null);
  const [resetPasswordVerifying, setResetPasswordVerifying] = useState(false);
  const [resetConfirm, setResetConfirm] = useState<{ total: number } | null>(null);
  // Default off: the clear stays undoable via Restore previous version; on, the S3 backups are purged irreversibly.
  const [resetEraseHistory, setResetEraseHistory] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [historyRetryVisible, setHistoryRetryVisible] = useState(false);
  const [retryPasswordOpen, setRetryPasswordOpen] = useState(false);
  const [retryPasswordValue, setRetryPasswordValue] = useState('');
  const [retryPasswordError, setRetryPasswordError] = useState<string | null>(null);
  const [retryPasswordVerifying, setRetryPasswordVerifying] = useState(false);
  const [retryingPurge, setRetryingPurge] = useState(false);
  const [confirmClearLocal, setConfirmClearLocal] = useState(false);
  const [clearingLocal, setClearingLocal] = useState(false);
  const [confirmFullSync, setConfirmFullSync] = useState(false);
  const [fullSyncing, setFullSyncing] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  // Stashed in sessionStorage because the hard reload would tear down the notice before it shows.
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);

  useEffect(() => {
    const stashed = sessionStorage.getItem(WORKSPACE_NOTICE_KEY);
    if (!stashed) return;
    sessionStorage.removeItem(WORKSPACE_NOTICE_KEY);
    setWorkspaceNotice(stashed);
    const t = setTimeout(() => setWorkspaceNotice(null), 5000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (sessionStorage.getItem(WORKSPACE_HISTORY_NOT_ERASED_KEY)) {
      sessionStorage.removeItem(WORKSPACE_HISTORY_NOT_ERASED_KEY);
      setHistoryRetryVisible(true);
    }
  }, []);

  const onLoadDemoClick = useCallback(async () => {
    setWorkspaceError(null);
    const [accounts, members] = await Promise.all([
      listAggregates('account'),
      listAggregates('householdMember'),
    ]);
    const willOverwrite =
      accounts.length > 0 ||
      members.some(
        (m) => !(m as { payload?: { isPrimary?: boolean } }).payload?.isPrimary,
      );
    setConfirmLoadDemo({ willOverwrite, stage: 'first' });
  }, []);

  const onLoadDemoConfirm = useCallback(async () => {
    if (!confirmLoadDemo) return;
    if (confirmLoadDemo.willOverwrite && confirmLoadDemo.stage === 'first') {
      setConfirmLoadDemo(null);
      setDemoPasswordValue(DEV_DEFAULT_PASSWORD);
      setDemoPasswordError(null);
      setDemoPasswordOpen(true);
      return;
    }
    if (!householdId || !me) return;
    setLoadingDemo(true);
    setWorkspaceError(null);
    try {
      if (confirmLoadDemo.willOverwrite) {
        // Sync round-trip before the wipe: rows not yet pulled would otherwise reappear next to the demo set. Abort on failure.
        const sync = await syncRoundTrip();
        if (!sync.ok) {
          setWorkspaceError(`Could not load demo data: ${sync.reason}`);
          setConfirmLoadDemo(null);
          return;
        }
      }
      // Run inside the sync fence so a poll tick cannot flush half-queued wipe/load mutations.
      await runDestructive(async () => {
        if (confirmLoadDemo.willOverwrite) {
          // Queue delete mutations so the cloud copy is wiped too; clearAllStores() only touches IndexedDB.
          await wipeWorkspaceForDemoReload(householdId);
        }
        await loadDemoData({
          householdId,
          email: me.email,
          displayName: me.displayName || me.email,
        });
        setConfirmLoadDemo(null);
        notifyPending();
        // Stash the notice in sessionStorage: the reload tears the component down first.
        sessionStorage.setItem(WORKSPACE_NOTICE_KEY, 'Demo data loaded.');
        window.location.reload();
      });
    } catch (err) {
      if (err instanceof DemoDataExistsError) {
        setWorkspaceError(err.message);
      } else if (err instanceof Error) {
        setWorkspaceError(`Something went wrong loading the demo data: ${err.message}`);
      } else {
        setWorkspaceError('Something went wrong loading the demo data.');
      }
      setConfirmLoadDemo(null);
    } finally {
      setLoadingDemo(false);
    }
  }, [confirmLoadDemo, householdId, me, notifyPending, syncRoundTrip, runDestructive]);

  const closeDemoPasswordModal = useCallback(() => {
    if (demoPasswordVerifying) return;
    setDemoPasswordOpen(false);
    setDemoPasswordValue('');
    setDemoPasswordError(null);
  }, [demoPasswordVerifying]);

  const onDemoPasswordContinue = useCallback(async () => {
    if (!demoPasswordValue) return;
    setDemoPasswordError(null);
    setDemoPasswordVerifying(true);
    try {
      await verifyPassword(demoPasswordValue);
      setDemoPasswordOpen(false);
      setDemoPasswordValue('');
      setConfirmLoadDemo({ willOverwrite: true, stage: 'second' });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setDemoPasswordError(err.error.message);
      } else {
        setDemoPasswordError('Failed to verify password. Please try again.');
      }
    } finally {
      setDemoPasswordVerifying(false);
    }
  }, [demoPasswordValue, verifyPassword]);

  const onResetWorkspaceClick = useCallback(() => {
    setWorkspaceError(null);
    // The server clear re-verifies too; verifying here fails fast before the confirm dialog.
    setResetEraseHistory(false);
    setResetPasswordValue(DEV_DEFAULT_PASSWORD);
    setResetPasswordError(null);
    setResetPasswordOpen(true);
  }, []);

  const closeResetPasswordModal = useCallback(() => {
    if (resetPasswordVerifying) return;
    setResetPasswordOpen(false);
    setResetPasswordValue('');
    setResetPasswordError(null);
  }, [resetPasswordVerifying]);

  const onResetPasswordContinue = useCallback(async () => {
    // Re-entrancy guard: a stray Enter can fire while a verify is in flight.
    if (resetPasswordVerifying) return;
    if (!resetPasswordValue) return;
    setResetPasswordError(null);
    setResetPasswordVerifying(true);
    try {
      await verifyPassword(resetPasswordValue);
      // Local count only: the server clear also removes unsynced rows, and no pre-clear count endpoint exists.
      const counts = await Promise.all(
        COUNTED_AGGREGATE_TYPES.map((t) => listAggregates(t)),
      );
      const total = counts.reduce((sum, rows) => sum + rows.length, 0);
      // Keep resetPasswordValue: the server clear re-verifies it on confirm.
      setResetPasswordOpen(false);
      setResetConfirm({ total });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setResetPasswordError(err.error.message);
      } else {
        setResetPasswordError('Failed to verify password. Please try again.');
      }
    } finally {
      setResetPasswordVerifying(false);
    }
  }, [resetPasswordVerifying, resetPasswordValue, verifyPassword]);

  const onResetConfirm = useCallback(async () => {
    if (!householdId || resetting) return;
    setResetting(true);
    setWorkspaceError(null);
    try {
      // Pre-commit: clearWorkspace resolves only on a 2xx; a non-2xx throws into the fail-safe catch below with nothing wiped.
      const result = await clearWorkspace({
        currentPassword: resetPasswordValue,
        eraseHistory: resetEraseHistory,
      });
      setResetConfirm(null);
      setResetPasswordValue('');
      // Post-commit: the server already cleared, so a throw here is not "delete failed". Do not reload after a failed wipe,
      // because the cursor is already '0' and bootstrap would not re-wipe the stores; retry a bounded number of times.
      // Preserve the cached HDK across clearAllStores(): a clear leaves the household key unchanged and dropping it would force a re-unlock.
      let wiped = false;
      let preservedKeyCache: Awaited<ReturnType<typeof readKeyCacheEntry>> = null;
      for (let attempt = 0; attempt < LOCAL_WIPE_ATTEMPTS && !wiped; attempt += 1) {
        try {
          preservedKeyCache = await readKeyCacheEntry();
          await clearAllStores();
          wiped = true;
        } catch (cleanupErr) {
          console.warn(
            `[workspace] Delete workspace data: local store wipe attempt ${attempt + 1}/${LOCAL_WIPE_ATTEMPTS} failed`,
            cleanupErr,
          );
          if (attempt < LOCAL_WIPE_ATTEMPTS - 1) await delay(LOCAL_WIPE_RETRY_MS);
        }
      }
      if (!wiped) {
        setWorkspaceError(LOCAL_CLEANUP_INCOMPLETE_MESSAGE);
        setResetting(false);
        return;
      }
      // Stores are clear: bookkeeping failures are non-critical and must not reach the pre-commit catch (a false "delete failed").
      try {
        if (preservedKeyCache) await writeKeyCacheEntry(preservedKeyCache);
        await clearReloadFromServerLocalCaches();
        localStorage.removeItem(bannerPendingKey(householdId));
        localStorage.removeItem(bannerDismissedKey(householdId));
        // The clear leaves zero members (the demo offer's trigger) though the user chose an empty workspace; App.tsx consumes this flag.
        sessionStorage.setItem('suppressDemoModal', '1');
        if (resetEraseHistory && result.historyErased === false) {
          // The resetEraseHistory guard is load-bearing: the server returns historyErased:false for every clear that did not request erase.
          sessionStorage.setItem(WORKSPACE_HISTORY_NOT_ERASED_KEY, '1');
        } else {
          sessionStorage.setItem(WORKSPACE_NOTICE_KEY, 'Workspace data deleted.');
        }
      } catch (cleanupErr) {
        console.warn(
          '[workspace] Delete workspace data: post-wipe bookkeeping failed; the stores were cleared, reloading to converge',
          cleanupErr,
        );
      }
      setResetting(false);
      window.location.reload();
    } catch (err) {
      if (err instanceof WorkspaceClearCleanupError) {
        // Post-commit sync-state cleanup failed: same recovery, no reload (a resumed poll could re-push queued mutations onto the swept server).
        setWorkspaceError(LOCAL_CLEANUP_INCOMPLETE_MESSAGE);
        setResetConfirm(null);
        setResetPasswordValue('');
        setResetting(false);
        return;
      }
      // Pre-commit fail-safe: clearWorkspace rejected, so nothing was swept or wiped; the next poll's CURSOR_EXPIRED converges if the server completed after a client abort.
      const message =
        err instanceof SyncApiError || err instanceof Error
          ? err.message
          : 'Please try again.';
      setWorkspaceError(`Couldn't delete workspace data: ${message}`);
      setResetConfirm(null);
      setResetPasswordValue('');
      setResetting(false);
    }
  }, [householdId, resetting, resetPasswordValue, resetEraseHistory, clearWorkspace]);

  // Purge-only clear (purgeHistoryOnly): never a full clear, so resumed post-reload work is not swept.
  const onHistoryRetryClick = useCallback(() => {
    setWorkspaceError(null);
    setRetryPasswordValue(DEV_DEFAULT_PASSWORD);
    setRetryPasswordError(null);
    setRetryPasswordOpen(true);
  }, []);

  const closeRetryPasswordModal = useCallback(() => {
    if (retryPasswordVerifying || retryingPurge) return;
    setRetryPasswordOpen(false);
    setRetryPasswordValue('');
    setRetryPasswordError(null);
  }, [retryPasswordVerifying, retryingPurge]);

  const onRetryPasswordContinue = useCallback(async () => {
    if (retryPasswordVerifying || retryingPurge) return;
    if (!retryPasswordValue) return;
    setRetryPasswordError(null);
    setRetryPasswordVerifying(true);
    try {
      // Fail fast on a wrong password; avoids the sync 401→refresh→retry double hit.
      await verifyPassword(retryPasswordValue);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setRetryPasswordError(err.error.message);
      } else {
        setRetryPasswordError('Failed to verify password. Please try again.');
      }
      setRetryPasswordVerifying(false);
      return;
    }
    setRetryPasswordVerifying(false);
    setRetryPasswordOpen(false);
    setRetryingPurge(true);
    try {
      const result = await clearWorkspace({
        currentPassword: retryPasswordValue,
        eraseHistory: true,
        purgeHistoryOnly: true,
      });
      setRetryPasswordValue('');
      if (result.historyErased) {
        setHistoryRetryVisible(false);
        setWorkspaceNotice('Your backup history was erased.');
      } else {
        setWorkspaceError(
          "We still couldn't erase your backup history. It'll be removed automatically as it ages out; you can try again later.",
        );
      }
    } catch (err) {
      const message =
        err instanceof SyncApiError || err instanceof Error
          ? err.message
          : 'Please try again.';
      setWorkspaceError(`Couldn't erase backup history: ${message}`);
    } finally {
      setRetryingPurge(false);
    }
  }, [retryPasswordVerifying, retryingPurge, retryPasswordValue, verifyPassword, clearWorkspace]);

  const onClearLocalConfirm = useCallback(async () => {
    setWorkspaceError(null);
    setClearingLocal(true);
    setConfirmClearLocal(false);
    // Fail closed: signOutForDeviceClear reports proven only when the server session is gone; otherwise stop with nothing wiped or reloaded.
    let attempt: DeviceClearAttempt;
    try {
      attempt = await signOutForDeviceClear();
    } catch (err) {
      setClearingLocal(false);
      setWorkspaceError(
        `Couldn't clear data on this device: ${
          err instanceof Error ? err.message : "we couldn't confirm you were signed out."
        } ` +
          "The app's data is still saved in this browser. To remove it yourself, clear this site's data from your browser's settings, then close every tab of this app.",
      );
      return;
    }
    if (!attempt.proven) {
      setClearingLocal(false);
      setWorkspaceError(
        `Couldn't clear data on this device: ${attempt.reason ?? "we couldn't confirm you were signed out."} ` +
          "The app's data is still saved in this browser. To remove it yourself, clear this site's data from your browser's settings, then close every tab of this app.",
      );
      return;
    }
    try {
      await clearAllLocalData();
      window.location.reload();
    } catch (err) {
      setClearingLocal(false);
      if (err instanceof Error) {
        setWorkspaceError(`Something went wrong clearing this device: ${err.message}`);
      } else {
        setWorkspaceError('Something went wrong clearing this device.');
      }
    }
  }, [signOutForDeviceClear]);

  const onFullSyncConfirm = useCallback(async () => {
    setConfirmFullSync(false);
    setWorkspaceError(null);
    setFullSyncing(true);
    // A failed reseed leaves the cursor at '0', so a reload re-bootstraps instead of pulling incrementally into an empty store.
    const { ok, wiped } = await forceRefresh();
    if (ok) {
      await clearReloadFromServerLocalCaches();
      await recacheHdk();
      sessionStorage.setItem(WORKSPACE_NOTICE_KEY, 'Reloaded a fresh copy from the server.');
      window.location.reload();
      return;
    }
    if (wiped) {
      setWorkspaceError(
        "Reloading from the server didn't finish; trying again from the server.",
      );
      window.location.reload();
      return;
    }
    setWorkspaceError(
      "Reloading from the server didn't complete, so your data was not changed. Check the sync status badge for details.",
    );
    setFullSyncing(false);
  }, [forceRefresh, recacheHdk]);

  return (
    <>
      <SettingsCard
        title="Workspace tools"
        subtitle={
          <>
            Try out the app with demo data, or remove the app&apos;s saved
            data from this device. Your account and the data on our servers
            stay safe. You can sign in again any time to get it back.
          </>
        }
      >
        {workspaceError && (
          <Alert tone="error" className="mb-3">
            {workspaceError}
          </Alert>
        )}
        {workspaceNotice && <SuccessNotice>{workspaceNotice}</SuccessNotice>}
        {historyRetryVisible && (
          <Alert tone="warning" className="mb-3">
            <div className="flex flex-col gap-2">
              <span>
                Your workspace was cleared. We couldn&apos;t erase your backup
                history right now — it&apos;ll be removed automatically as it
                ages out, and until then you can still undo this from Restore
                previous version.
              </span>
              <div>
                <button
                  type="button"
                  className={btnSecondarySmClass}
                  onClick={onHistoryRetryClick}
                  disabled={retryingPurge}
                >
                  {retryingPurge ? 'Erasing…' : 'Try erasing backups again'}
                </button>
              </div>
            </div>
          </Alert>
        )}
        <div className="flex flex-col">
          {/* eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock .kv 13.5px */}
          <div className="flex items-center justify-between gap-3 border-b border-line py-2.5 text-[13.5px]">
            <span className="text-ink">Load demo data</span>
            <button
              type="button"
              className={`${btnPrimarySmClass} min-w-24 gap-1.5`}
              onClick={onLoadDemoClick}
              disabled={loadingDemo || !householdId}
              aria-label="Load demo data"
            >
              <SparklesIcon />
              {loadingDemo ? 'Loading…' : 'Load'}
            </button>
          </div>
          {/* Neutral secondary trigger: red is reserved for the confirm step and the device wipe so destructive actions stay distinguishable. */}
          {/* eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock .kv 13.5px */}
          <div className="flex items-center justify-between gap-3 border-b border-line py-2.5 text-[13.5px]">
            <span className="flex flex-col">
              <span className="text-ink">Reload from server</span>
              <span className="text-xs text-muted">
                Replaces local data with the server&apos;s copy; discards
                unsynced edits.
              </span>
            </span>
            <button
              type="button"
              className={`${btnSecondarySmClass} min-w-24 gap-1.5`}
              onClick={() => setConfirmFullSync(true)}
              disabled={fullSyncing || !householdId}
              aria-label="Reload from server"
            >
              <RefreshIcon />
              {fullSyncing ? 'Reloading…' : 'Reload'}
            </button>
          </div>
          {/* eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock .kv 13.5px */}
          <div className="flex items-center justify-between gap-3 border-b border-line py-2.5 text-[13.5px]">
            <span className="text-ink">Clear data on this device</span>
            <button
              type="button"
              className={`${btnDangerSmClass} min-w-24 gap-1.5`}
              onClick={() => setConfirmClearLocal(true)}
              disabled={clearingLocal}
              aria-label="Clear data on this device"
            >
              <TrashIcon />
              {clearingLocal ? 'Clearing…' : 'Clear'}
            </button>
          </div>
          {/* eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock .kv 13.5px */}
          <div className="flex items-center justify-between gap-3 py-2.5 text-[13.5px]">
            <span className="flex flex-col">
              <span className="text-ink">Delete workspace data</span>
              <span className="text-xs text-muted">
                Clears everything — all accounts, scenarios, expenses, and
                members (including the demo data) — so you can start fresh.
                Your account and sign-in stay.
              </span>
            </span>
            <button
              type="button"
              className={`${btnDangerSmClass} min-w-24 gap-1.5`}
              onClick={onResetWorkspaceClick}
              disabled={resetting || !householdId}
              aria-label="Delete workspace data"
            >
              <TrashIcon />
              {resetting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      </SettingsCard>

      <ConfirmDialog
        open={!!confirmLoadDemo}
        size="lg"
        title={
          confirmLoadDemo?.stage === 'second'
            ? 'Final check: really replace everything?'
            : confirmLoadDemo?.willOverwrite
              ? 'Replace all your data with demo data?'
              : 'Load demo data?'
        }
        message={
          confirmLoadDemo?.stage === 'second' ? (
            <>
              Last chance to back out. Once you confirm, your existing accounts, balances, and Social Security data are <strong>permanently deleted</strong> from this device and our servers, and replaced with the demo dataset. <strong>This can&apos;t be undone.</strong>
            </>
          ) : confirmLoadDemo?.willOverwrite ? (
            <>
              This will erase everything in your account (on this device and on our servers) and replace it with demo data for a made-up family. <strong>This can&apos;t be undone.</strong> Only do this if you want to start over with the demo dataset.
            </>
          ) : (
            "We'll add demo data (a made-up family with accounts, balances, income, expenses, scenarios, and Social Security details) so you can explore the app."
          )
        }
        confirmLabel={
          confirmLoadDemo?.stage === 'second'
            ? 'Delete and load demo'
            : confirmLoadDemo?.willOverwrite
              ? 'Yes, replace everything'
              : 'Load demo data'
        }
        cancelLabel="Cancel"
        destructive={
          !!(confirmLoadDemo?.willOverwrite || confirmLoadDemo?.stage === 'second')
        }
        onConfirm={onLoadDemoConfirm}
        onCancel={() => setConfirmLoadDemo(null)}
      />

      <ConfirmDialog
        open={confirmFullSync}
        size="lg"
        title="Reload from server?"
        message="This discards everything stored on this device (including any edits that haven't synced yet) and reloads a fresh copy from the server. Unsynced edits on this device will be lost. Your account and the data on our servers stay safe."
        extraContent={
          unsyncedEdits.length > 0 ? (
            <div className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">
                {unsyncedEdits.length} unsynced{' '}
                {unsyncedEdits.length === 1 ? 'edit' : 'edits'} on this device will be
                permanently lost:
              </span>
              <UnsyncedEditsWarningList mutations={unsyncedEdits} />
            </div>
          ) : undefined
        }
        confirmLabel="Reload from server"
        confirmIcon={<RefreshIcon />}
        cancelLabel="Cancel"
        onConfirm={onFullSyncConfirm}
        onCancel={() => setConfirmFullSync(false)}
      />

      <ConfirmDialog
        open={confirmClearLocal}
        size="lg"
        title="Clear data on this device?"
        message="Once we confirm you're signed out, this removes the app's saved data from this device. Your account and your data on our servers stay safe; sign in again to get it back here. If you have offline changes that haven't synced yet, those will be lost. If we can't confirm you're signed out (for example, no internet connection), nothing here is changed and you can try again."
        confirmLabel="Clear and sign out"
        cancelLabel="Cancel"
        onConfirm={onClearLocalConfirm}
        onCancel={() => setConfirmClearLocal(false)}
      />

      <PasswordPromptModal
        open={resetPasswordOpen}
        onClose={closeResetPasswordModal}
        title="Confirm with your password"
        intro="Deleting your workspace data clears every account, scenario, expense, and member from this device and our servers. Your account and sign-in stay. Enter your password to continue."
        error={resetPasswordError}
        inputId="reset-pw"
        value={resetPasswordValue}
        onValueChange={setResetPasswordValue}
        email={email}
        onContinue={onResetPasswordContinue}
        continueLabel={resetPasswordVerifying ? 'Checking…' : 'Continue'}
        continueDisabled={!resetPasswordValue || resetPasswordVerifying}
        cancelDisabled={resetPasswordVerifying}
      />

      <ConfirmDialog
        open={!!resetConfirm}
        size="lg"
        title="Delete all workspace data?"
        message={
          resetConfirm ? (
            <>
              This clears{' '}
              <strong>
                {resetConfirm.total} record{resetConfirm.total === 1 ? '' : 's'}
              </strong>{' '}
              on this device — every account, balance, scenario, expense, and
              member — <strong>and anything not yet synced to this device</strong>,
              plus the matching data on our servers, and replaces it all with a
              clean, empty workspace. Your account and sign-in stay.
            </>
          ) : (
            ''
          )
        }
        extraContent={
          <div className="flex flex-col gap-2 text-sm">
            <Checkbox
              isSelected={resetEraseHistory}
              onChange={setResetEraseHistory}
              className="group flex cursor-pointer items-start gap-2 text-ink"
            >
              <span
                aria-hidden="true"
                className="mt-0.5 flex size-5 flex-none items-center justify-center rounded border border-input-line bg-surface text-accent-ink group-data-[selected]:border-accent group-data-[selected]:bg-accent group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-ring group-data-[focus-visible]:ring-offset-2"
              >
                <svg
                  viewBox="0 0 16 16"
                  className="size-3.5 opacity-0 group-data-[selected]:opacity-100"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span>Also erase backup history</span>
            </Checkbox>
            <span className="text-muted">
              {resetEraseHistory
                ? "Your saved backups will be permanently erased too — this can't be undone."
                : 'You can undo this from Restore previous version until your backups age out.'}
            </span>
          </div>
        }
        confirmLabel={resetting ? 'Deleting…' : 'Delete everything'}
        cancelLabel="Cancel"
        onConfirm={onResetConfirm}
        onCancel={() => {
          if (resetting) return;
          setResetConfirm(null);
          setResetPasswordValue('');
        }}
      />

      <PasswordPromptModal
        open={demoPasswordOpen}
        onClose={closeDemoPasswordModal}
        title="Confirm with your password"
        intro="Loading demo data will replace everything in your account on this device and on our servers. Enter your password to continue."
        error={demoPasswordError}
        inputId="demo-pw"
        value={demoPasswordValue}
        onValueChange={setDemoPasswordValue}
        email={email}
        onContinue={onDemoPasswordContinue}
        continueLabel={demoPasswordVerifying ? 'Verifying…' : 'Continue'}
        continueDisabled={!demoPasswordValue || demoPasswordVerifying}
        cancelDisabled={demoPasswordVerifying}
      />

      <PasswordPromptModal
        open={retryPasswordOpen}
        onClose={closeRetryPasswordModal}
        title="Confirm with your password"
        intro="Erasing your backup history permanently removes the saved copies you could otherwise restore from. Your workspace is unchanged. Enter your password to continue."
        error={retryPasswordError}
        inputId="retry-purge-pw"
        value={retryPasswordValue}
        onValueChange={setRetryPasswordValue}
        email={email}
        onContinue={onRetryPasswordContinue}
        continueLabel={
          retryPasswordVerifying || retryingPurge ? 'Erasing…' : 'Erase backups'
        }
        continueDisabled={
          !retryPasswordValue || retryPasswordVerifying || retryingPurge
        }
        cancelDisabled={retryPasswordVerifying || retryingPurge}
      />
    </>
  );
};
