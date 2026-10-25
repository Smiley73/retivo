/**
 * Two-step login MFA challenge shown in place of the sign-in form on an untrusted device; password-manager interop
 * per "Password managers" in docs/ui-conventions.md.
 */
import React, { useMemo, useState } from 'react';
import { Checkbox } from 'react-aria-components';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { TextInput } from './TextInput';
import { PM_IGNORE_ATTRS } from './password-manager';
import { Alert } from './Alert';
import { ApiRequestError } from '../api/client';
import { BUSY_MESSAGE, isBusyResponse } from '../api/busy-response';
import {
  authFieldClass,
  authLabelClass,
  authInputClass,
  authPrimaryButtonClass,
  authSecondaryButtonClass,
  authMutedClass,
  authHeadingClass,
} from '../pages/auth-page-chrome';
import { SegmentedRadioGroup } from './SegmentedRadioGroup';

export interface MfaChallengeFormProps {
  /** Routine factors offered, e.g. `['passkey']`. */
  methods: string[];
  /** Fallback factors (currently `['email_otp']`). */
  recoveryMethods: string[];
  /** Verifies a code factor; rejects on a wrong or expired code. */
  onVerify: (method: string, code: string, rememberDevice: boolean) => Promise<void>;
  /**
   * Completes the challenge with a passkey; rejects on a server error or a cancelled WebAuthn
   * prompt. Wired only when the passkey factor renders.
   */
  onVerifyPasskey?: (rememberDevice: boolean) => Promise<void>;
  /** Sends a fresh Email-OTP. */
  onSendEmail: () => Promise<void>;
  /** Back out to the sign-in form. */
  onCancel: () => void;
}

type MfaChallengeMethod = 'passkey' | 'totp' | 'email_otp';

const METHOD_LABEL: Record<MfaChallengeMethod, string> = {
  passkey: 'Passkey',
  totp: 'Authenticator app',
  email_otp: 'Email code',
};

function isSupportedMethod(method: string): method is MfaChallengeMethod {
  return method === 'passkey' || method === 'totp' || method === 'email_otp';
}

// Trust is minted only for routine factors; an Email-OTP recovery pass is declined by the server,
// so the checkbox is hidden.
function canTrustDevice(method: MfaChallengeMethod, routineMethods: string[]): boolean {
  return routineMethods.includes(method);
}

