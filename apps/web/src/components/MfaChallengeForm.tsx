/**
 * Two-step login MFA challenge (enforced MFA). Shown by the
 * LoginPage in place of the sign-in form once a password login on an untrusted
 * device returns a challenge (no session yet). The user picks an offered
 * second factor, enters the code, and may remember the device for ~30 days.
 *
 * Factor model:
 *  - `methods` are the ROUTINE factors (passkey first when enrolled, then
 *    `totp`, else `email_otp` as the standing universal factor).
 *  - `recoveryMethods` contains `email_otp` as the "can't use my
 *    authenticator?" path once a stronger factor is enrolled.
 *  - "Trust this device" is offered only for a routine factor — never for an
 *    Email-OTP recovery pass (the server declines the remember
 *    request and returns `deviceRemembered: false`; the UI hides the checkbox
 *    so we don't promise trust we won't get).
 *
 * Password-manager interop (see "Password managers" in docs/ui-conventions.md): a real
 * `<form>` with `autocomplete="one-time-code"` + `inputMode="numeric"` on the
 * code field, plus `PM_IGNORE_ATTRS` so manager overlays don't fight the OTP
 * field. The login form upstream already carries the `HiddenUsernameField`, so
 * none is needed here.
 *
 * Built on the shared auth-page chrome + React Aria primitives (the method tabs
 * are a `SegmentedRadioGroup`; the trust toggle is a React Aria `Checkbox`).
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
  /** Routine factors offered (e.g. `['passkey']`, `['totp']`, `['email_otp']`). */
  methods: string[];
  /** Recovery/fallback factors (currently `['email_otp']`). */
  recoveryMethods: string[];
  /** Verify a code factor (totp/email_otp); rejects on a wrong/expired code. */
  onVerify: (method: string, code: string, rememberDevice: boolean) => Promise<void>;
  /**
   * Complete the challenge with a passkey (passkey as second factor):
   * runs the WebAuthn assertion + verify. Rejects on a server error OR a
   * cancelled/failed WebAuthn prompt (the form shows non-alarming retry copy).
   * Only wired when the form renders the passkey factor.
   */
  onVerifyPasskey?: (rememberDevice: boolean) => Promise<void>;
  /** Send a fresh Email-OTP for the pending challenge. */
  onSendEmail: () => Promise<void>;
  /** Back out to the sign-in form. */
  onCancel: () => void;
}

/** Plain-language label for each factor (layman default). */
type MfaChallengeMethod = 'passkey' | 'totp' | 'email_otp';

const METHOD_LABEL: Record<MfaChallengeMethod, string> = {
  passkey: 'Passkey',
  totp: 'Authenticator app',
  email_otp: 'Email code',
};

/**
 * Keep the browser compatible with an older server response without exposing
 * retired or unknown factors in the UI.
 */
function isSupportedMethod(method: string): method is MfaChallengeMethod {
  return method === 'passkey' || method === 'totp' || method === 'email_otp';
}

/** Routine factors may mint device trust: passkey, TOTP, or Email-OTP
 *  only when it is offered as a routine method (not merely as recovery). */
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
  // The passkey factor is offered only when the browser supports WebAuthn AND
  // the caller wired a passkey handler. On an unsupported browser the
  // factor is hidden and selection falls through to the next factor, so a
  // passkey-only user is never stranded — they land on a usable recovery factor.
  const passkeySupported = useMemo(
    () => browserSupportsWebAuthn() && typeof onVerifyPasskey === 'function',
    [onVerifyPasskey],
  );

  // Tab order: routine factors first (the steered-toward options), then any
  // recovery factors not already listed. De-dupe so a method that is both
  // routine and recovery shows once, and drop `passkey` on an unsupported
  // browser so it is never selectable.
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

  // Auto-select the strongest routine factor: passkey leads whenever
  // offered + supported, then TOTP, else the first remaining offered method.
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

  // Switching factors clears the entered code + any error so a code typed for
  // one method never carries into another.
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
    // The passkey factor has no code field — it runs a WebAuthn assertion.
    if (isPasskey) {
      await runPasskey();
      return;
    }
    if (code.trim() === '') return;
    setError(null);
    setSubmitting(true);
    try {
      // Only a routine pass can carry the remember-device request; a
      // recovery factor always sends false so the server's decline is moot.
      await onVerify(active, code.trim(), showTrust && rememberDevice);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        // A gateway-level throttle/timeout with no error envelope reads
        // the shared busy copy instead of the raw upstream status text.
        setError(isBusyResponse(err) ? BUSY_MESSAGE : err.error.message);
      } else {
        setError('That code did not work. Please try again.');
      }
      setSubmitting(false);
    }
    // On success the form unmounts (the session is adopted), so there is no
    // need to clear `submitting` — leaving it true keeps the button disabled
    // during the brief teardown.
  };

  // Run the passkey assertion (passkey as second factor). A
  // cancelled/failed WebAuthn prompt or a server rejection surfaces
  // non-alarming retry copy — NOT the "that code did not work" message,
  // which is wrong for a passkey — and keeps the form mounted so the recovery
  // tabs stay selectable. On success the form unmounts (session adopted).
  const runPasskey = async (): Promise<void> => {
    if (!onVerifyPasskey) return;
    setError(null);
    setSubmitting(true);
    try {
      await onVerifyPasskey(showTrust && rememberDevice);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        // A server rejection (expired challenge, UV/counter anomaly) — show its
        // human message, unless the response carries no error envelope at all
        // (a gateway-level throttle/timeout), which reads the shared
        // busy copy instead.
        setError(isBusyResponse(err) ? BUSY_MESSAGE : err.error.message);
      } else {
        // A WebAuthn cancel/timeout/NotAllowedError/SecurityError, or a network
        // hiccup — non-alarming, actionable copy.
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

      {/* Error region: announced politely so a wrong-code message reaches
          assistive tech without stealing focus mid-correction. */}
      <div aria-live="polite">
        {error && <Alert tone="error">{error}</Alert>}
        {emailSent && !error && (
          <p role="status" className={`mb-3 text-sm text-positive`}>
            We sent a code to your email. Enter it below.
          </p>
        )}
      </div>

      <form onSubmit={onSubmit} noValidate>
        {/* The passkey factor has no code field — the WebAuthn assertion is the
            proof. The other factors render the code input. */}
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
