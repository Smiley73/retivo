/**
 * Workspace page: Workspace tools card.
 *
 * Owns the four `.kv` rows and their flows: Load demo data (two-stage
 * password → final-check), Reload from server (forceRefresh + reseed),
 * Clear data on this device (fail-closed sign-out → nuke → reload, ONLY once
 * the server session is provably gone; see
 * `AuthContext.signOutForDeviceClear`), and the always-available
 * Delete workspace data server-authoritative clear (password → counts confirm
 * with an optional "erase backup history" checkbox → `clearWorkspace` endpoint
 * → 2xx-gated local-residue wipe + reload). Also owns the workspace error, the
 * one-shot success notice, and the post-reload "couldn't erase backups / Try
 * again" banner — all stashed in sessionStorage to survive the hard reload
 * these flows trigger. Self-sources auth + sync from `useAuth` / `useSync`.
 */
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

/**
 * Non-`household` aggregate types enumerated ONLY to show the human-readable
 * "delete N records" local count in the confirm dialog. The server clear
 * is type-agnostic — it sweeps every household sync row regardless of type — so
 * this list drives no deletion and needs no compile-time exhaustiveness guard
 * (unlike the retired client-tombstone parade): a new aggregate type can never
 * silently survive the server sweep.
 */
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

/**
 * Bounded retry for the post-2xx local aggregate-store wipe. The server
 * clear has ALREADY committed and `SyncContext.clearWorkspace` reset the sync
 * cursor to `'0'` inside its fence — so the post-reload `initialSync` takes the
 * `applyBootstrap(false)` "fresh device" branch, which fetches the empty server
 * snapshot WITHOUT wiping local stores. A silent reload after a failed
 * `clearAllStores()` would therefore leave the just-deleted aggregates visible
 * on this device. We retry the wipe up to this many times and only reload once
 * it has actually succeeded; if every attempt fails we keep the user on the
 * page with an honest recovery message instead of a misleading reload.
 */
const LOCAL_WIPE_ATTEMPTS = 3;
const LOCAL_WIPE_RETRY_MS = 60;

/**
 * Shared honest-recovery copy for a Delete workspace data clear that COMMITTED
 * server-side but whose local cleanup couldn't finish on THIS device — either
 * the aggregate-store wipe or `SyncContext.clearWorkspace`'s own
 * sync-state cleanup (cursor / freshness pin / mutation queue). In both
 * cases the data WAS deleted server-side, so we must never show the pre-commit
 * "couldn't delete workspace data" copy, and the recovery is identical: use
 * Clear data on this device, or press Delete again (a retry finishes the
 * cleanup). We do NOT reload here — the post-reload bootstrap would not re-wipe
 * the stores, and the still-queued mutations must not reach a resumed
 * poll.
 */
const LOCAL_CLEANUP_INCOMPLETE_MESSAGE =
  "Your workspace data was deleted from our servers, but we couldn't finish clearing it from this device. To remove it here, use the Clear data on this device button, or try Delete again.";

