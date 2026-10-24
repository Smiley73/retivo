/** Security page two-factor card: authenticator app (TOTP) setup and disable, and trusted devices (see "The second factor" in docs/security.md).
* The live TOTP code is typed in the last gate modal and that modal's own submit performs the enrollTotpConfirm write, so the ~1-minute code is seconds old when spent. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import type { MfaStatus, TrustedDevice } from '../auth/useMfaManagement';
import { ApiRequestError } from '../api/client';
import { Alert } from '../components/Alert';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Field } from '../components/Field';
import { Muted } from '../components/Muted';
import { TextInput } from '../components/TextInput';
import { PM_IGNORE_ATTRS } from '../components/password-manager';
import { TotpEnrollment } from '../components/TotpEnrollment';
import { TrustedDevicesList } from '../components/TrustedDevicesList';
import { StepUpModal } from '../components/StepUpModal';
import { useStepUp, type StepUpProof } from '../components/useStepUp';
import { inputClass } from './accounts-page-chrome';
import {
  SettingsCard,
  PasswordPromptModal,
  btnPrimarySmClass,
  btnSecondarySmClass,
  btnDangerSmClass,
} from './profile-page-chrome';

// Which op is in flight; both gate behind password re-verification and, when AUTH_MFA_ENFORCED is on, the fresh-factor modal.
type StepUp = null | 'enroll' | 'disable';

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.error.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export const TwoFactorCard: React.FC = () => {
  const {
    me,
    getMfaStatus,
    enrollTotpStart,
    enrollTotpConfirm,
    disableTotp,
    confirmTotpRestriction,
    listTrustedDevices,
    forgetDevices,
    stepUpPasskeyOptions,
    stepUpSendEmailOtp,
  } = useAuth();
  const email = me?.email ?? '';

  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [devices, setDevices] = useState<TrustedDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  // Claims an email went out only when the server reports noticeSent (a warning otherwise).
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(
    null,
  );
  const [enrollCode, setEnrollCode] = useState('');
  const [stepUp, setStepUp] = useState<StepUp>(null);
  const [pwValue, setPwValue] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [showFactor, setShowFactor] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([getMfaStatus(), listTrustedDevices()]);
      setStatus(s);
      setDevices(d);
    } catch (err) {
      setError(errMessage(err, 'Could not load your two-factor settings.'));
    }
  }, [getMfaStatus, listTrustedDevices]);

  useEffect(() => {
    void load();
  }, [load]);

  // Closing the gate drops what was typed; for enroll the QR screen stays open so the pending secret isn't lost.
  const closeStepUp = useCallback((): void => {
    setStepUp(null);
    setShowFactor(false);
    setPwValue('');
    setPwError(null);
    setPwBusy(false);
    setEnrollCode('');
  }, []);

  const onEnrollContinue = useCallback(() => {
    setStepUp('enroll');
    setPwValue('');
    setPwError(null);
    setShowFactor(false);
    setEnrollCode('');
  }, []);

  const onEnrollCancel = useCallback(() => {
    setEnrolling(false);
    setEnrollCode('');
  }, []);

  // Throws on failure so the step-up path surfaces the modal's non-retryable error; the password-only path catches below.
  // This is the real verification for enroll too: the server checks the authenticator code before spending the step-up proof, so a retry with a corrected code reuses the same password and proof.
  const performOp = useCallback(
    async (proof?: StepUpProof): Promise<void> => {
      if (stepUp === 'disable') {
        const { noticeSent } = await disableTotp(pwValue, proof);
        setNotice(
          noticeSent
            ? { tone: 'success', text: 'Authenticator app removed. We emailed you a heads-up.' }
            : {
                tone: 'warning',
                text: "Authenticator app removed, but we couldn't email you a heads-up.",
              },
        );
      } else if (stepUp === 'enroll') {
        const { noticeSent } = await enrollTotpConfirm(enrollCode, pwValue, proof);
        setNotice(
          noticeSent
            ? {
                tone: 'success',
                text: "Authenticator app added. We emailed you, so you can undo this if it wasn't you.",
              }
            : {
                tone: 'warning',
                text: "Authenticator app added, but we couldn't email you about it.",
              },
        );
      }
    },
    [stepUp, pwValue, disableTotp, enrollTotpConfirm, enrollCode],
  );

  const stepUpFactor = useStepUp({
    purpose: stepUp === 'enroll' ? 'mfa_totp_enroll' : 'mfa_totp_disable',
    methods: status?.methods ?? ['email_otp'],
    // Enrollment: the emailed code is the floor only while nothing is enrolled, and the server refuses it otherwise (STEP_UP_FACTOR_NOT_ELIGIBLE).
    // undefined, not a fresh []: the hook's reset identity follows this value and the open-modal effect would wipe the typed code every render.
    recoveryMethods: stepUp === 'enroll' ? undefined : (status?.recoveryMethods ?? []),
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: (proof) => performOp(proof),
    onVerified: () => {
      setShowFactor(false);
      setStepUp(null);
      setPwValue('');
      setPwError(null);
      if (stepUp === 'enroll') {
        setEnrolling(false);
        setEnrollCode('');
      }
      void load();
    },
  });
  const resetStepUpFactor = stepUpFactor.reset;

  // The hook's initial factor was captured before status loaded.
  useEffect(() => {
    if (showFactor) resetStepUpFactor();
  }, [showFactor, resetStepUpFactor]);

  const onPwContinue = useCallback(async () => {
    if (status?.stepUpRequired) {
      setPwError(null);
      setShowFactor(true);
      return;
    }
    setPwBusy(true);
    setPwError(null);
    const wasEnroll = stepUp === 'enroll';
    try {
      await performOp();
      setStepUp(null);
      setPwValue('');
      setPwError(null);
      if (wasEnroll) {
        setEnrolling(false);
        setEnrollCode('');
      }
      void load();
    } catch (err) {
      setPwError(errMessage(err, 'That did not work. Please try again.'));
      setPwBusy(false);
      return;
    }
    setPwBusy(false);
  }, [status?.stepUpRequired, performOp, load, stepUp]);

  const onForget = useCallback(
    async (deviceId: string) => {
      try {
        await forgetDevices([deviceId]);
        void load();
      } catch (err) {
        setError(errMessage(err, 'Could not forget that device. Please try again.'));
      }
    },
    [forgetDevices, load],
  );

  const onForgetAll = useCallback(async () => {
    try {
      await forgetDevices();
      void load();
    } catch (err) {
      setError(errMessage(err, 'Could not forget all devices. Please try again.'));
    }
  }, [forgetDevices, load]);

  // Only totp and passkey can vouch (Email-OTP has no enrollment timestamp, and the server rejects it); TOTP is a singleton, so in practice only a predating passkey confirms.
  const restrictionConfirmMethods = useMemo(
    () => (status?.methods ?? []).filter((m) => m === 'totp' || m === 'passkey'),
    [status?.methods],
  );
  // Nothing predates the reset: the escape hatch is disabling and re-enrolling, not a modal that can never succeed.
  const confirmHasNoEligibleFactor = confirming && restrictionConfirmMethods.length === 0;

  const confirmRestrictionStepUp = useStepUp({
    purpose: 'mfa_totp_enroll',
    methods: restrictionConfirmMethods,
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: (proof) => confirmTotpRestriction(proof),
    onVerified: () => {
      setConfirming(false);
      void load();
    },
  });
  const resetConfirmRestrictionStepUp = confirmRestrictionStepUp.reset;

  useEffect(() => {
    if (confirming && !confirmHasNoEligibleFactor) resetConfirmRestrictionStepUp();
  }, [confirming, confirmHasNoEligibleFactor, resetConfirmRestrictionStepUp]);

  const enrollCodeReady = enrollCode.trim() !== '';
  const enrollCodeField = (
    <Field htmlFor="totp-enroll-code" label="Authenticator app code">
      <TextInput
        id="totp-enroll-code"
        name="totp-enroll-code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        {...PM_IGNORE_ATTRS}
        spellCheck={false}
        maxLength={6}
        value={enrollCode}
        onChange={(e) => setEnrollCode(e.target.value)}
        className={inputClass}
      />
    </Field>
  );
  const enrollCodeInPasswordStep = stepUp === 'enroll' && !status?.stepUpRequired;
  const enrollCodeInFactorStep = stepUp === 'enroll' && !!status?.stepUpRequired;

  return (
    <>
      <SettingsCard
        title="Two-factor authentication"
        subtitle="Add a second step at sign-in so a stolen password isn't enough."
      >
        {error && <Alert tone="error">{error}</Alert>}
        {notice && (
          <Alert tone={notice.tone} data-testid="totp-factor-notice">
            {notice.text}
          </Alert>
        )}

        <section className="mb-5">
          <h3 className="m-0 mb-1 text-sm font-semibold text-ink">
            Authenticator app
          </h3>
          {!status ? (
            <Muted as="p" className="text-sm">Loading…</Muted>
          ) : enrolling ? (
            <TotpEnrollment
              onCancel={onEnrollCancel}
              enrollStart={enrollTotpStart}
              onContinue={onEnrollContinue}
            />
          ) : status.totpEnabled ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Muted as="p" className="m-0 text-sm">
                  Enabled. Codes from your authenticator app are required at
                  sign-in on a new device.
                  {status.totpRestrictedPostReset && (
                    <span className="ml-2 inline-flex items-center rounded-full border border-line-strong bg-surface-sunken px-2 py-0.5 text-xs font-medium text-muted">
                      Needs confirmation
                    </span>
                  )}
                </Muted>
                {status.totpRestrictedPostReset && (
                  <Muted as="p" className="m-0 mt-1 max-w-md text-xs">
                    This was added right after a password reset, so it
                    isn&apos;t active yet. Until you confirm it with a sign-in
                    method you already had before the reset, it can&apos;t be
                    used to sign in or to approve changes.
                  </Muted>
                )}
              </div>
              <div className="flex items-center gap-2">
                {status.totpRestrictedPostReset && (
                  <button
                    type="button"
                    className={btnSecondarySmClass}
                    onClick={() => setConfirming(true)}
                  >
                    Confirm this authenticator app
                  </button>
                )}
                <button
                  type="button"
                  className={btnDangerSmClass}
                  onClick={() => {
                    setNotice(null);
                    setStepUp('disable');
                  }}
                >
                  Disable
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Muted as="p" className="m-0 text-sm">
                Not set up. Use an app like Google Authenticator or 1Password for
                stronger sign-in codes than email.
              </Muted>
              <button
                type="button"
                className={btnPrimarySmClass}
                onClick={() => {
                  setNotice(null);
                  setEnrolling(true);
                }}
              >
                Set up authenticator app
              </button>
            </div>
          )}
        </section>

        <section>
          <h3 className="m-0 mb-2 text-sm font-semibold text-ink">
            Trusted devices
          </h3>
          <TrustedDevicesList
            devices={devices}
            onForget={onForget}
            onForgetAll={onForgetAll}
          />
        </section>
      </SettingsCard>

      <PasswordPromptModal
        open={(stepUp === 'enroll' || stepUp === 'disable') && !showFactor}
        onClose={closeStepUp}
        title={stepUp === 'enroll' ? 'Set up authenticator app' : 'Disable authenticator app'}
        intro={
          stepUp === 'enroll'
            ? "Confirm your password before you add a new way to sign in. This stops someone who gets into your account from locking you out of it."
            : 'Confirm your password to turn off the authenticator app.'
        }
        error={pwError}
        inputId="twofactor-password"
        value={pwValue}
        onValueChange={setPwValue}
        email={email}
        onContinue={() => void onPwContinue()}
        continueLabel={pwBusy ? 'Working…' : stepUp === 'enroll' ? 'Continue' : 'Disable'}
        continueDisabled={
          pwBusy || pwValue.trim() === '' || (enrollCodeInPasswordStep && !enrollCodeReady)
        }
        cancelDisabled={pwBusy}
      >
        {enrollCodeInPasswordStep ? enrollCodeField : undefined}
      </PasswordPromptModal>

      {/* Email-OTP is the no-lockout floor for disable, so turning TOTP off stays completable by a user who lost the factor; for enroll it is offered only while nothing else is enrolled. */}
      <StepUpModal
        open={showFactor}
        onClose={() => {
          if (stepUpFactor.submitting) return;
          setShowFactor(false);
        }}
        title="Confirm it's you"
        stepUp={stepUpFactor}
        confirmLabel={stepUp === 'enroll' ? 'Continue' : 'Disable'}
        extraFields={enrollCodeInFactorStep ? enrollCodeField : undefined}
        confirmDisabled={enrollCodeInFactorStep && !enrollCodeReady}
      >
        <Muted className="block text-sm">
          {stepUp === 'enroll' ? (
            <>
              Before you add a new way to sign in, confirm it&apos;s you. This
              stops someone who gets into your account from locking you out
              of it. You&apos;ll be asked for your passkey twice if you
              confirm with a passkey — once to confirm it&apos;s you, and
              once to set up the new one.
            </>
          ) : (
            "Confirm it's you with a second factor to turn off the authenticator app."
          )}
        </Muted>
      </StepUpModal>

      <StepUpModal
        open={confirming && !confirmHasNoEligibleFactor}
        onClose={() => {
          if (confirmRestrictionStepUp.submitting) return;
          setConfirming(false);
        }}
        title="Confirm this authenticator app"
        stepUp={confirmRestrictionStepUp}
        confirmLabel="Confirm"
      >
        <Muted className="block text-sm">
          This was added right after a password reset, so it isn&apos;t active
          yet. Confirm it with a sign-in method you already had before the
          reset.
        </Muted>
      </StepUpModal>

      <ConfirmDialog
        open={confirmHasNoEligibleFactor}
        title="Confirm this authenticator app"
        message="You don't have an older sign-in method to confirm this with. Turn it off and set it up again — you'll be able to add it normally once things settle after your password reset."
        confirmLabel="Disable"
        cancelLabel="Close"
        destructive
        onConfirm={() => {
          setConfirming(false);
          setStepUp('disable');
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
};
