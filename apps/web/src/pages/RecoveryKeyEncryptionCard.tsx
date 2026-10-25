/** Security page Recovery key & encryption card: status, prepare-then-commit key rotation, and the locked-state unlock and "Start over" reset (see "Start over (resetting encryption)" in docs/security.md). */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth, DEVICE_ID_STORAGE_KEY } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { PasswordManagerModal } from '../components/PasswordManagerModal';
import { Alert } from '../components/Alert';
import { Field } from '../components/Field';
import { Muted } from '../components/Muted';
import { TextInput } from '../components/TextInput';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { RecoveryKeyModal } from '../components/RecoveryKeyModal';
import { StepUpModal } from '../components/StepUpModal';
import { useStepUp, type StepUpProof } from '../components/useStepUp';
import { HiddenUsernameField, PM_IGNORE_ATTRS } from '../components/password-manager';
import { clearAllLocalData } from '../lib/local-data';
import { ENCRYPTED_WORKSPACE_RESET_PHRASE } from '@retirement/contracts';
import { resetEncryptedWorkspace } from '../auth/key-envelope-client';
import {
  SettingsCard,
  SuccessNotice,
  PasswordPromptModal,
  btnPrimarySmClass,
  btnSecondarySmClass,
  btnDangerSmClass,
  btnSecondaryClass,
  btnDangerClass,
  inputClass,
  KeyIcon,
  TrashIcon,
  LockOpenIcon,
} from './profile-page-chrome';

interface Props {
  /** Account email for the password re-auth prompt's hidden username. */
  email: string;
  /** Whether the household data key is unlocked in memory. */
  isUnlocked: boolean;
  /** Authenticated but locked out with no unwrapper. */
  isLockedNoUnlock: boolean;
}

