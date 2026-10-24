/** Security page change-password card (trigger + modal), a real form for password managers (see "Password managers" in docs/ui-conventions.md). */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { PasswordChangeCommittedError, PasswordChangeNotSentError } from '../auth/types';
import { ApiRequestError } from '../api/client';
import { PasswordManagerModal } from '../components/PasswordManagerModal';
import { Field } from '../components/Field';
import { Tooltip } from '../components/Tooltip';
import { InfoIcon } from '../components/icons';
import { TextInput } from '../components/TextInput';
import { Muted } from '../components/Muted';
import { RepoLink } from '../components/RepoLink';
import { HiddenUsernameField } from '../components/password-manager';
import { StepUpModal } from '../components/StepUpModal';
import { useStepUp, type StepUpProof } from '../components/useStepUp';
import { useDirtyModalClose, useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import {
  SettingsCard,
  btnPrimarySmClass,
  btnSecondaryClass,
  btnDangerClass,
  inputClass,
  KeyIcon,
} from './profile-page-chrome';

// Mirrors the server's COMPLEXITY_REGEX: one lower, upper, digit and special character from the exact 32-character POSIX punct set.
const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])/;

const RELOAD_MESSAGE = 'A newer version of this page is available. Reload the page and try again.';

const SIGN_IN_AGAIN_MESSAGE =
  'We could not confirm whether your password changed. Sign in again — try your new password first, and your old one if that fails.';

// Codes the server only throws before any commit, so a response carrying one is a definite rejection (CHANGE_PASSWORD_CONFLICT is a 503, outside the 4xx range).
const PRE_COMMIT_GUARANTEED_REJECTION_CODES = new Set(['CHANGE_PASSWORD_CONFLICT']);

// not-sent and rejected: provably unchanged, retry with the same old password. upgrade-required: reload.
// committed: the server confirmed but this device could not advance its rollback pin, so the workspace is locked here and the old password is wrong.
// indeterminate: the request may have committed with no authenticated read to tell, so never claim a verdict; sign in again rather than replaying the old password against the shared login backoff.
type ChangeOutcome = 'not-sent' | 'upgrade-required' | 'rejected' | 'committed' | 'indeterminate';

function classifyChangePasswordOutcome(err: unknown): ChangeOutcome {
  if (err instanceof PasswordChangeNotSentError) return 'not-sent';
  if (err instanceof PasswordChangeCommittedError) return 'committed';
  if (err instanceof ApiRequestError) {
    if (err.error.code === 'UPGRADE_REQUIRED') return 'upgrade-required';
    if (PRE_COMMIT_GUARANTEED_REJECTION_CODES.has(err.error.code)) return 'rejected';
    if (err.status >= 400 && err.status < 500 && err.error.code !== 'UNKNOWN_ERROR' && err.error.code !== 'INVALID_RESPONSE') {
      return 'rejected';
    }
    return 'indeterminate';
  }
  return 'indeterminate';
}

function retryableMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.error.message;
  if (err instanceof Error) return err.message;
  return 'Could not change your password. Try again.';
}

// Keyed on the error code, never the message: PASSWORD_SLOT_NOT_CANONICAL's reporting link can only be built by the web.
function rejectionNotice(err: unknown): React.ReactNode {
  if (err instanceof ApiRequestError && err.error.code === 'PASSWORD_SLOT_NOT_CANONICAL') {
    return (
      <>
        This account cannot change its password right now. Re-run key setup, or{' '}
        <RepoLink kind="issue" />.
      </>
    );
  }
  return retryableMessage(err);
}

interface Props {
  email: string;
  /** Page-level error sink (single top-of-page Alert). A node, not only a
   * string, so a message can carry a link. */
  onError: (message: React.ReactNode) => void;
  onSuccess: () => void;
}