export const MfaChallengeForm: React.FC<MfaChallengeFormProps> = ({
  methods,
  recoveryMethods,
  onVerify,
  onVerifyPasskey,
  onSendEmail,
  onCancel,
}) => {
  // Hidden when WebAuthn is unsupported, so a passkey-only user falls through to a usable recovery
  // factor.
  const passkeySupported = useMemo(
    () => browserSupportsWebAuthn() && typeof onVerifyPasskey === 'function',
    [onVerifyPasskey],
  );

  // Routine factors first, then recovery ones, de-duplicated; `passkey` is dropped on an
  // unsupported browser.
  const allMethods = useMemo(() => {
    const seen = new Set<MfaChallengeMethod>();
    return [...methods, ...recoveryMethods].filter((m): m is MfaChallengeMethod => {
      if (!isSupportedMethod(m)) return false;
      if (m === 'passkey' && !passkeySupported) return false;
      if (seen.has(m)) return false;
      seen.add(m);
      return true;
    });
  }, [methods, recoveryMethods, passkeySupported]);

  const [active, setActive] = useState<MfaChallengeMethod>(() => {
    if (passkeySupported && methods.includes('passkey')) return 'passkey';
    if (methods.includes('totp')) return 'totp';
    return allMethods[0] ?? 'email_otp';
  });
  const [code, setCode] = useState('');
  const [rememberDevice, setRememberDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);

  const isPasskey = active === 'passkey';
  const showTrust = canTrustDevice(active, methods);
  const showSendEmail = active === 'email_otp' && allMethods.includes('email_otp');

  // Clears the code and error so a code typed for one method never carries into another.
  const onMethodChange = (next: string): void => {
    if (!isSupportedMethod(next)) return;
    setActive(next);
    setCode('');
    setError(null);
    setEmailSent(false);
  };

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    if (isPasskey) {
      await runPasskey();
      return;
    }
    if (code.trim() === '') return;
    setError(null);
    setSubmitting(true);
    try {
      // A recovery factor always sends false, so the server's decline is moot.
      await onVerify(active, code.trim(), showTrust && rememberDevice);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        // A gateway-level throttle or timeout has no error envelope; show the shared busy copy.
        setError(isBusyResponse(err) ? BUSY_MESSAGE : err.error.message);
      } else {
        setError('That code did not work. Please try again.');
      }
      setSubmitting(false);
    }
    // On success the form unmounts, so `submitting` stays true to keep the button disabled during
    // teardown.
  };

  // A cancelled or failed WebAuthn prompt shows retry copy, not "that code did not work", and keeps
  // the recovery tabs selectable.
  const runPasskey = async (): Promise<void> => {
    if (!onVerifyPasskey) return;
    setError(null);
    setSubmitting(true);
    try {
      await onVerifyPasskey(showTrust && rememberDevice);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        // A gateway-level throttle or timeout has no error envelope; show the shared busy copy.
        setError(isBusyResponse(err) ? BUSY_MESSAGE : err.error.message);
      } else {
        setError("We couldn't verify your passkey. Try again, or use another option.");
      }
      setSubmitting(false);
    }
  };

  const onSend = async (): Promise<void> => {
    setSendingEmail(true);
    setError(null);
    try {
      await onSendEmail();
      setEmailSent(true);
    } catch {
      setError('We could not send a code right now. Please try again shortly.');
    } finally {
      setSendingEmail(false);
    }
  };

  return (
    <section aria-labelledby="mfa-challenge-heading">
      <h1 id="mfa-challenge-heading" className={authHeadingClass}>
        Two-factor authentication
      </h1>
      <p className={`mb-3 ${authMutedClass}`}>
        {isPasskey
          ? 'Use your passkey to finish signing in — your device will ask you to confirm.'
          : active === 'totp'
            ? 'Enter the 6-digit code from your authenticator app.'
            : 'We can email you a 6-digit code to finish signing in.'}
      </p>

      {allMethods.length > 1 && (
        <div className="mb-3">
          <SegmentedRadioGroup
            ariaLabel="Verification method"
            size="sm"
            value={active}
            onChange={onMethodChange}
            options={allMethods.map((m) => ({
              value: m,
              label: METHOD_LABEL[m],
            }))}
          />
        </div>
      )}

      {/* Polite live region so a wrong-code message reaches assistive tech without stealing
          focus. */}
      <div aria-live="polite">
        {error && <Alert tone="error">{error}</Alert>}
        {emailSent && !error && (
          <p role="status" className={`mb-3 text-sm text-positive`}>
            We sent a code to your email. Enter it below.
          </p>
        )}
      </div>

      <form onSubmit={onSubmit} noValidate>
        {!isPasskey && (
          <div className={authFieldClass()}>
            <label htmlFor="mfa-code" className={authLabelClass}>
              Verification code
            </label>
            <TextInput
              id="mfa-code"
              name="mfa-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              {...PM_IGNORE_ATTRS}
              autoCapitalize="characters"
              spellCheck={false}
              required
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={authInputClass}
            />
          </div>
        )}

        {showSendEmail && (
          <button
            type="button"
            className={`${authSecondaryButtonClass} mb-3`}
            onClick={onSend}
            disabled={sendingEmail}
          >
            {sendingEmail ? 'Sending…' : 'Send code by email'}
          </button>
        )}

        {showTrust && (
          <Checkbox
            isSelected={rememberDevice}
            onChange={setRememberDevice}
            className="group mb-3 flex cursor-pointer items-start gap-2 text-sm text-ink"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-5 flex-none items-center justify-center rounded border border-input-line bg-surface text-accent-ink group-data-[selected]:border-accent group-data-[selected]:bg-accent group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-ring group-data-[focus-visible]:ring-offset-2"
            >
              <svg viewBox="0 0 16 16" className="size-3.5 opacity-0 group-data-[selected]:opacity-100" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span>Trust this device for 30 days</span>
          </Checkbox>
        )}

        <button
          type="submit"
          className={authPrimaryButtonClass}
          disabled={submitting || (!isPasskey && code.trim() === '')}
        >
          {submitting ? 'Verifying…' : isPasskey ? 'Use a passkey' : 'Continue'}
        </button>
      </form>

      <p className="mt-3 text-center text-sm">
        <button
          type="button"
          className={`underline ${authMutedClass}`}
          onClick={onCancel}
        >
          &larr; Back to sign in
        </button>
      </p>
    </section>
  );
};