/**
 * Fixed backoff between local-wipe retries. A single fixed delay (no jitter) is
 * enough here: this is one client clearing its own IndexedDB, not a fleet
 * retrying a shared endpoint, so there is no thundering-herd to spread — the
 * pause just lets a transiently blocked/aborted IDB transaction settle before
 * the next attempt.
 */
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
  // Every un-synced edit a "Reload from server" would discard (conflicts first,
  // then errors, then pending), named in the confirm dialog so nothing is lost
  // silently (warn-before-discard). Empty → the dialog reads exactly as before.
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
  // Demo-overwrite re-auth gate. Mirrors the import password modal:
  // we only require a password when there's existing data to wipe;
  // an empty-workspace load skips this entirely.
  const [demoPasswordOpen, setDemoPasswordOpen] = useState(false);
  const [demoPasswordValue, setDemoPasswordValue] = useState('');
  const [demoPasswordError, setDemoPasswordError] = useState<string | null>(null);
  const [demoPasswordVerifying, setDemoPasswordVerifying] = useState(false);
  // "Delete workspace data" flow. Always available under Workspace tools.
  // Mirrors the demo-load two-stage password → confirm state machine: a
  // password re-auth gate, then a confirmation modal listing the local count
  // of what will be deleted plus the "erase backup history" opt-in. On confirm
  // it calls the server-authoritative `clearWorkspace` endpoint.
  const [resetPasswordOpen, setResetPasswordOpen] = useState(false);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [resetPasswordError, setResetPasswordError] = useState<string | null>(null);
  const [resetPasswordVerifying, setResetPasswordVerifying] = useState(false);
  // The confirmation modal's local record count (the server clear also
  // removes anything this device hasn't synced yet, which the copy names but
  // no exact server count is fetched). Non-null = confirm modal open.
  const [resetConfirm, setResetConfirm] = useState<{ total: number } | null>(null);
  // "Also erase backup history" opt-in in the confirm dialog. Default OFF: the
  // clear stays undoable via Restore previous version. ON: the S3 backups are
  // purged too (irreversible).
  const [resetEraseHistory, setResetEraseHistory] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Post-reload "we cleared your workspace but couldn't erase your backup
  // history" state (a 2xx `historyErased:false` on a clear that DID request
  // erase), latched across the reload. When visible the banner offers a
  // purge-only "Try erasing backups again".
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
  // Workspace success notice that must survive the hard `window.location.reload()`
  // these flows trigger. Set in sessionStorage before the reload, read back on
  // the next mount (mirrors DELETED_NOTICE_KEY) — otherwise the notice mounts
  // and is torn down by the reload before the user ever sees it.
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);

  // Pick up a workspace success notice stashed before a hard reload (load demo
  // / reload from server) and show it once, then auto-dismiss. Read-and-remove
  // so it never re-appears on a later reload.
  useEffect(() => {
    const stashed = sessionStorage.getItem(WORKSPACE_NOTICE_KEY);
    if (!stashed) return;
    sessionStorage.removeItem(WORKSPACE_NOTICE_KEY);
    setWorkspaceNotice(stashed);
    const t = setTimeout(() => setWorkspaceNotice(null), 5000);
    return () => clearTimeout(t);
  }, []);

  // Pick up the "workspace cleared but backup history not erased" latch stashed
  // before the delete flow's hard reload (a 2xx `historyErased:false`). Read
  // and remove it so the "couldn't erase backups / Try again" banner shows once
  // — its retry re-opens the password modal and runs a purge-only clear.
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
    // Three-gate flow when overwriting: (1) warning, (2) password re-auth
    // (mirrors the import gate — destructive, so verify identity), (3) final
    // check. The non-overwrite path (empty workspace) skips straight through.
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
        // Force a sync round-trip BEFORE the wipe so the local IDB
        // reflects every server-side aggregate the demo load is about
        // to overwrite. The wipe's enumeration is local-only — without
        // this, rows that exist server-side but haven't been pulled
        // yet (e.g. right after sign-in on a clean device) slip
        // through and reappear on the next pull alongside the
        // freshly-seeded demo set. Abort on failure so the destructive
        // op never runs on stale state. A transient refresh blip here
        // surfaces the retryable inline reason (never "Not signed in." —
        // the session is preserved on a transient failure).
        const sync = await syncRoundTrip();
        if (!sync.ok) {
          setWorkspaceError(`Could not load demo data: ${sync.reason}`);
          setConfirmLoadDemo(null);
          return;
        }
      }
      // Run the destructive wipe→load→reload inside the sync fence so a
      // background poll tick can't flush half-queued wipe/load mutations
      // mid-window. The fence is set before the mutex is acquired and the
      // window runs inside the mutex, so `wipeWorkspaceForDemoReload`'s
      // `clearMutationQueue()` never races a concurrent flush; `runDestructive`
      // clears the fence in a `finally` (the reload below discards it on the
      // success path, the `finally` re-enables the poll if anything throws).
      await runDestructive(async () => {
        if (confirmLoadDemo.willOverwrite) {
          // Queue `delete` mutations for the existing aggregates so the
          // cloud copy is wiped alongside the local one. A naive
          // `clearAllStores()` only touches IndexedDB, leaving orphan
          // aggregates in DynamoDB that the next bootstrap pull would
          // re-deliver next to the freshly-seeded demo set.
          await wipeWorkspaceForDemoReload(householdId);
        }
        await loadDemoData({
          householdId,
          email: me.email,
          displayName: me.displayName || me.email,
        });
        setConfirmLoadDemo(null);
        notifyPending();
        // Stash the success notice so it survives the reload (the prior inline
        // setState + post-reload setTimeout never showed — the reload tore the
        // component down first).
        sessionStorage.setItem(WORKSPACE_NOTICE_KEY, 'Demo data loaded.');
        // Hard reload so every page re-reads aggregates the loader just
        // queued. Same rationale as the FirstRunDemoModal path.
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
      // Tear down the password modal *before* opening the final-check
      // dialog so they don't briefly stack.
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
    // Password re-verification is always required before the confirm step —
    // this clears every account, scenario, and expense. The server clear
    // re-verifies too (defense in depth); this client verify fails fast so a
    // wrong password never reaches the scary confirm dialog. Mirror the
    // import/demo local-dev prefill (blank on real deployments).
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
      // Local count for the confirm copy. The server clear also removes
      // anything this device hasn't synced yet — the copy names that; no exact
      // server count is fetched (no pre-clear count endpoint, and it would add
      // latency to a destructive action for marginal benefit). No sync
      // round-trip precedes the clear anymore: the server sweep is
      // authoritative and type-agnostic, so a stale local view can't leave
      // anything behind.
      const counts = await Promise.all(
        COUNTED_AGGREGATE_TYPES.map((t) => listAggregates(t)),
      );
      const total = counts.reduce((sum, rows) => sum + rows.length, 0);
      // Tear down the password modal *before* opening the confirm dialog so
      // they don't briefly stack. Keep `resetPasswordValue` — the server clear
      // re-verifies it on confirm.
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
      // PRE-COMMIT step. `clearWorkspace` runs under the
      // destructive-op fence + awaits any in-flight flush, then hits
      // `POST /sync/workspace/clear`. It resolves ONLY on a 2xx — a non-2xx
      // (wrong password / throttle / 5xx) throws, taking the PRE-COMMIT
      // fail-safe catch below (queue preserved, NO wipe, NO reload, NO latch).
      // On a 2xx it has ALREADY cleared the ZK freshness pin, reset the cursor,
      // and dropped the mutation queue inside the fence.
      const result = await clearWorkspace({
        currentPassword: resetPasswordValue,
        eraseHistory: resetEraseHistory,
      });
      // 2xx: the sweep + empty snapshot + repoint committed server-side
      // (purge-last), so it is safe to converge locally.
      setResetConfirm(null);
      setResetPasswordValue('');
      // POST-COMMIT local-residue cleanup. The server clear has
      // ALREADY committed, so a throw HERE is NOT a "delete failed" — surfacing
      // that copy would be factually wrong (data WAS deleted server-side). But
      // we also must NOT silently reload on a failed store wipe:
      // `SyncContext.clearWorkspace` already reset the sync cursor to '0' inside
      // its fence, so the post-reload `initialSync` takes the
      // `applyBootstrap(false)` fresh-device branch — which fetches the empty
      // server snapshot but does NOT wipe local stores. So if `clearAllStores()`
      // never succeeds, a reload would leave the just-deleted aggregates visible
      // on this device. Retry the wipe a bounded number of times; only reload
      // once the stores are actually clear.
      //
      // `clearAllStores()` also drops the cached HDK (`keyCache`), but the
      // household key is UNCHANGED by a clear (this is not the encrypted reset),
      // so preserve it across the wipe exactly as the force-bootstrap
      // auto-recovery does — otherwise the post-reload workspace would demand a
      // re-unlock over a still-valid session and the encrypted household would
      // not converge to "synced" without it. Re-read it inside the loop: a
      // failed `clearAllStores()` is an all-or-nothing aborted transaction, so
      // the row is still intact for the next attempt.
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
        // Every wipe attempt failed. The server clear committed, so never show
        // the pre-commit "couldn't delete workspace data" copy — but do NOT
        // silently reload either (the post-reload bootstrap won't re-wipe; see
        // above), or the deleted records would still be visible here. Keep the
        // user on this page with an honest, actionable recovery path instead.
        setWorkspaceError(LOCAL_CLEANUP_INCOMPLETE_MESSAGE);
        setResetting(false);
        return;
      }
      // Stores are clear. Finish the best-effort local-only bookkeeping (restore
      // the preserved HDK, drop the caches the wipe leaves behind — Monte Carlo
      // results + the selected-scenario pointer — and the per-household
      // ready-banner keys, then set the suppress-demo flag + the post-reload
      // notice/latch). The mutation queue was already dropped inside
      // `clearWorkspace`'s fence. None of this is residue and all of it
      // self-heals or is non-critical, so a throw here must NOT reach the
      // pre-commit catch (a false "delete failed") — log and still reload to
      // converge.
      try {
        if (preservedKeyCache) await writeKeyCacheEntry(preservedKeyCache);
        await clearReloadFromServerLocalCaches();
        localStorage.removeItem(bannerPendingKey(householdId));
        localStorage.removeItem(bannerDismissedKey(householdId));
        // Suppress the first-run "Load demo data?" offer on the next mount: the
        // clear leaves zero members (the offer's trigger) but the user
        // deliberately chose an empty workspace. App.tsx consumes this flag.
        sessionStorage.setItem('suppressDemoModal', '1');
        if (resetEraseHistory && result.historyErased === false) {
          // Erase-history WAS requested this clear but the S3 purge failed.
          // Still converge (the clear happened) but latch the honest
          // banner across the reload so the user can retry the purge — the copy
          // is the banner, not a generic "deleted" toast. The `resetEraseHistory`
          // guard is load-bearing: the server returns `historyErased:false` for
          // EVERY clear where erase wasn't requested (it's saying "you didn't
          // ask me to purge", NOT "the purge failed"), so on the default path
          // (checkbox unticked) that value is the normal success case — never a
          // failure banner.
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
      // Hard reload so every page re-reads the now-empty workspace; the
      // post-reload initialSync bootstraps the empty snapshot and
      // ensureBaseScenario re-creates a fresh empty "Base" scenario. Reached
      // only once the local stores are actually clear.
      setResetting(false);
      window.location.reload();
    } catch (err) {
      if (err instanceof WorkspaceClearCleanupError) {
        // POST-COMMIT: the server clear COMMITTED (2xx) but
        // `SyncContext.clearWorkspace` could not finish its local sync-state
        // cleanup (cursor / freshness pin / mutation queue) even after its
        // bounded retries, so it left the poll suspended. This is NOT a
        // pre-commit failure — the data WAS deleted server-side — so never show
        // the "couldn't delete workspace data" copy, and do NOT reload: the
        // post-reload bootstrap would not re-wipe the stores, and a resumed poll
        // could re-push the still-queued mutations onto the swept server. Keep
        // the user here with the shared honest recovery path; pressing Delete
        // again re-runs the clear, whose retry finishes the cleanup and lifts
        // the suspension.
        setWorkspaceError(LOCAL_CLEANUP_INCOMPLETE_MESSAGE);
        setResetConfirm(null);
        setResetPasswordValue('');
        setResetting(false);
        return;
      }
      // PRE-COMMIT fail-safe: `clearWorkspace` itself rejected, so the
      // server never swept — the mutation queue is untouched and nothing local
      // was wiped. Surface the typed error and let the user retry (the next
      // poll's CURSOR_EXPIRED still converges the device if the server actually
      // completed after a client abort).
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

  // "Try erasing backups again" (post-reload, after a 2xx `historyErased:false`).
  // Re-opens the password modal; on continue it runs a PURGE-ONLY clear
  // (`purgeHistoryOnly: true`) — never a full clear, so resumed post-reload work
  // is never swept. No reload: the workspace is already live + empty
  // (or holding new edits); only the backup history is purged.
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
      // Client verify fails fast on a wrong password (the server clear
      // re-verifies too, but that avoids the sync 401→refresh→retry double
      // hit on a deliberate password failure).
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
        // Still couldn't purge — keep the banner so the user can try later.
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
    // Sign out FIRST and fail closed:
    // `signOutForDeviceClear` only reports `proven: true` when the server
    // session is provably gone (a 2xx logout, or a definitively-rejected
    // refresh cookie) — anything else (offline, a timeout, a 5xx, a
    // throttle, or an ambiguous 401) stops here with nothing wiped and
    // nothing reloaded, so the person stays on this page and can retry.
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
      // The full nuke — every localStorage key (deviceId included),
      // every sessionStorage key, the IndexedDB, and Cache Storage.
      await clearAllLocalData();
      // Hard reload lands on /login via RequireAuth, dropping all
      // in-memory/context residue and regenerating a fresh deviceId.
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
    // `forceRefresh` wipes local IndexedDB + the mutation queue and
    // reseeds from the server snapshot. The cursor-reset invariant
    // guarantees a failed reseed left the cursor at '0', so a reload
    // re-bootstraps rather than incremental-pulling into an empty store.
    const { ok, wiped } = await forceRefresh();
    if (ok) {
      await clearReloadFromServerLocalCaches();
      await recacheHdk();
      // Stash the notice so it survives the hard reload (see WORKSPACE_NOTICE_KEY).
      sessionStorage.setItem(WORKSPACE_NOTICE_KEY, 'Reloaded a fresh copy from the server.');
      // Hard reload so every mounted page re-reads the fresh IDB and
      // the cleared selected-scenario pointer resets.
      window.location.reload();
      return;
    }
    if (wiped) {
      // Reseed failed after the wipe — local data is gone. The reload's
      // initialSync re-bootstraps from the server (cursor is '0').
      setWorkspaceError(
        "Reloading from the server didn't finish; trying again from the server.",
      );
      window.location.reload();
      return;
    }
    // Pre-wipe failure (offline / transport / schema): nothing was
    // touched. The badge + its Details popover carry the actionable
    // envelope, so don't duplicate it here. Re-enable the button.
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
        {/* Mock `.kvs`/`.kv` key/value rows: label-left, action-right,
            hairline divider between (13.5px). Replaces the prior
            flex-row of three buttons. Each action's handler/guard is
            unchanged — only the layout and the button captions moved
            (the row label now carries the description; the button is
            the short verb). The accessible name of each control is the
            full row (label + button text) so existing intent is clear. */}
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
          {/* "Reload from server" replaces this device's data with the
              server's copy. It discards unsynced local edits, so it keeps a
              confirm gate, but it's a deliberate recovery action (not a
              delete) — so the trigger is a neutral secondary button. Red is
              reserved for the confirm step and the true device wipe below,
              so the destructive action stays distinguishable at a glance. */}
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
          {/* "Delete workspace data" — always available. Wipes every
              account, balance, scenario, expense, and member (demo data and
              anything you've entered) and re-seeds an empty Base scenario +
              default expense categories on reload, keeping the account +
              sign-in intact. Password re-verification + a counts
              confirmation gate the action. The most data-destructive tool
              here, so it's the last row and carries a description. */}
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
        // Loading demo into an EMPTY workspace adds data and is benign (lime
        // confirm); overwriting an existing workspace, and the second-stage
        // "really replace everything?" gate, are destructive (red).
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

      {/* "Delete workspace data" password re-auth. On a correct password the
          confirmation dialog below opens (no pre-clear sync round-trip — the
          server clear is authoritative). The typed password is retained and
          re-verified server-side on confirm. */}
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

      {/* Demo-overwrite password re-auth. On a correct password, opens the
          final-check confirm dialog above. */}
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

      {/* "Try erasing backups again" password re-auth. On a correct password it
          runs a PURGE-ONLY clear (`purgeHistoryOnly: true`) — no sweep, no
          reload — so resumed post-reload work is never touched. */}
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
