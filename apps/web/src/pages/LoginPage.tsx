/**
 * Local-credential sign-in page. Rendered outside the app shell so the
 * unauthenticated surface is visually distinct from the authed product.
 *
 * Accessibility (WCAG 2.2 AA):
 * - Every input has a matching label + autocomplete hint.
 * - Errors render in `role="alert"` so screen readers announce them.
 * - `noValidate` disables native browser tooltips; we rely on server
 *   validation + our own messaging for consistency.
 */
import React, { useEffect, useState } from 'react';
import { textLinkClass } from '../components/TextLink';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { BUSY_MESSAGE, isBusyResponse } from '../api/busy-response';
import { safeRedirect } from '../auth/safe-redirect';
import {
  consumeSignoutReason,
  SIGNOUT_REASON_IDLE,
  SIGNOUT_REASON_DEVICE_MISMATCH,
} from '../auth/IdleTimer';
import { DELETED_NOTICE_KEY } from './profile-page-shared';
import { DEV_DEFAULT_EMAIL, DEV_DEFAULT_PASSWORD } from '../lib/dev-credentials';
import { Card } from '../components/Card';
import { Alert } from '../components/Alert';
import { TextInput } from '../components/TextInput';
import { RecoveryKeyModal } from '../components/RecoveryKeyModal';
import { MfaChallengeForm } from '../components/MfaChallengeForm';
import { StepUpModal } from '../components/StepUpModal';
import { SmallScreenNotice } from '../components/SmallScreenNotice';
import { useStepUp, type StepUpProof } from '../components/useStepUp';
import { HiddenUsernameField, PM_IGNORE_ATTRS } from '../components/password-manager';
import { SetupStepUpRequiredError } from '../auth/useZeroKnowledgeKey';
import {
  AUTH_PAGE_WRAP,
  AUTH_CARD_WIDTH,
  AUTH_COLUMN_WIDTH,
  AuthBrandRow,
  AuthPasswordField,
  authFieldClass,
  authLabelClass,
  authInputClass,
  authPrimaryButtonClass,
  authSecondaryButtonClass,
  authMutedClass,
  authNoticeClass,
  authHeadingClass,
} from './auth-page-chrome';

