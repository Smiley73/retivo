/** Security page Delete account card: a three-step flow whose export step reuses the delete password (via useProfileExport) instead of prompting again. */
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
  householdId: string | null;
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

  // With AUTH_MFA_ENFORCED on, a fresh factor is required between the export offer and the final confirm; stepUpProof holds it until the destructive call carries it.
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
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [getMfaStatus]);

  const onStepUpVerify = useCallback(async (proof: StepUpProof): Promise<void> => {
    // Inline op: stash the proof; the destructive DELETE carries it and the server verifies it there.
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

  // The hook's initial factor was captured before methods loaded from mfa/status.
  useEffect(() => {
    if (showStepUp) resetStepUp();
  }, [showStepUp, resetStepUp]);
  const [deleteOfferExport, setDeleteOfferExport] = useState(false);
  const [deleteExporting, setDeleteExporting] = useState(false);

  const closeDeleteModal = useCallback(() => {
    // Block close while a delete or export is in flight, so an async export success can't auto-advance after the user dismissed the flow.
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
    setDeleteOfferExport(true);
  }, [deletePassword]);

  // The delete password is reused silently (a carve-out from the per-export prompt): the user typed it moments ago and this is an explicit click. verifyPassword({purpose:'data_export'}) still fires the audit event.
  const onDeleteExportData = useCallback(async () => {
    if (!householdId || deleteExporting) return;
    setDeleteError(null);
    setDeleteExporting(true);
    try {
      const accessToken = await verifyForExport(deletePassword);
      await downloadExport(householdId, accessToken);
      proceedAfterExport();
    } catch (err) {
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
    setDeleteError(null);
    proceedAfterExport();
  }, [deleteExporting, proceedAfterExport]);

  const onDeleteConfirmed = useCallback(async () => {
    setDeleteSubmitting(true);
    setDeleteError(null);
    // Stash the toast flag before deleteAccount: its setMe(null) triggers a RequireAuth redirect mid-await, and that /login mount fires the read-and-clear effect.
    sessionStorage.setItem(
      DELETED_NOTICE_KEY,
      'Your account and live workspace data have been deleted.',
    );
    try {
      await (stepUpProof
        ? deleteAccount(deletePassword, stepUpProof)
        : deleteAccount(deletePassword));
      // Nuke local data only after the server confirmed the delete, preserving the deletion toast. Preserve the deviceId too: deletion does not reload, so AuthProvider keeps the in-memory copy,
      // and wiping the persisted key would let a same-tab re-login bind the session to it and hit DEVICE_MISMATCH after the next reload.
      await clearAllLocalData({
        preserveLocalKeys: [DEVICE_ID_STORAGE_KEY],
        preserveSessionKeys: [DELETED_NOTICE_KEY],
      });
      navigate('/login', { replace: true });
    } catch (err) {
      sessionStorage.removeItem(DELETED_NOTICE_KEY);
      // Drop the confirm and the export offer so a failure lands back on the password modal, the only step with a field to correct it.
      setDeleteConfirming(false);
      setDeleteOfferExport(false);
      // A failed confirm may have consumed the factor server-side, so drop it and require a fresh one on retry.
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