export const RecoveryKeyEncryptionCard: React.FC<Props> = ({
  email,
  isUnlocked,
  isLockedNoUnlock,
}) => {
  const {
    regenerateRecoveryKey,
    getMfaStatus,
    stepUpPasskeyOptions,
    stepUpSendEmailOtp,
  } = useAuth();
  const navigate = useNavigate();

  const [showStartOverModal, setShowStartOverModal] = useState(false);
  const [startOverPhrase, setStartOverPhrase] = useState('');
  const [startOverPassword, setStartOverPassword] = useState('');
  const [startOverError, setStartOverError] = useState<string | null>(null);
  const [startOverSubmitting, setStartOverSubmitting] = useState(false);
  const startOverPhraseMatches = startOverPhrase === ENCRYPTED_WORKSPACE_RESET_PHRASE;

  // The collected factor lives in a ref so runReset reads it synchronously right after onVerified fires, avoiding a stale-state race.
  const [stepUpRequired, setStepUpRequired] = useState(false);
  const [stepUpMethods, setStepUpMethods] = useState<string[]>(['email_otp']);
  const [stepUpRecoveryMethods, setStepUpRecoveryMethods] = useState<string[]>([]);
  const [showStepUp, setShowStepUp] = useState(false);
  const stepUpProofRef = useRef<StepUpProof | null>(null);

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

  // Two-phase prepare then commit: nothing changes server-side until the user confirms they saved the new key (the original key's bytes are never persisted, so rotating is the only path).
  // regenPending holds { recoveryKey, activate } while the save modal is open; Cancel aborts with the old key untouched.
  const [regenPasswordOpen, setRegenPasswordOpen] = useState(false);
  const [regenPasswordValue, setRegenPasswordValue] = useState('');
  const [regenPasswordError, setRegenPasswordError] = useState<string | null>(null);
  const [regenSubmitting, setRegenSubmitting] = useState(false);
  const [regenPending, setRegenPending] = useState<{
    recoveryKey: string;
    activate: (proof?: StepUpProof) => Promise<void>;
  } | null>(null);
  const [regenActivating, setRegenActivating] = useState(false);
  const [regenActivateError, setRegenActivateError] = useState<string | null>(null);
  const [regenAbortConfirm, setRegenAbortConfirm] = useState(false);
  // Activation always replaces an existing recovery slot, which the exemption matrix never exempts, so AUTH_MFA_ENFORCED demands a proof right before the commit.
  const [showRegenStepUp, setShowRegenStepUp] = useState(false);
  const regenStepUpProofRef = useRef<StepUpProof | null>(null);
  // SuccessNotice has role="status" so the otherwise-silent close is announced; cleared when a new regeneration starts.
  const [regenActivated, setRegenActivated] = useState(false);

  const closeRegenPasswordModal = useCallback(() => {
    // Don't tear down mid-regeneration: a fresh recovery slot may be landing.
    if (regenSubmitting) return;
    setRegenPasswordOpen(false);
    setRegenPasswordValue('');
    setRegenPasswordError(null);
  }, [regenSubmitting]);

  const onRegeneratePasswordContinue = useCallback(async () => {
    // Re-entrancy guard: onEnter can fire while a prepare is already in flight
    // (rapid Enter presses).
    if (regenSubmitting) return;
    if (!regenPasswordValue) return;
    setRegenPasswordError(null);
    setRegenSubmitting(true);
    try {
      // Prepare only: regenerateRecoveryKey re-auths by unwrapping the password slot (a wrong password throws KeyWrappingError) and writes nothing, so the existing key keeps working until the user confirms.
      const pending = await regenerateRecoveryKey(regenPasswordValue);
      setRegenPasswordOpen(false);
      setRegenPasswordValue('');
      setRegenActivateError(null);
      regenStepUpProofRef.current = null;
      setRegenPending(pending);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setRegenPasswordError(err.error.message);
      } else {
        setRegenPasswordError(
          'That password was incorrect, or your data could not be verified. Please try again.',
        );
      }
    } finally {
      setRegenSubmitting(false);
    }
  }, [regenSubmitting, regenPasswordValue, regenerateRecoveryKey]);

  const doActivateRegeneratedKey = useCallback(
    async (proof?: StepUpProof) => {
      if (!regenPending) return;
      setRegenActivateError(null);
      setRegenActivating(true);
      try {
        await regenPending.activate(proof);
        setRegenPending(null);
        setRegenActivated(true);
      } catch {
        setRegenActivateError(
          'Could not activate your new recovery key. Your previous key still works. Please try again.',
        );
      } finally {
        // Step-up proofs are single-use: clear on failure too, or the retry would resend an already-consumed proof and fail forever.
        regenStepUpProofRef.current = null;
        setRegenActivating(false);
      }
    },
    [regenPending],
  );

  const regenStepUp = useStepUp({
    purpose: 'key_envelope_replace',
    methods: stepUpMethods,
    recoveryMethods: stepUpRecoveryMethods,
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: async (proof: StepUpProof) => {
      regenStepUpProofRef.current = proof;
    },
    onVerified: () => {
      setShowRegenStepUp(false);
      void doActivateRegeneratedKey(regenStepUpProofRef.current ?? undefined);
    },
  });
  const resetRegenStepUp = regenStepUp.reset;
  useEffect(() => {
    if (showRegenStepUp) resetRegenStepUp();
  }, [showRegenStepUp, resetRegenStepUp]);

  const onActivateRegeneratedKey = useCallback(() => {
    if (!regenPending || regenActivating) return;
    if (stepUpRequired && !regenStepUpProofRef.current) {
      setShowRegenStepUp(true);
      return;
    }
    void doActivateRegeneratedKey(regenStepUpProofRef.current ?? undefined);
  }, [regenPending, regenActivating, stepUpRequired, doActivateRegeneratedKey]);

  const onAbortRegeneration = useCallback(() => {
    setRegenAbortConfirm(false);
    setRegenActivateError(null);
    setRegenPending(null);
    regenStepUpProofRef.current = null;
    resetRegenStepUp();
  }, [resetRegenStepUp]);

  // onVerify stashes the proof in a ref and onVerified runs the reset with it; runResetRef avoids forward-referencing runReset.
  const runResetRef = useRef<() => Promise<void>>(async () => {});
  const stepUp = useStepUp({
    purpose: 'encrypted_workspace_reset',
    methods: stepUpMethods,
    recoveryMethods: stepUpRecoveryMethods,
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: async (proof: StepUpProof) => {
      stepUpProofRef.current = proof;
    },
    onVerified: () => {
      setShowStepUp(false);
      void runResetRef.current();
    },
  });
  const resetStepUp = stepUp.reset;

  // The hook's initial factor was captured before methods loaded from mfa/status.
  useEffect(() => {
    if (showStepUp) resetStepUp();
  }, [showStepUp, resetStepUp]);

  const closeStartOverModal = useCallback(() => {
    if (startOverSubmitting) return;
    setShowStartOverModal(false);
    setStartOverPhrase('');
    setStartOverPassword('');
    setStartOverError(null);
    setShowStepUp(false);
    stepUpProofRef.current = null;
    resetStepUp();
  }, [startOverSubmitting, resetStepUp]);

  const runReset = useCallback(async () => {
    setStartOverSubmitting(true);
    setStartOverError(null);
    // Only the server reset is recoverable-on-failure: if it throws nothing happened yet. A failed reset may have consumed the factor, so drop it and require a fresh one on retry.
    try {
      await resetEncryptedWorkspace(
        startOverPassword,
        stepUpProofRef.current ?? undefined,
      );
    } catch (err) {
      setStartOverSubmitting(false);
      stepUpProofRef.current = null;
      resetStepUp();
      if (err instanceof ApiRequestError) {
        setStartOverError(err.error.message);
      } else {
        setStartOverError('Could not start over. Please try again.');
      }
      return;
    }
    // The server already revoked every session and wiped the workspace, so the local nuke is best-effort and must not trap the user in stale authenticated state.
    // Preserve the deviceId across the nuke (as in account deletion): no reload happens, so AuthProvider keeps the in-memory deviceId.
    try {
      await clearAllLocalData({ preserveLocalKeys: [DEVICE_ID_STORAGE_KEY] });
    } catch (err) {
      console.warn('[profile] Start over: local data clear failed', err);
    }
    // Hard navigation: AuthContext still holds isAuthenticated=true with stale claims, so a soft navigate would bounce back to /dashboard and cascade through a doomed refresh.
    // No logout() first: the server already revoked everything, so POST /auth/logout would 401.
    window.location.href = '/login';
  }, [startOverPassword, resetStepUp]);
  runResetRef.current = runReset;

  const onStartOverSubmit = useCallback(() => {
    if (!startOverPhraseMatches || !startOverPassword) return;
    if (stepUpRequired && !stepUpProofRef.current) {
      setStartOverError(null);
      setShowStepUp(true);
      return;
    }
    void runReset();
  }, [startOverPhraseMatches, startOverPassword, stepUpRequired, runReset]);

  return (
    <>
      <SettingsCard
        title="Recovery key & encryption"
        subtitle="Your saved data is encrypted before it leaves this device. A recovery key lets you unlock it if you forget your password."
      >
        <p className="m-0 text-sm text-ink">
          {isUnlocked || isLockedNoUnlock
            ? 'Recovery key set.'
            : 'No recovery key yet. You can set one up once encryption is enabled.'}
        </p>

        {regenActivated && (
          <SuccessNotice className="mt-3">
            Your new recovery key is now active. Your previous recovery key no
            longer works.
          </SuccessNotice>
        )}

        {isUnlocked && (
          <div className="mt-4 flex flex-col items-start gap-3 border-t border-line pt-4">
            <p className="m-0 text-sm text-muted">
              Lost your recovery key? You can generate a new one. We
              can&apos;t show your existing key again, but your current key
              keeps working until you activate the new one.
            </p>
            <button
              type="button"
              className={`${btnSecondarySmClass} gap-1.5`}
              onClick={() => {
                setRegenActivated(false);
                setRegenPasswordError(null);
                setRegenPasswordValue('');
                setRegenPasswordOpen(true);
              }}
            >
              <KeyIcon />
              Generate a new recovery key
            </button>
          </div>
        )}

        {isLockedNoUnlock && (
          <div className="mt-4 border-t border-line pt-4">
            <p className="m-0 mb-3 text-sm text-ink">
              We couldn&apos;t unlock your encrypted data on this device. If you
              can&apos;t recover it with your password or recovery key, you can
              start over: your account stays, but the unreadable data is
              permanently deleted.
            </p>
            <div className="flex flex-col items-start gap-3">
              <button
                type="button"
                className={`${btnPrimarySmClass} gap-1.5`}
                onClick={() => navigate('/login?mode=recovery')}
              >
                <LockOpenIcon />
                Use recovery key to unlock your data
              </button>
              <button
                type="button"
                className={`${btnDangerSmClass} gap-1.5`}
                onClick={() => {
                  setStartOverError(null);
                  setStartOverPhrase('');
                  setShowStartOverModal(true);
                }}
              >
                <TrashIcon />
                Delete unreadable encrypted data
              </button>
            </div>
          </div>
        )}
      </SettingsCard>

      <PasswordPromptModal
        open={regenPasswordOpen}
        onClose={closeRegenPasswordModal}
        title="Generate a new recovery key?"
        intro="This prepares a new recovery key to replace your current one. Your current key keeps working until you activate the new one on the next screen, and only stops working once you do. Enter your password to continue."
        error={regenPasswordError}
        inputId="regen-recovery-pw"
        value={regenPasswordValue}
        onValueChange={setRegenPasswordValue}
        email={email}
        onContinue={onRegeneratePasswordContinue}
        continueLabel={regenSubmitting ? 'Generating…' : 'Generate new key'}
        continueDisabled={!regenPasswordValue || regenSubmitting}
        cancelDisabled={regenSubmitting}
      />

      {/* The new key is shown once but is not active until onConfirmed calls activate(); the raw key lives only in regenPending, never persisted. */}
      {regenPending && !showRegenStepUp && (
        <RecoveryKeyModal
          recoveryKey={regenPending.recoveryKey}
          title="Save your new recovery key"
          intro="This is your new recovery key. It replaces your current one only when you confirm below; until then, your existing recovery key keeps working. Store it somewhere safe, separate from your password; a password manager is ideal."
          warning="We can't show this key again. If you cancel, your current recovery key stays in use and this new one is discarded."
          savedLabel="I have saved my new recovery key"
          confirmLabel={regenActivating ? 'Activating…' : 'Activate new key'}
          confirmDisabled={regenActivating}
          error={regenActivateError}
          // Scrim click and Esc do nothing, so a stray outside interaction can't discard the un-reshowable new key or race a stacked scrim-triggered confirm.
          dismissable={false}
          onConfirmed={onActivateRegeneratedKey}
          onDismiss={() => {
            if (regenActivating) return;
            setRegenAbortConfirm(true);
          }}
        />
      )}

      {/* Benign (non-destructive) confirm: aborting is safe because nothing was written. */}
      <ConfirmDialog
        open={regenAbortConfirm}
        size="lg"
        destructive={false}
        title="Cancel without activating?"
        message="Your new recovery key won't be activated, and your current recovery key stays in use. You can generate a new one again later."
        confirmLabel="Yes, cancel"
        cancelLabel="Keep going"
        onConfirm={onAbortRegeneration}
        onCancel={() => setRegenAbortConfirm(false)}
      />

      {/* PasswordManagerModal: a real form for autofill, and the scrim swallows outside clicks so a manager popup rendered outside the dialog can't discard the typed password. */}
      <PasswordManagerModal
        open={showStartOverModal && !showStepUp}
        onClose={closeStartOverModal}
        title="Start over with this account"
        size="md"
        keyboardDismissDisabled={startOverSubmitting}
      >
        <p className="mt-0 text-sm text-ink">
          This permanently deletes the encrypted data we can&apos;t unlock
          (on this device and on our servers) and signs you out of every
          device. <strong>This can&apos;t be undone.</strong> Your account,
          sign-in details, and security history stay. After this you can sign
          in again and start fresh.
        </p>
        {startOverError && (
          <Alert tone="error" className="mt-3">
            {startOverError}
          </Alert>
        )}
        <form
          method="post"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            // Same gate as the submit button, so a stray Enter or fill-and-submit can't bypass it or double-fire.
            if (!startOverPhraseMatches || !startOverPassword || startOverSubmitting) {
              return;
            }
            onStartOverSubmit();
          }}
        >
          <HiddenUsernameField email={email} />
          <Field
            htmlFor="start-over-password"
            label="Current password"
            className="mt-4"
          >
            <TextInput
              id="start-over-password"
              name="current-password"
              type="password"
              autoComplete="current-password"
              value={startOverPassword}
              onChange={(e) => setStartOverPassword(e.target.value)}
              className={inputClass}
              disabled={startOverSubmitting}
            />
          </Field>
          <Field
            htmlFor="start-over-phrase"
            label={`Type "${ENCRYPTED_WORKSPACE_RESET_PHRASE}" to confirm`}
            className="mt-4"
          >
            <TextInput
              id="start-over-phrase"
              value={startOverPhrase}
              onChange={(e) => setStartOverPhrase(e.target.value)}
              className={inputClass}
              autoComplete="off"
              // A type-to-confirm phrase, not a credential: keep password managers from overlaying fill/save UI.
              {...PM_IGNORE_ATTRS}
              disabled={startOverSubmitting}
            />
          </Field>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className={btnDangerClass}
              disabled={!startOverPhraseMatches || !startOverPassword || startOverSubmitting}
            >
              {startOverSubmitting ? 'Starting over…' : 'Delete and start over'}
            </button>
            <button
              type="button"
              className={btnSecondaryClass}
              onClick={closeStartOverModal}
              disabled={startOverSubmitting}
            >
              Cancel
            </button>
          </div>
        </form>
      </PasswordManagerModal>

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
          your unreadable encrypted data.
        </Muted>
      </StepUpModal>

      <StepUpModal
        open={showRegenStepUp}
        onClose={() => {
          if (regenStepUp.submitting) return;
          setShowRegenStepUp(false);
        }}
        title="Confirm it's you"
        stepUp={regenStepUp}
        confirmLabel="Confirm"
      >
        <Muted className="block text-sm">
          Confirm it&apos;s you with a second factor before activating your new
          recovery key.
        </Muted>
      </StepUpModal>
    </>
  );
};
