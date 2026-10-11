/**
 * Security page: Two-factor authentication card (see "The second factor" in
 * docs/security.md).
 *
 * Two sections, both driven by the MFA-management methods on `useAuth()`:
 *  - Authenticator app (TOTP): the QR setup screen (`TotpEnrollment`) opens
 *    immediately — `enrollStart` mints an unconfirmed pending secret and
 *    writes nothing sensitive — so the slow part (scanning) happens before
 *    any proof is collected. Continue opens the fresh-proof gate (password
 *    always, plus a step-up factor when `AUTH_MFA_ENFORCED` is on). The live
 *    6-digit authenticator code is typed in whichever gate modal is the LAST
 *    step (the password prompt on the flag-off floor, the step-up modal when
 *    enforced), and that modal's OWN submit performs the real
 *    `enrollTotpConfirm(code, password, proof)` write, exactly like the
 *    disable/passkey-add gates below. Two properties follow: every input is
 *    verified for real by the modal that owns it, with all of its fields
 *    still editable when the server says no;
 *    and the TOTP code — valid for only ~a minute, server
 *    tolerance ±30 s — is seconds old when spent, instead of frozen before a
 *    password + emailed-code round trip that routinely outlasts it.
 *    Disable behind password
 *    re-verification and (when enforced) fresh step-up; a restricted factor
 *    (enrolled right after a password reset) renders its own confirm action.
 *  - Trusted devices: {@link TrustedDevicesList}.
 */
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