export const PasswordChangeCard: React.FC<Props> = ({ email, onError, onSuccess }) => {
  const {
    changePassword,
    getMfaStatus,
    stepUpPasskeyOptions,
    stepUpSendEmailOtp,
    isUnlocked,
    needsKeySetup,
  } = useAuth();
  const [showPwModal, setShowPwModal] = useState(false);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwSubmitting, setPwSubmitting] = useState(false);
  // Terminal outcome (indeterminate or committed): rendered in place of the trigger, so no route leads back to a form that would replay the old password against the shared login backoff.
  const [terminalNotice, setTerminalNotice] = useState<string | null>(null);

  // With AUTH_MFA_ENFORCED on, changing the password also needs a fresh second factor; loaded from GET /auth/mfa/status.
  const [stepUpRequired, setStepUpRequired] = useState(false);
  const [stepUpMethods, setStepUpMethods] = useState<string[]>(['email_otp']);
  const [stepUpRecoveryMethods, setStepUpRecoveryMethods] = useState<string[]>([]);
  const [showStepUp, setShowStepUp] = useState(false);

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

  const isPwDirty = useMemo(
    () => showPwModal && (pwCurrent !== '' || pwNew !== '' || pwConfirm !== ''),
    [showPwModal, pwCurrent, pwNew, pwConfirm],
  );

  const closePwModal = useCallback(() => {
    if (pwSubmitting) return;
    setShowPwModal(false);
    setShowStepUp(false);
    setPwCurrent('');
    setPwNew('');
    setPwConfirm('');
  }, [pwSubmitting]);

  const { guardedClose: pwGuardedClose, immediateClose: pwImmediateClose, confirmModal: pwCloseConfirmModal } =
    useDirtyModalClose(isPwDirty, closePwModal);
  const { pendingNavModal: pwPendingNavModal } = useUnsavedChangesGuard(isPwDirty);

  const pwValid = pwNew.length >= 16 && PASSWORD_REGEX.test(pwNew);

  const performChange = useCallback(
    async (proof?: StepUpProof) => {
      setPwSubmitting(true);
      try {
        await changePassword(pwCurrent, pwNew, proof);
        // Clear the fields before closing so the dirty memo doesn't briefly see unsaved edits and block navigation.
        setPwCurrent('');
        setPwNew('');
        setPwConfirm('');
        setShowStepUp(false);
        setShowPwModal(false);
        onSuccess();
      } finally {
        setPwSubmitting(false);
      }
    },
    [changePassword, pwCurrent, pwNew, onSuccess],
  );

  // onVerify runs the whole change request, so a failure is a password-change outcome: route it through the same classifier as onChangePassword.
  // useStepUp's generic handling would say "couldn't confirm it's you" after a change that may have committed; the error is swallowed so that handling never runs.
  const stepUp = useStepUp({
    purpose: 'change_password',
    methods: stepUpMethods,
    recoveryMethods: stepUpRecoveryMethods,
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: async (proof) => {
      try {
        await performChange(proof);
      } catch (err) {
        const outcome = classifyChangePasswordOutcome(err);
        if (outcome === 'indeterminate' || outcome === 'committed') {
          // Terminal either way: close both modals so Confirm can't invite a replay, and replace the trigger with the outcome notice.
          const notice =
            outcome === 'indeterminate' ? SIGN_IN_AGAIN_MESSAGE : retryableMessage(err);
          setTerminalNotice(notice);
          setShowStepUp(false);
          closePwModal();
          onError(notice);
          return;
        }
        // The commit definitely did not happen: return to the password form, since the factor was never the problem.
        setShowStepUp(false);
        onError(outcome === 'upgrade-required' ? RELOAD_MESSAGE : rejectionNotice(err));
      }
    },
    onVerified: () => setShowStepUp(false),
  });
  const resetStepUp = stepUp.reset;

  // The hook's initial factor was captured before methods loaded from mfa/status (same as DeleteAccountCard).
  useEffect(() => {
    if (showStepUp) resetStepUp();
  }, [showStepUp, resetStepUp]);

  const onChangePassword = async () => {
    onError(null);
    if (pwNew !== pwConfirm) {
      onError('Passwords do not match');
      return;
    }
    if (!PASSWORD_REGEX.test(pwNew)) {
      onError('Password must contain at least one uppercase letter, one lowercase letter, one digit, and one special character');
      return;
    }
    if (stepUpRequired) {
      setShowStepUp(true);
      return;
    }
    try {
      await performChange();
    } catch (err) {
      const outcome = classifyChangePasswordOutcome(err);
      if (outcome === 'indeterminate' || outcome === 'committed') {
        const notice =
          outcome === 'indeterminate' ? SIGN_IN_AGAIN_MESSAGE : retryableMessage(err);
        setTerminalNotice(notice);
        closePwModal();
        onError(notice);
        return;
      }
      if (outcome === 'upgrade-required') {
        onError(RELOAD_MESSAGE);
        return;
      }
      onError(rejectionNotice(err));
    }
  };

  return (
    <>
      <SettingsCard
        title="Password"
        subtitle="Change the password you use to sign in."
      >
        {terminalNotice ? (
          <Muted className="block text-sm">{terminalNotice}</Muted>
        ) : needsKeySetup ? (
          <Muted className="block text-sm">
            Finish setting up encryption for this account before changing your password.
          </Muted>
        ) : !isUnlocked ? (
          <Muted className="block text-sm">
            Unlock your data on this device before changing your password.
          </Muted>
        ) : (
          <button
            type="button"
            className={`${btnPrimarySmClass} gap-1.5`}
            onClick={() => setShowPwModal(true)}
          >
            <KeyIcon />
            Change password
          </button>
        )}
      </SettingsCard>

      {/* PasswordManagerModal: the scrim swallows outside clicks (a password-manager popup renders outside the dialog and would fire the dirty-guard close) and the background stays interactive. Esc routes through pwGuardedClose. */}
      <PasswordManagerModal
        open={showPwModal && !showStepUp}
        onClose={pwGuardedClose}
        title="Change password"
        size="md"
      >
        {/* A real form with current-/new-password autocomplete tokens and a hidden username, so managers offer to update the password. */}
        <form
          method="post"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            // Same gate as the submit button, so Enter or a manager's fill-and-submit can't bypass validation or double-fire.
            if (pwSubmitting || !pwCurrent || !pwValid || pwNew !== pwConfirm) return;
            void onChangePassword();
          }}
        >
          <HiddenUsernameField email={email} />
          <div className="flex flex-col gap-3">
            <Field htmlFor="pw-current" label="Current password">
              <TextInput
                id="pw-current"
                name="current-password"
                type="password"
                autoComplete="current-password"
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field
              htmlFor="pw-new"
              label={
                <span className="inline-flex items-center gap-1">
                  New password
                  <Tooltip
                    multiline
                    content="Min 16 characters, must include uppercase, lowercase, a digit, and a special character. Common passwords are rejected."
                  >
                    <span
                      role="img"
                      aria-label="Password requirements"
                      className="inline-flex cursor-help text-muted"
                    >
                      <InfoIcon />
                    </span>
                  </Tooltip>
                </span>
              }
            >
              <TextInput
                id="pw-new"
                name="new-password"
                type="password"
                autoComplete="new-password"
                value={pwNew}
                onChange={(e) => setPwNew(e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field
              htmlFor="pw-confirm"
              label="Confirm new password"
              error={
                pwConfirm && pwNew !== pwConfirm ? 'Passwords do not match' : undefined
              }
            >
              <TextInput
                id="pw-confirm"
                name="confirm-new-password"
                type="password"
                autoComplete="new-password"
                value={pwConfirm}
                onChange={(e) => setPwConfirm(e.target.value)}
                className={inputClass}
              />
            </Field>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className={btnDangerClass}
              disabled={pwSubmitting || !pwCurrent || !pwValid || pwNew !== pwConfirm}
            >
              {pwSubmitting ? 'Changing…' : 'Change password'}
            </button>
            <button
              type="button"
              className={btnSecondaryClass}
              onClick={pwImmediateClose}
              disabled={pwSubmitting}
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
        confirmLabel="Change password"
      >
        <Muted className="block text-sm">
          Confirm it&apos;s you with a second factor to change your password.
        </Muted>
      </StepUpModal>

      {pwCloseConfirmModal}
      {pwPendingNavModal}
    </>
  );
};