export const LoginPage: React.FC = () => {
  const {
    me,
    login,
    loginWithPasskey,
    isAuthenticated,
    isPasskeySupported,
    isBooting,
    isUnlocked,
    needsKeySetup,
    unlockResolved,
    hasPasskeyPrfSlot,
    lockedEnvelopeSetEmpty,
    unlockWithPassword,
    unlockWithRecovery,
    unlockWithPasskey,
    setupEncryption,
    resendVerification,
    mfaChallenge,
    verifyMfa,
    verifyMfaWithPasskey,
    sendEmailOtp,
    clearMfaChallenge,
    getMfaStatus,
    stepUpPasskeyOptions,
    stepUpSendEmailOtp,
  } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const recoveryParam = searchParams.get('mode') === 'recovery';
  const [email, setEmail] = useState(DEV_DEFAULT_EMAIL);
  const [password, setPassword] = useState(DEV_DEFAULT_PASSWORD);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletedNotice, setDeletedNotice] = useState<string | null>(null);
  const [idleNotice, setIdleNotice] = useState<string | null>(null);
  // After a routine-factor MFA pass with "trust this device" checked, the
  // server confirms the device was remembered. Surface a brief inline
  // notice in the challenge form before the post-verify redirect fires. The
  // form unmounts shortly after, so this is intentionally lightweight.
  const [deviceTrustedNotice, setDeviceTrustedNotice] = useState(false);
  // Verification-resend path: the last login failure was `EMAIL_NOT_VERIFIED`,
  // so we offer an inline "Resend verification email" action below the error.
  // `resendStatus` carries the opaque success / inline failure copy in its own
  // live region — the original login `error` (the EMAIL_NOT_VERIFIED Alert)
  // stays visible alongside it. All three reset when login is resubmitted or
  // the email field changes (mirrors the SignupPage resend pattern).
  const [emailNotVerified, setEmailNotVerified] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendStatus, setResendStatus] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  // Zero-knowledge unlock prompt (see "Unlocking" in docs/security.md): when the
  // session is established but the household data key is not yet in memory (an
  // encrypted household, no cached key), hold the user here for a password
  // unlock instead of redirecting into the app.
  const [unlockPassword, setUnlockPassword] = useState(DEV_DEFAULT_PASSWORD);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  // Recovery-key unlock mode: the unlock prompt toggles
  // between the account password and the saved recovery key. A single field
  // swaps between the two — a user has one or the other, not both at once.
  const [useRecoveryMode, setUseRecoveryMode] = useState(false);
  // Zero-knowledge first-time setup: when the
  // session is established but the household has no key envelope yet
  // (`needsKeySetup`), hold the user here to key the household before entering
  // the app. On success we hold them once more to show the recovery key in
  // RecoveryKeyModal; only after they confirm it's saved do we navigate.
  const [setupPassword, setSetupPassword] = useState(DEV_DEFAULT_PASSWORD);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  // In-session repair branch of setup: a
  // household stranded with a `password` slot and no `recovery` slot (an
  // interrupted pre-cutover activation) now needs a fresh factor to finish,
  // when `AUTH_MFA_ENFORCED` is on. `setupEncryption` throws
  // `SetupStepUpRequiredError` when it hits this; fetch the account's eligible
  // factors on demand (only reached on the retry, never on a genuinely fresh
  // household) and show the reusable `StepUpModal`.
  const [showSetupFactor, setShowSetupFactor] = useState(false);
  const [setupStepUpMethods, setSetupStepUpMethods] = useState<string[]>(['email_otp']);
  const [setupStepUpRecoveryMethods, setSetupStepUpRecoveryMethods] = useState<string[]>([]);
  // `unlockResolved` gates the prompt: until `initializeUnlockState` settles
  // after login, all four unlock flags are transiently false, which would flash
  // the "Unlock your data" prompt on every login (even when no
  // household has an envelope). Requiring `unlockResolved` holds the prompt back
  // until the cached-HDK lookup + envelope fetch have decided the real state.
  const needsUnlock =
    isAuthenticated && !isUnlocked && !needsKeySetup && !isBooting && unlockResolved;
  // First-time encryption setup is pending: authenticated, no envelope yet, and
  // the unlock lifecycle has settled. Holds the user on /login for the setup
  // prompt (and then the recovery-key modal) instead of redirecting into the app.
  const needsSetup =
    isAuthenticated && needsKeySetup && !isUnlocked && !isBooting && unlockResolved;

  // Clear the unlock prompt's secret state whenever the prompt is not active
  // (the user successfully unlocked, logged out, or the session changed within
  // the same tab). Without this, a typed recovery key persists in
  // `unlockPassword` and recovery mode stays toggled on, so it would reappear in
  // the next locked session's recovery-mode field (security: secret reuse
  // across sessions). Keyed on `needsUnlock` going false.
  // Resets to `DEV_DEFAULT_PASSWORD`, which is `''` everywhere except a local-dev
  // host — so the secret-clearing guarantee is unchanged on prod while dev keeps
  // the seeded password prefilled for the password-unlock field.
  useEffect(() => {
    if (!needsUnlock) {
      setUseRecoveryMode(false);
      setUnlockPassword(DEV_DEFAULT_PASSWORD);
      setUnlockError(null);
    }
  }, [needsUnlock]);

  // Pre-select recovery mode when the user arrives via `/login?mode=recovery`
  // (the Security page "Use recovery key to unlock your data" button).
  // Gated on `needsUnlock` becoming true: the secret-clearing
  // effect above fires on mount (when `!needsUnlock`) and resets recovery mode,
  // so a `useState` initializer would be overwritten before the unlock prompt
  // renders. Riding on top of that reset — keyed on `needsUnlock` — fires
  // exactly when the prompt appears. Starts the field empty: a recovery
  // key is never the dev-seeded password. `recoveryParam` is captured outside
  // the callback so `[needsUnlock]` stays the only dependency.
  useEffect(() => {
    if (needsUnlock && recoveryParam) {
      setUseRecoveryMode(true);
      setUnlockPassword('');
    }
  }, [needsUnlock]);

  useEffect(() => {
    const notice = sessionStorage.getItem(DELETED_NOTICE_KEY);
    if (notice) {
      setDeletedNotice(notice);
      sessionStorage.removeItem(DELETED_NOTICE_KEY);
    }
    const reason = consumeSignoutReason();
    if (reason === SIGNOUT_REASON_IDLE) {
      setIdleNotice('Signed out due to inactivity. Sign in again to continue.');
    } else if (reason === SIGNOUT_REASON_DEVICE_MISMATCH) {
      setIdleNotice("This device's session was reset. Sign in again to reconnect.");
    }
  }, []);

  // Clear the post-verify device-trust notice when this page unmounts (the
  // redirect into the app) so a stale "device now trusted" banner can never
  // reappear on a later return to /login.
  useEffect(() => {
    return () => setDeviceTrustedNotice(false);
  }, []);

  // Redirect into the app once authenticated — but only after the unlock
  // lifecycle has settled (`unlockResolved`). Before that, all unlock flags are
  // transiently false, so `needsUnlock` is false too; redirecting now would push
  // an encrypted-but-locked household into the app before the
  // envelope fetch discovers it needs a password unlock. For a household with
  // no envelope the fetch returns an empty set within ~one quick network
  // call, so `unlockResolved` flips true almost immediately and the hold is
  // imperceptible. When an unlock is genuinely pending, render the prompt below.
  // Hold the redirect while setup is pending OR while the recovery key is still
  // on screen (post-setup, isUnlocked is true and needsSetup is false, but we
  // must keep the user here until they confirm they saved the key).
  // Also hold while `settingUp` is true: setupEncryption sets isUnlocked +
  // needsKeySetup before returning the key, so React can re-render with
  // needsSetup=false and recoveryKey=null (redirect condition met) before
  // setRecoveryKey(key) fires in onSetup. The settingUp flag spans the entire
  // onSetup async chain — and the factor modal's repair retry
  // — including the setRecoveryKey call, blocking the redirect until
  // the recovery modal renders.
  if (
    isAuthenticated &&
    unlockResolved &&
    !needsUnlock &&
    !needsSetup &&
    recoveryKey === null &&
    !settingUp
  ) {
    const raw = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;
    navigate(safeRedirect(raw), { replace: true });
  }

  const onUnlock = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setUnlockError(null);
    setUnlocking(true);
    try {
      if (useRecoveryMode) {
        await unlockWithRecovery(unlockPassword);
      } else {
        await unlockWithPassword(unlockPassword);
      }
      navigate('/dashboard', { replace: true });
    } catch {
      setUnlockError(
        useRecoveryMode
          ? 'That recovery key did not unlock your data. Please try again.'
          : 'That password did not unlock your data. Please try again.',
      );
    } finally {
      setUnlocking(false);
    }
  };

  // One-tap passkey unlock: runs a targeted PRF assertion
  // against the enrolled slot. Resolves the gap that the discoverable login
  // assertion can't carry the PRF salt before the user is identified. On failure
  // surface the same inline unlock error the password path uses and stay on the
  // prompt so the user can retry or fall back to the password / recovery key.
  const onUnlockWithPasskey = async () => {
    setUnlockError(null);
    setUnlocking(true);
    try {
      await unlockWithPasskey();
      navigate('/dashboard', { replace: true });
    } catch {
      setUnlockError(
        "We couldn't unlock your data with that passkey. Try your password or recovery key instead.",
      );
    } finally {
      setUnlocking(false);
    }
  };

  // Switch the unlock prompt between password and recovery-key modes, clearing
  // the entered value + any inline error so a value typed in one mode never
  // carries into the other. Returning to password mode re-seeds the dev default
  // (`''` off local-dev); recovery mode always starts empty — the dev password
  // is never a recovery key.
  const onToggleRecoveryMode = () => {
    const next = !useRecoveryMode;
    setUseRecoveryMode(next);
    setUnlockPassword(next ? '' : DEV_DEFAULT_PASSWORD);
    setUnlockError(null);
  };

  // Run `setupEncryption`, optionally carrying a step-up proof (the in-session
  // repair branch's retry). Shared by the
  // form submit and the factor modal's `onVerify` so the error handling lives in
  // one place.
  // `SetupStepUpRequiredError` is left to PROPAGATE: the two call sites below
  // handle it differently (the form submit shows the factor modal; the modal
  // itself must never re-trigger itself).
  const runSetup = async (proof?: StepUpProof): Promise<void> => {
    // setupEncryption returns the recovery key; hold the user here to show it
    // in RecoveryKeyModal until they confirm they've saved it.
    const key = await setupEncryption(setupPassword, proof);
    setRecoveryKey(key);
  };

  const onSetup = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSetupError(null);
    setSettingUp(true);
    try {
      await runSetup();
    } catch (err) {
      if (err instanceof SetupStepUpRequiredError) {
        // The repair branch (a stranded household — a `password` slot, no
        // `recovery` slot) needs a fresh factor. Fetch the account's eligible
        // factors on demand — this branch is reached only on a retry, never
        // on a genuinely fresh household — and show the factor modal instead
        // of a generic error.
        try {
          const status = await getMfaStatus();
          setSetupStepUpMethods(status.methods?.length ? status.methods : ['email_otp']);
          setSetupStepUpRecoveryMethods(status.recoveryMethods ?? []);
        } catch {
          // Status-read failure: fall back to the universal Email-OTP floor
          // (the defaults above) rather than blocking the repair outright.
        }
        setShowSetupFactor(true);
        return;
      }
      console.error('[setup] setupEncryption failed:', err);
      if (err instanceof ApiRequestError && err.error.code === 'INVALID_CREDENTIALS') {
        setSetupError('Incorrect password. Enter the same password you use to sign in.');
      } else {
        setSetupError('We could not set up encryption. Please try again.');
      }
    } finally {
      setSettingUp(false);
    }
  };

  // Fresh second-factor step-up for the repair branch. Reuses the
  // `setupEncryption` purpose it already runs
  // under (`key_envelope_replace`) — no new step-up purpose.
  const setupFactorStepUp = useStepUp({
    purpose: 'key_envelope_replace',
    methods: setupStepUpMethods,
    recoveryMethods: setupStepUpRecoveryMethods,
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: async (proof) => {
      // The same redirect hold `onSetup` keeps (see the render-time
      // redirect's comment): `setupEncryption` flips `isUnlocked` +
      // `needsKeySetup` BEFORE returning the key, so unless `settingUp` spans
      // this retry through `setRecoveryKey` too, the page navigates into the
      // app before the recovery-key modal ever mounts and the one-time key is
      // never shown.
      setSettingUp(true);
      try {
        await runSetup(proof);
      } finally {
        setSettingUp(false);
      }
    },
    onVerified: () => {
      setShowSetupFactor(false);
    },
  });
  const resetSetupFactorStepUp = setupFactorStepUp.reset;
  useEffect(() => {
    if (showSetupFactor) resetSetupFactorStepUp();
  }, [showSetupFactor, resetSetupFactorStepUp]);

  // The user confirmed they saved the recovery key (server-side state is
  // already finalized by setupEncryption). Clear the pending key and navigate.
  const onRecoveryConfirmed = () => {
    setRecoveryKey(null);
    navigate('/dashboard', { replace: true });
  };

  // Esc / scrim / Cancel must NOT dismiss past the saved-key gate. Losing every
  // unwrapper makes encrypted data unrecoverable (no operator escrow), so the
  // "I have saved my recovery key" checkbox + Continue is the only path into the
  // app — a dismiss keeps the modal open rather than navigating. The
  // user can still copy the key; they just cannot skip the confirmation.
  const onRecoveryDismiss = () => {
    // Intentional no-op: hold the user on the recovery-key modal.
  };

  // Reset any prior verification-resend state on a fresh login attempt or when
  // the email changes — the previous EMAIL_NOT_VERIFIED context no longer
  // applies, so the resend action + its status copy must not linger.
  const clearResendState = () => {
    setEmailNotVerified(false);
    setResendStatus(null);
  };

  const onEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(e.target.value);
    clearResendState();
  };

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    clearResendState();
    setSubmitting(true);
    try {
      await login(email, password);
      // Do NOT navigate here. Once auth settles the render-time redirect below
      // (`isAuthenticated && !needsUnlock`) sends the user to their intended
      // destination — or, if the household is encrypted and still locked, holds
      // them on /login to render the unlock prompt instead.
    } catch (err) {
      if (err instanceof ApiRequestError) {
        // A gateway-level throttle/timeout with no error envelope reads
        // the shared busy copy instead of the raw upstream status text.
        setError(isBusyResponse(err) ? BUSY_MESSAGE : err.error.message);
        // Offer the inline resend action only after an unverified-email failure.
        if (err.error.code === 'EMAIL_NOT_VERIFIED') setEmailNotVerified(true);
      } else {
        setError('Unable to sign in. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Request a fresh verification link for the email currently in the form. The
  // server is intentionally opaque about whether anything was sent (no account
  // enumeration); the SPA confirms only that the request was accepted. On
  // failure the inline copy renders in a `role="alert"` region without clearing
  // the original login error. Mirrors the SignupPage resend pattern.
  const onResend = async () => {
    setResending(true);
    setResendStatus(null);
    try {
      await resendVerification(email.trim());
      setResendStatus({
        tone: 'success',
        text: 'If your account is still unverified, a fresh link is on its way.',
      });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setResendStatus({ tone: 'error', text: err.error.message });
      } else {
        setResendStatus({
          tone: 'error',
          text: 'Could not request a new link right now. Try again shortly.',
        });
      }
    } finally {
      setResending(false);
    }
  };

  const onPasskeyLogin = async () => {
    clearResendState();
    setError(null);
    setSubmitting(true);
    try {
      await loginWithPasskey();
      // Same as the password path: let the render-time redirect handle
      // navigation so an encrypted-but-locked household stays for the unlock
      // prompt rather than being pushed into the app.
    } catch (err) {
      if (err instanceof ApiRequestError) {
        // A gateway-level throttle/timeout with no error envelope reads
        // the shared busy copy instead of the raw upstream status text.
        setError(isBusyResponse(err) ? BUSY_MESSAGE : err.error.message);
      } else {
        setError('Passkey sign in failed. Try again or use your password.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const showPasskeyButton = isPasskeySupported();

  // Two-step login MFA challenge. Rendered in place
  // of the sign-in form once a password login on an untrusted device returns a
  // challenge (no session yet). On a successful verify the session is adopted
  // and `mfaChallenge` clears → the render-time redirect (or the encryption
  // unlock/setup prompts above) takes over. No new-device modal.
  if (mfaChallenge) {
    return (
      <div className={AUTH_PAGE_WRAP}>
        <div className={AUTH_COLUMN_WIDTH}>
          <Card className={AUTH_CARD_WIDTH}>
            <AuthBrandRow />
            <MfaChallengeForm
              methods={mfaChallenge.methods}
              recoveryMethods={mfaChallenge.recoveryMethods}
              onVerify={async (method, code, rememberDevice) => {
                try {
                  const result = await verifyMfa(method, code, rememberDevice);
                  if (result.deviceRemembered) setDeviceTrustedNotice(true);
                  // On success `mfaChallenge` goes null and (if applicable)
                  // `isAuthenticated` flips true; the render-time redirect handles
                  // navigation. No explicit navigate here.
                } catch (err) {
                  // A challenge token that expired AFTER the code was entered
                  // (the 5-min login window lapsed mid-entry) maps back to the
                  // password form with a "your session expired" notice —
                  // mirrors the passkey path so the user signs in again to mint a
                  // fresh challenge. Every other failure is re-thrown for the
                  // form to display so the recovery factors stay usable.
                  if (
                    err instanceof ApiRequestError &&
                    err.error.code === 'MFA_CHALLENGE_EXPIRED'
                  ) {
                    clearMfaChallenge();
                    setError('Your session expired. Please sign in again.');
                    return;
                  }
                  throw err;
                }
              }}
              onVerifyPasskey={async (rememberDevice) => {
                try {
                  const result = await verifyMfaWithPasskey(rememberDevice);
                  if (result.deviceRemembered) setDeviceTrustedNotice(true);
                } catch (err) {
                  // A challenge token that expired AFTER a successful assertion
                  // (the 5-min login window lapsed mid-prompt) maps back to the
                  // password form with a "your session expired" notice —
                  // the user signs in again to mint a fresh challenge. Every
                  // other failure stays on the challenge form so the recovery
                  // factors remain usable (re-thrown for the form to display).
                  if (
                    err instanceof ApiRequestError &&
                    err.error.code === 'MFA_CHALLENGE_EXPIRED'
                  ) {
                    clearMfaChallenge();
                    setError('Your session expired. Please sign in again.');
                    return;
                  }
                  throw err;
                }
              }}
              onSendEmail={sendEmailOtp}
              onCancel={clearMfaChallenge}
            />
          </Card>
        </div>
      </div>
    );
  }

  // Post-auth first-time encryption setup. Rendered in
  // place of the sign-in form once the session exists but the household has no
  // key envelope yet. On success the recovery-key modal mounts over this
  // section; the user must confirm they saved the key before navigating.
  if (needsSetup || recoveryKey !== null) {
    return (
      <div className={AUTH_PAGE_WRAP}>
        <div className={AUTH_COLUMN_WIDTH}>
          <Card className={AUTH_CARD_WIDTH}>
            <section aria-labelledby="setup-heading">
              <AuthBrandRow />
              <h1 id="setup-heading" className={authHeadingClass}>
                Set up encryption
              </h1>
              <p className={`mb-3 ${authMutedClass}`}>
                Your financial data is encrypted before it leaves this device.
                Enter your account password (the same one you just signed in
                with). You&rsquo;ll get a recovery key next, in case you ever
                forget it.
              </p>
              {setupError && <Alert tone="error">{setupError}</Alert>}
              <form onSubmit={onSetup} noValidate>
                {/* Hidden username: lets password managers associate the
                    prompt with the signed-in account's credential. */}
                <HiddenUsernameField email={me?.email ?? ''} />
                <AuthPasswordField
                  id="setup-password"
                  name="setup-password"
                  autoComplete="current-password"
                  required
                  value={setupPassword}
                  onValueChange={setSetupPassword}
                />
                <button
                  type="submit"
                  disabled={settingUp || recoveryKey !== null}
                  className={authPrimaryButtonClass}
                >
                  {settingUp ? 'Setting up…' : 'Set up encryption'}
                </button>
              </form>
            </section>
          </Card>
        </div>
        {recoveryKey !== null && (
          <RecoveryKeyModal
            recoveryKey={recoveryKey}
            onConfirmed={onRecoveryConfirmed}
            onDismiss={onRecoveryDismiss}
          />
        )}
        {/* Repair-branch step-up: only ever
            shown on a retry, for a household stranded with a `password` slot
            and no `recovery` slot. */}
        <StepUpModal
          open={showSetupFactor}
          onClose={() => {
            if (setupFactorStepUp.submitting) return;
            setShowSetupFactor(false);
          }}
          title="Confirm it's you"
          stepUp={setupFactorStepUp}
          confirmLabel="Finish setup"
        >
          <p className={authMutedClass}>
            Encryption setup was interrupted earlier. Confirm it&rsquo;s you
            with a second factor to finish it.
          </p>
        </StepUpModal>
      </div>
    );
  }

  // Post-auth unlock prompt. Rendered in place of the
  // sign-in form once the session exists but the household data key still
  // needs a password to recover. Visually consistent with the auth form
  // (shared `auth-page-chrome`).
  if (needsUnlock) {
    return (
      <div className={AUTH_PAGE_WRAP}>
        <div className={AUTH_COLUMN_WIDTH}>
          <Card className={AUTH_CARD_WIDTH}>
            <section aria-labelledby="unlock-heading">
              <AuthBrandRow />
              <h1 id="unlock-heading" className={authHeadingClass}>
                Unlock your data
              </h1>
              <p className={`mb-3 ${authMutedClass}`}>
                Your financial data is encrypted.{' '}
                {useRecoveryMode
                  ? 'Enter your recovery key to unlock it on this device.'
                  : 'Enter your password to unlock it on this device.'}
              </p>
              {/* This device has a cached key or a rollback
                  pin, but the server just reported no encryption keys for the
                  household. Name the cause — never promise unlocking is
                  possible on this device; the start-over link below is the
                  only path forward for a genuine reset elsewhere. */}
              {lockedEnvelopeSetEmpty && (
                <Alert tone="warning" data-testid="locked-envelope-set-empty-notice">
                  The server says this household has no encryption keys, but
                  this device has used one before — so it stopped instead of
                  starting a new key on its own.
                </Alert>
              )}
              {unlockError && <Alert tone="error">{unlockError}</Alert>}
              <form onSubmit={onUnlock} noValidate>
                {useRecoveryMode ? (
                  <div className={authFieldClass()}>
                    <label htmlFor="unlock-recovery-key" className={authLabelClass}>
                      Recovery key
                    </label>
                    {/* Own id (not the password mode's "unlock-secret") so
                        manager heuristics never alias the two fields across
                        the toggle; PM_IGNORE_ATTRS because a recovery key is
                        a secret but not a credential — managers must not
                        overlay fill/save UI on it. */}
                    <TextInput
                      id="unlock-recovery-key"
                      name="unlock-recovery-key"
                      type="text"
                      autoComplete="off"
                      {...PM_IGNORE_ATTRS}
                      autoCapitalize="characters"
                      spellCheck={false}
                      required
                      placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                      value={unlockPassword}
                      onChange={(e) => setUnlockPassword(e.target.value)}
                      className={authInputClass}
                    />
                    {/* The displayed key is grouped with hyphens, but
                        decodeRecoveryKey strips everything non-hex — so neither
                        the hyphens nor the case actually matter. Say so, so the
                        user doesn't agonize over transcribing them exactly. */}
                    <p className={`mt-1 text-xs ${authMutedClass}`}>
                      Enter the recovery key you saved. Hyphens and
                      capitalization don&rsquo;t matter.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Hidden username (password mode only): lets managers
                        fill the right credential. Recovery mode carries no
                        username bait — nothing there should be saved. */}
                    <HiddenUsernameField email={me?.email ?? ''} />
                    <AuthPasswordField
                      id="unlock-secret"
                      name="unlock-password"
                      label="Password"
                      autoComplete="current-password"
                      required
                      value={unlockPassword}
                      onValueChange={setUnlockPassword}
                    />
                  </>
                )}
                <button
                  type="submit"
                  disabled={unlocking}
                  className={authPrimaryButtonClass}
                >
                  {unlocking ? 'Unlocking…' : 'Unlock'}
                </button>
              </form>
              {/* One-tap passkey unlock: a targeted PRF
                  assertion against the enrolled slot. Shown only when the
                  household has an enrolled passkey_prf slot AND the browser
                  supports WebAuthn — mirrors the sign-in passkey button's
                  divider + secondary styling. */}
              {hasPasskeyPrfSlot && isPasskeySupported() && (
                <>
                  <div className="my-3 flex items-center gap-3">
                    <hr className="flex-1 border-t border-line" />
                    <span className={`text-xs ${authMutedClass}`}>or</span>
                    <hr className="flex-1 border-t border-line" />
                  </div>
                  <button
                    type="button"
                    className={authSecondaryButtonClass}
                    onClick={onUnlockWithPasskey}
                    disabled={unlocking}
                  >
                    Unlock with passkey
                  </button>
                </>
              )}
              {/* Recovery-key / password toggle: a full-width
                  secondary button with its own "or" divider, mirroring the
                  passkey button above so all secondary unlock methods share one
                  visual vocabulary. In recovery mode with an enrolled passkey
                  slot the screen shows two stacked dividers + secondary buttons
                  (passkey first, then this toggle) — the expected layout when
                  all three unlock methods are available. */}
              <div className="my-3 flex items-center gap-3">
                <hr className="flex-1 border-t border-line" />
                <span className={`text-xs ${authMutedClass}`}>or</span>
                <hr className="flex-1 border-t border-line" />
              </div>
              <button
                type="button"
                className={authSecondaryButtonClass}
                onClick={onToggleRecoveryMode}
                disabled={unlocking}
              >
                {useRecoveryMode
                  ? 'Use your password instead'
                  : 'Use recovery key instead'}
              </button>
              <p className={`mt-2 text-center text-sm ${authMutedClass}`}>
                Lost access to your password and recovery key?{' '}
                <Link to="/security" className="underline">
                  Delete your encrypted data and start fresh
                </Link>{' '}
                in Settings → Security.
              </p>
            </section>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className={AUTH_PAGE_WRAP}>
      {/* Phone-width advisory: Retivo is laid
          out for tablets and computers, so a viewport under 640px gets a
          once-per-tab-session heads-up before signing in. */}
      <SmallScreenNotice />
      <div className={AUTH_COLUMN_WIDTH}>
        <Card className={AUTH_CARD_WIDTH}>
          <section aria-labelledby="login-heading">
            <AuthBrandRow />
            <h1 id="login-heading" className={authHeadingClass}>
              Sign in
            </h1>
            {/* Device-trust confirmation after a routine-factor MFA pass with
                "trust this device" checked. verifyMfa clears mfaChallenge
                in the same render that sets this notice, so it is rendered here
                on the sign-in surface — not inside the (now-gone) challenge
                block — to be visible during the brief post-verify hold before
                the redirect fires. */}
            {deviceTrustedNotice && (
              <div role="status" className={authNoticeClass('success')}>
                This device is now trusted — you won&rsquo;t be asked for a code
                here for the next 30 days.
              </div>
            )}
            {deletedNotice && (
              <div role="status" className={authNoticeClass('success')}>
                {deletedNotice}
              </div>
            )}
            {idleNotice && (
              <div role="status" className={authNoticeClass('neutral')}>
                {idleNotice}
              </div>
            )}
            {error && <Alert tone="error">{error}</Alert>}
            <form onSubmit={onSubmit} noValidate>
              <div className={authFieldClass()}>
                <label htmlFor="email" className={authLabelClass}>
                  Email
                </label>
                <TextInput
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={onEmailChange}
                  className={authInputClass}
                />
              </div>
              <AuthPasswordField
                id="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onValueChange={setPassword}
              />
              <button
                type="submit"
                disabled={submitting}
                className={authPrimaryButtonClass}
              >
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            {/* Verification-resend action, shown only after an
                EMAIL_NOT_VERIFIED login failure. The original login error
                (the Alert above) stays visible; the resend success / failure
                copy renders in its own live region below the button. */}
            {emailNotVerified && (
              <>
                <button
                  type="button"
                  className={authSecondaryButtonClass}
                  onClick={onResend}
                  disabled={resending}
                >
                  {resending ? 'Sending…' : 'Resend verification email'}
                </button>
                {resendStatus && (
                  <p
                    role={resendStatus.tone === 'error' ? 'alert' : 'status'}
                    className={`mt-4 text-sm ${
                      resendStatus.tone === 'error' ? 'text-negative' : 'text-positive'
                    }`}
                  >
                    {resendStatus.text}
                  </p>
                )}
              </>
            )}

            <p className={`mt-3 text-center text-sm ${authMutedClass}`}>
              <Link
                to="/auth/request-password-reset"
                className={textLinkClass}
              >
                Forgot password?
              </Link>
            </p>

            {showPasskeyButton && (
              <>
                <div className="my-3 flex items-center gap-3">
                  <hr className="flex-1 border-t border-line" />
                  <span className={`text-xs ${authMutedClass}`}>or</span>
                  <hr className="flex-1 border-t border-line" />
                </div>
                <button
                  type="button"
                  className={authSecondaryButtonClass}
                  onClick={onPasskeyLogin}
                  disabled={submitting}
                >
                  Sign in with a passkey
                </button>
              </>
            )}
            <p className={`mt-4 text-center ${authMutedClass}`}>
              Don&rsquo;t have an account?{' '}
              <Link to="/signup" className={textLinkClass}>
                Sign up
              </Link>
            </p>
          </section>
        </Card>
        {/*
          Static public-computer advisory below the login card. Always shown,
          no detection/dismiss. role="status" (not the warning tone's default
          assertive role="alert") because this is a standing note, not a
          dynamic state change — a polite, non-interrupting region is correct
          for an always-present advisory.
        */}
        <Alert tone="warning" role="status" className="mt-4">
          Avoid signing in on a public or shared computer. If you must, sign out
          when you&rsquo;re done and use &ldquo;Clear data on this device&rdquo;
          (under Settings &rarr; Workspace) so your financial information
          isn&rsquo;t left behind.
        </Alert>
      </div>
    </div>
  );
};