/**
 * Which op is in flight — drives password re-verification and, when
 * `AUTH_MFA_ENFORCED` is on, the reusable fresh-factor modal. `enroll` gates
 * setting up the authenticator app exactly like
 * `disable` gates turning it off.
 */
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
  // Confirmation line after a factor change — the
  // server emails the account when the authenticator app is added or turned
  // off, with a single-use undo link, and reports `noticeSent`; the line only
  // claims an email went out when it did (a warning otherwise).
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(
    null,
  );
  // The live authenticator code — typed into the LAST gate modal (see the
  // header comment), so it is seconds old when `performOp` spends it.
  const [enrollCode, setEnrollCode] = useState('');
  // Password step-up modal state.
  const [stepUp, setStepUp] = useState<StepUp>(null);
  const [pwValue, setPwValue] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  // Fresh-second-factor step: shown after the
  // password step when `AUTH_MFA_ENFORCED` is on. `showFactor` gates the modal.
  const [showFactor, setShowFactor] = useState(false);
  // Confirming (lifting) the TOTP factor's post-reset restriction.
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

  // Closing the gate (Cancel / Esc on the password prompt) drops everything
  // typed into it; for `enroll` the QR screen behind it stays open, so the
  // pending secret is not lost and the person can try again.
  const closeStepUp = useCallback((): void => {
    setStepUp(null);
    setShowFactor(false);
    setPwValue('');
    setPwError(null);
    setPwBusy(false);
    setEnrollCode('');
  }, []);

  // The QR screen is already open (started unconditionally on "Set up" click
  // — `enrollStart` writes nothing sensitive). Continue there opens the
  // password (+ step-up) gate below; the code is typed in the last of those
  // and THAT modal's own submit performs the real write (`performOp`).
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

  // Run the chosen op with the entered password, carrying a fresh step-up factor
  // when one was collected (the flag-off floor is password-only, so `proof` stays
  // undefined). Throws on failure so the step-up path surfaces the modal's
  // non-retryable error; the password-only path catches below. This IS the
  // real verification for `enroll` too — a wrong password, step-up code or
  // authenticator code fails here and surfaces on the gate modal that collected
  // it, with the field still editable,
  // not deferred past this call. The server
  // checks the authenticator code BEFORE spending the step-up proof, so a retry
  // with a corrected code reuses the same password + proof.
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

  // Fresh-second-factor collection (flag on): on a verified factor, run the op
  // inline; `onVerified` closes the modals + reloads status.
  const stepUpFactor = useStepUp({
    purpose: stepUp === 'enroll' ? 'mfa_totp_enroll' : 'mfa_totp_disable',
    methods: status?.methods ?? ['email_otp'],
    // Enrollment: the emailed code is the floor
    // ONLY while the account has no enrolled factor — `methods` lists it
    // exactly then — and the server refuses it otherwise
    // (`STEP_UP_FACTOR_NOT_ELIGIBLE`), so the recovery list is not offered for
    // `enroll`. `disable` keeps the no-lockout floor. `undefined`, not a
    // fresh `[]`: the hook's `reset` identity follows this value, and the
    // open-modal effect below re-runs `reset` (wiping the typed code) on every
    // render whenever it changes.
    recoveryMethods: stepUp === 'enroll' ? undefined : (status?.recoveryMethods ?? []),
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: (proof) => performOp(proof),
    onVerified: () => {
      // The write already committed (`performOp` above ran the real
      // `enrollTotpConfirm`/`disableTotp` call) — close every modal and, for
      // `enroll`, close the QR/code UI too, then reload the fresh status.
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

  // Seed the factor picker to the loaded strongest-first factor once the factor
  // modal opens (the hook's initial factor was captured before status loaded).
  useEffect(() => {
    if (showFactor) resetStepUpFactor();
  }, [showFactor, resetStepUpFactor]);

  // Password step: verify the password server-side. When the flag is on, advance
  // to the fresh-factor step; otherwise run the op with the password only.
  const onPwContinue = useCallback(async () => {
    if (status?.stepUpRequired) {
      // Keep the entered password; collect the factor next (the op call carries
      // both). The password itself is re-verified server-side by the op.
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

  // Confirm (lift) the TOTP factor's post-reset restriction. No password
  // baseline — the proof must come from an already-enrolled, non-restricted
  // factor that predates the reset: only `totp`/`passkey` can vouch (Email-OTP
  // has no enrollment timestamp to compare, and the server rejects it) — TOTP
  // is a singleton, so in practice only a predating passkey can confirm it.
  const restrictionConfirmMethods = useMemo(
    () => (status?.methods ?? []).filter((m) => m === 'totp' || m === 'passkey'),
    [status?.methods],
  );
  // Nothing predates the reset — the escape hatch is disabling + re-enrolling,
  // not a modal that can never succeed.
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

  // The live authenticator code field for `enroll` — rendered inside whichever
  // gate modal is the LAST step (see the header comment), never in both: the
  // password prompt on the flag-off floor, the step-up modal when enforced.
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

        {/* --- Authenticator app (TOTP) --- */}
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

        {/* --- Trusted devices --- */}
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

      {/* Fresh-proof gate: for `enroll` this opens
          from the QR screen's Continue; on the flag-off floor it is the LAST
          step, so it also collects the live authenticator code and its own
          Continue carries password + code into the real `enrollTotpConfirm`
          write. For `disable` there is no live code, just password
          re-verification. */}
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

      {/* Fresh second-factor step-up: shown after
          the password step when `AUTH_MFA_ENFORCED` is on. Verifying a factor
          runs the op inline; an ambiguous failure surfaces the non-retryable
          error. For `enroll` this is the LAST step, so it also collects
          the live authenticator code (`extraFields`) right before its submit
          spends it. Email-OTP is the no-lockout floor for DISABLE, so turning
          TOTP off stays completable even by a user who lost the factor;
          for enroll it is offered only while nothing else is enrolled. */}
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

      {/* Confirm (lift) the TOTP factor's post-reset restriction.
          No password step — the proof must come
          from an already-enrolled factor that predates the reset. */}
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

      {/* Nothing predates the reset — there is no factor that could ever
          confirm this one. The escape hatch is disabling + re-enrolling, not
          a dead-end modal. */}
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
