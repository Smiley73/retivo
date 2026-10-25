/** Local-credential sign-in page, rendered outside the app shell; also hosts the MFA challenge and the encryption unlock and setup prompts. */
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
  const [deviceTrustedNotice, setDeviceTrustedNotice] = useState(false);
  // After an EMAIL_NOT_VERIFIED failure the resend action shows; its status has its own live region, and all three reset on resubmit or email change.
  const [emailNotVerified, setEmailNotVerified] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendStatus, setResendStatus] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  // Zero-knowledge unlock (see "Unlocking" in docs/security.md): hold the user here for a password unlock when the session exists but the household key is not in memory.
  const [unlockPassword, setUnlockPassword] = useState(DEV_DEFAULT_PASSWORD);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [useRecoveryMode, setUseRecoveryMode] = useState(false);
  // First-time setup: hold the user here to key the household, then to show the recovery key until they confirm it is saved.
  const [setupPassword, setSetupPassword] = useState(DEV_DEFAULT_PASSWORD);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  // In-session repair: a household stranded with a password slot and no recovery slot needs a fresh factor when AUTH_MFA_ENFORCED is on (setupEncryption throws SetupStepUpRequiredError).
  const [showSetupFactor, setShowSetupFactor] = useState(false);
  const [setupStepUpMethods, setSetupStepUpMethods] = useState<string[]>(['email_otp']);
  const [setupStepUpRecoveryMethods, setSetupStepUpRecoveryMethods] = useState<string[]>([]);
  // Until unlockResolved, all unlock flags are transiently false and would flash the unlock prompt on every login.
  const needsUnlock =
    isAuthenticated && !isUnlocked && !needsKeySetup && !isBooting && unlockResolved;
  const needsSetup =
    isAuthenticated && needsKeySetup && !isUnlocked && !isBooting && unlockResolved;

  // Clear the unlock prompt's secret state when it is inactive: a typed recovery key must not reappear in the next locked session's recovery-mode field.
  useEffect(() => {
    if (!needsUnlock) {
      setUseRecoveryMode(false);
      setUnlockPassword(DEV_DEFAULT_PASSWORD);
      setUnlockError(null);
    }
  }, [needsUnlock]);

  // Pre-select recovery mode for /login?mode=recovery. Keyed on needsUnlock because the clearing effect above resets recovery mode on mount, which would overwrite a useState initializer.
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

  useEffect(() => {
    return () => setDeviceTrustedNotice(false);
  }, []);

  // Redirect only after unlockResolved: before it, needsUnlock is transiently false and an encrypted-but-locked household would be pushed into the app.
  // Also hold while setup is pending, while the recovery key is on screen, and while settingUp: setupEncryption flips isUnlocked and needsKeySetup before the key reaches setRecoveryKey.
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

  // Targeted PRF assertion: the discoverable login assertion cannot carry the PRF salt before the user is identified.
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

  // Clear the value and error on toggle so a value typed in one mode never carries into the other; the dev password is never a recovery key.
  const onToggleRecoveryMode = () => {
    const next = !useRecoveryMode;
    setUseRecoveryMode(next);
    setUnlockPassword(next ? '' : DEV_DEFAULT_PASSWORD);
    setUnlockError(null);
  };

  // SetupStepUpRequiredError is left to propagate: the form submit shows the factor modal, and the modal itself must never re-trigger itself.
  const runSetup = async (proof?: StepUpProof): Promise<void> => {
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
        // The repair branch (password slot, no recovery slot) needs a fresh factor, fetched on demand since it is reached only on a retry.
        try {
          const status = await getMfaStatus();
          setSetupStepUpMethods(status.methods?.length ? status.methods : ['email_otp']);
          setSetupStepUpRecoveryMethods(status.recoveryMethods ?? []);
        } catch {
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

  const setupFactorStepUp = useStepUp({
    purpose: 'key_envelope_replace',
    methods: setupStepUpMethods,
    recoveryMethods: setupStepUpRecoveryMethods,
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: async (proof) => {
      // Keep settingUp across this retry through setRecoveryKey, or the page navigates before the one-time recovery key is shown.
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

  const onRecoveryConfirmed = () => {
    setRecoveryKey(null);
    navigate('/dashboard', { replace: true });
  };

  // Esc, scrim and Cancel must not dismiss past the saved-key gate: losing every unwrapper makes encrypted data unrecoverable (no operator escrow).
  const onRecoveryDismiss = () => {
  };

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
      // Do not navigate: the render-time redirect sends the user on, or holds them on /login for the unlock prompt if the household is still locked.
    } catch (err) {
      if (err instanceof ApiRequestError) {
        // A gateway-level throttle or timeout with no error envelope reads the shared busy copy.
        setError(isBusyResponse(err) ? BUSY_MESSAGE : err.error.message);
        if (err.error.code === 'EMAIL_NOT_VERIFIED') setEmailNotVerified(true);
      } else {
        setError('Unable to sign in. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  // The server is opaque about whether anything was sent (no account enumeration); the SPA confirms only that the request was accepted.
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
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(isBusyResponse(err) ? BUSY_MESSAGE : err.error.message);
      } else {
        setError('Passkey sign in failed. Try again or use your password.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const showPasskeyButton = isPasskeySupported();

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
                } catch (err) {
                  // An expired challenge token (the 5-min login window lapsed) returns to the password form with a session-expired notice; other failures are re-thrown so the recovery factors stay usable.
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
                {/* Hidden username lets password managers associate the prompt with the signed-in account. */}
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
              {/* A cached key or rollback pin exists but the server reports no keys: name the cause and never promise unlocking is possible here. */}
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
                    {/* Own id so managers never alias it with the password field; PM_IGNORE_ATTRS because a recovery key is a secret, not a credential. */}
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
                    {/* decodeRecoveryKey strips everything non-hex, so neither hyphens nor case matter. */}
                    <p className={`mt-1 text-xs ${authMutedClass}`}>
                      Enter the recovery key you saved. Hyphens and
                      capitalization don&rsquo;t matter.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Hidden username in password mode only: recovery mode carries no username bait, nothing there should be saved. */}
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
      <SmallScreenNotice />
      <div className={AUTH_COLUMN_WIDTH}>
        <Card className={AUTH_CARD_WIDTH}>
          <section aria-labelledby="login-heading">
            <AuthBrandRow />
            <h1 id="login-heading" className={authHeadingClass}>
              Sign in
            </h1>
            {/* Rendered here, not in the challenge block: verifyMfa clears mfaChallenge in the same render that sets this notice. */}
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
        {/* role="status": a standing advisory, not the warning tone's default assertive alert. */}
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
