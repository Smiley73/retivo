/**
 * Security page: Delete account danger card.
 *
 * Owns the three-step delete flow. The within-delete "Export my data" step
 * reuses the export verify+download primitive shared with the Data card via
 * `useProfileExport`, passing the password the user typed on the immediately
 * preceding delete step (no second prompt). Self-sources auth from `useAuth`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth, DEVICE_ID_STORAGE_KEY } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { Modal } from '../components/Modal';
import { Alert } from '../components/Alert';
import { Muted } from '../components/Muted';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { StepUpModal } from '../components/StepUpModal';
import { useStepUp, type StepUpProof } from '../components/useStepUp';
import { clearAllLocalData } from '../lib/local-data';
import { useProfileExport } from './use-profile-export';
import { DELETED_NOTICE_KEY } from './profile-page-shared';
import {
  SettingsCard,
  PasswordPromptModal,
  btnPrimaryClass,
  btnSecondaryClass,
  btnDangerSmClass,
  TrashIcon,
} from './profile-page-chrome';

interface Props {
  /** Current household id (null while booting). */
  householdId: string | null;
  /** Account email for the password re-auth prompt's hidden username. */
  email: string;
}

export const DeleteAccountCard: React.FC<Props> = ({ householdId, email }) => {
  const {
    deleteAccount,
    getMfaStatus,
    stepUpPasskeyOptions,
    stepUpSendEmailOtp,
  } = useAuth();
  const { verifyForExport, downloadExport } = useProfileExport();
  const navigate = useNavigate();

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  // Step-up eligibility: a fresh second factor is
  // required between the export offer and the final confirm when
  // `AUTH_MFA_ENFORCED` is on. Loaded on mount from GET /auth/mfa/status; when
  // off the flow is unchanged (no step-up step). `stepUpProof` holds the
  // collected factor until the destructive call carries it.
  const [stepUpRequired, setStepUpRequired] = useState(false);
  const [stepUpMethods, setStepUpMethods] = useState<string[]>(['email_otp']);
  const [stepUpRecoveryMethods, setStepUpRecoveryMethods] = useState<string[]>([]);
  const [showStepUp, setShowStepUp] = useState(false);
  const [stepUpProof, setStepUpProof] = useState<StepUpProof | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMfaStatus()
      .then((s) => {
        if (cancelled) return;
        setStepUpRequired(!!s.stepUpRequired);
        if (s.methods?.length) setStepUpMethods(s.methods);
        if (s.recoveryMethods) setStepUpRecoveryMethods(s.recoveryMethods);
      })
      // A status-read failure leaves the default (no step-up shown); the server
      // still enforces the factor, surfacing as an error on the final confirm.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [getMfaStatus]);

  const onStepUpVerify = useCallback(async (proof: StepUpProof): Promise<void> => {
    // Inline op (no separate verify endpoint): stash the proof; the destructive
    // DELETE below carries it and the server verifies the factor there.
    setStepUpProof(proof);
  }, []);
  const stepUp = useStepUp({
    purpose: 'delete_account',
    methods: stepUpMethods,
    recoveryMethods: stepUpRecoveryMethods,
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: onStepUpVerify,
    onVerified: () => {
      setShowStepUp(false);
      setDeleteConfirming(true);
    },
  });
  const resetStepUp = stepUp.reset;

  // Seed the factor picker once the modal opens: the hook's initial factor was
  // captured before `methods` loaded from mfa/status, so reset it to the loaded
  // strongest-first factor (mirrors AccountCard's change-email step-up).
  useEffect(() => {
    if (showStepUp) resetStepUp();
  }, [showStepUp, resetStepUp]);
  // Export-offer interstitial between the delete password step and the final
  // live-data deletion confirm. `deleteOfferExport` gates the offer modal;
  // `deleteExporting` is the re-entrancy guard while the silent verify+export
  // for the within-delete export is in flight (mirrors `exportPasswordVerifying`).
  const [deleteOfferExport, setDeleteOfferExport] = useState(false);
  const [deleteExporting, setDeleteExporting] = useState(false);

  const closeDeleteModal = useCallback(() => {
    // Block close while a delete OR a within-delete export is in flight, so an
    // async export success can't auto-advance to the confirm after the user
    // already dismissed the flow (mirrors `closeExportPasswordModal`'s guard).
    if (deleteSubmitting || deleteExporting) return;
    setShowDeleteModal(false);
    setDeletePassword('');
    setDeleteError(null);
    setDeleteConfirming(false);
    setDeleteOfferExport(false);
    setShowStepUp(false);
    setStepUpProof(null);
    resetStepUp();
  }, [deleteSubmitting, deleteExporting, resetStepUp]);

  // Between the export offer and the final confirm: gate on a fresh second factor
  // when required (and not already collected), else advance straight to the
  // live-data deletion confirm (flag-off flow is unchanged).
  const proceedAfterExport = useCallback(() => {
    if (stepUpRequired && !stepUpProof) {
      setShowStepUp(true);
    } else {
      setDeleteConfirming(true);
    }
  }, [stepUpRequired, stepUpProof]);

  const onDeletePasswordContinue = useCallback(() => {
    if (!deletePassword) return;
    setDeleteError(null);
    // Advance to the export-offer interstitial, not straight to the confirm.
    setDeleteOfferExport(true);
  }, [deletePassword]);

  // "Export my data" on the offer interstitial. Reuses the step-1 delete
  // password silently (a carve-out from the per-export password prompt): no second prompt — the user typed it
  // moments ago and this is an explicit click, not a background download. Still
  // calls verifyPassword({purpose:'data_export'}) so the audit event fires.
  const onDeleteExportData = useCallback(async () => {
    if (!householdId || deleteExporting) return;
    setDeleteError(null);
    setDeleteExporting(true);
    try {
      const accessToken = await verifyForExport(deletePassword);
      await downloadExport(householdId, accessToken);
      // Export started — advance to the step-up gate (or straight to the final
      // confirm when step-up isn't required).
      proceedAfterExport();
    } catch (err) {
      // Stay on the offer step so the user can retry or skip; surface inline.
      if (err instanceof ApiRequestError) {
        setDeleteError(err.error.message);
      } else {
        setDeleteError('Failed to export your data. Please try again.');
      }
    } finally {
      setDeleteExporting(false);
    }
  }, [
    householdId,
    deleteExporting,
    deletePassword,
    verifyForExport,
    downloadExport,
    proceedAfterExport,
  ]);

  const onDeleteSkipExport = useCallback(() => {
    // Blocked while an export is in flight so a late success can't race a skip.
    if (deleteExporting) return;
    // Clear any stale export-failure error so it doesn't carry forward into the
    // offer modal on a later confirm-Cancel round trip.
    setDeleteError(null);
    proceedAfterExport();
  }, [deleteExporting, proceedAfterExport]);

  const onDeleteConfirmed = useCallback(async () => {
    setDeleteSubmitting(true);
    setDeleteError(null);
    // Stash the toast flag BEFORE deleteAccount: its inner setMe(null)
    // triggers a RequireAuth redirect to /login mid-await, and that
    // mount is what fires the read-and-clear effect on LoginPage.
    // Setting after the await would land an empty sessionStorage on
    // that first /login render, then leave a stale flag that surfaces
    // on the next /login visit (e.g., post-signup).
    sessionStorage.setItem(
      DELETED_NOTICE_KEY,
      'Your account and live workspace data have been deleted.',
    );
    try {
      // Carry the collected step-up factor when one was required; the flag-off
      // floor is password-only, so `stepUpProof` stays null there.
      await (stepUpProof
        ? deleteAccount(deletePassword, stepUpProof)
        : deleteAccount(deletePassword));
      // Nuke all local data *after* the server side has confirmed the
      // delete (any thrown ApiRequestError keeps the workspace intact for
      // a retry). Preserve the deletion toast across the blanket
      // sessionStorage clear, and preserve the deviceId: deletion
      // does NOT reload, so AuthProvider stays mounted holding the
      // deviceId in state — wiping the persisted key while that stale
      // in-memory copy lives on would let a same-tab re-login bind the
      // server session to it, then the next reload mints a fresh id →
      // DEVICE_MISMATCH. Clear-data needs no such carve-out because it
      // hard-reloads (fresh deviceId regenerated before any login).
      await clearAllLocalData({
        preserveLocalKeys: [DEVICE_ID_STORAGE_KEY],
        preserveSessionKeys: [DELETED_NOTICE_KEY],
      });
      navigate('/login', { replace: true });
    } catch (err) {
      sessionStorage.removeItem(DELETED_NOTICE_KEY);
      // Drop BOTH the confirm and the export-offer interstitial so the failure
      // (e.g. wrong-password / INVALID_CREDENTIALS) lands back on the password
      // modal — the only step with a field to correct it. Leaving the offer
      // open would strand the error on a modal that can't fix it.
      setDeleteConfirming(false);
      setDeleteOfferExport(false);
      // Drop any collected step-up factor: the failed confirm may have consumed
      // it server-side, so a retry must collect a fresh one (never reuse a
      // possibly-consumed factor).
      setStepUpProof(null);
      resetStepUp();
      if (err instanceof ApiRequestError) {
        setDeleteError(err.error.message);
      } else {
        setDeleteError('Failed to delete account. Please try again.');
      }
    } finally {
      setDeleteSubmitting(false);
    }
  }, [deleteAccount, deletePassword, navigate, stepUpProof, resetStepUp]);

  return (
    <>
      <SettingsCard
        tone="danger"
        title="Delete account"
        subtitle="Permanently delete your live account and workspace. Retained records expire on the schedules below."
      >
        <button
          type="button"
          className={`${btnDangerSmClass} gap-1.5`}
          onClick={() => setShowDeleteModal(true)}
        >
          <TrashIcon />
          Delete my account…
        </button>
        {/* Partial-deletion disclosure: say what expires on its own instead of
            promising an absolute erase. */}
        <p className="mt-3 text-xs text-muted">
          Your account and workspace data are deleted when you confirm. Security
          logs expire on their own after about one year, and backups expire on
          their own within 90 days.
        </p>
      </SettingsCard>

      <PasswordPromptModal
        open={showDeleteModal && !deleteOfferExport && !deleteConfirming && !showStepUp}
        onClose={closeDeleteModal}
        title="Delete account"
        intro="Your password is required to delete your account."
        error={deleteError}
        inputId="delete-pw"
        value={deletePassword}
        onValueChange={setDeletePassword}
        email={email}
        onContinue={onDeletePasswordContinue}
        continueLabel="Continue"
        continueDisabled={!deletePassword}
      />

      {/* Export-offer interstitial: a one-click chance to save data before the
          destructive confirm. Reuses the step-1 password silently — no
          second prompt. Never open at the same time as the password modal
          (gated off `!deleteOfferExport`) or the confirm (`!deleteConfirming`). */}
      <Modal
        open={showDeleteModal && deleteOfferExport && !deleteConfirming && !showStepUp}
        onClose={closeDeleteModal}
        title="Save a copy of your data first?"
        size="md"
      >
        <p className="mt-0 text-sm text-ink">
          Deleting your account removes your live account and workspace. Export
          a compressed copy of your workspace now so you can keep it, or skip
          and continue straight to deletion. Keep the file somewhere private;
          it contains your retirement-planning workspace data.
        </p>
        {deleteError && (
          <Alert tone="error" className="mt-3">
            {deleteError}
          </Alert>
        )}
        {/* Left-aligned, primary first — AGENTS modal rule. The primary action
            here is the safe export (not destructive), so it uses the normal
            primary style; "Skip" is the secondary path to the confirm. */}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={btnPrimaryClass}
            onClick={onDeleteExportData}
            disabled={deleteExporting || !householdId}
          >
            {deleteExporting ? 'Exporting…' : 'Export my data'}
          </button>
          <button
            type="button"
            className={btnSecondaryClass}
            onClick={onDeleteSkipExport}
            disabled={deleteExporting}
          >
            Skip, delete anyway
          </button>
          <button
            type="button"
            className={btnSecondaryClass}
            onClick={closeDeleteModal}
            disabled={deleteExporting}
          >
            Cancel
          </button>
        </div>
      </Modal>

      {/* Fresh second-factor step-up: shown only
          when `AUTH_MFA_ENFORCED` is on, between the export offer and the final
          confirm. The collected factor rides with the DELETE call; the server
          verifies it there. */}
      <StepUpModal
        open={showStepUp}
        onClose={() => {
          if (stepUp.submitting) return;
          setShowStepUp(false);
        }}
        title="Confirm it's you"
        stepUp={stepUp}
        confirmLabel="Confirm"
      >
        <Muted className="block text-sm">
          Confirm it&apos;s you with a second factor before permanently deleting
          your account.
        </Muted>
      </StepUpModal>

      <ConfirmDialog
        open={deleteConfirming}
        size="lg"
        title="Delete account and live data?"
        message="This permanently deletes your account and workspace data. Security logs expire on their own after about one year, and backups expire on their own within 90 days. This can't be undone."
        confirmLabel={deleteSubmitting ? 'Deleting…' : 'Yes, delete account'}
        cancelLabel="Cancel"
        onConfirm={onDeleteConfirmed}
        onCancel={() => {
          if (deleteSubmitting) return;
          setDeleteConfirming(false);
        }}
      />
    </>
  );
};
