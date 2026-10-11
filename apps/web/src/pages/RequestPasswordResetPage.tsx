/**
 * "Forgot your password?" entry page. Collects an email and POSTs it to
 * the request-reset endpoint, which always returns an opaque 202 (never
 * reveals whether the account exists). We surface the same "if an account
 * exists, a link is on its way" copy regardless, so the page is not a
 * user-existence oracle.
 *
 * Up-front recovery-key warning: completing a reset restores sign-in,
 * NOT access to encrypted data — the saved recovery key (or an enrolled
 * passkey) is required to unlock afterward. Worded in plain English.
 *
 * Layout mirrors LoginPage / VerifyEmailPage: a centered card outside the
 * app shell, built from shared typed components + the shared auth chrome.
 */
import React, { useState } from 'react';
import { textLinkClass } from '../components/TextLink';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { BUSY_MESSAGE, isBusyResponse } from '../api/busy-response';
import { Card } from '../components/Card';
import { Alert } from '../components/Alert';
import { TextInput } from '../components/TextInput';
import {
  AUTH_PAGE_WRAP,
  AUTH_CARD_WIDTH,
  AuthBrandRow,
  authFieldClass,
  authLabelClass,
  authInputClass,
  authPrimaryButtonClass,
  authMutedClass,
  authHeadingClass,
  DevShortcutBadge,
  authDevLinkClass,
} from './auth-page-chrome';

export const RequestPasswordResetPage: React.FC = () => {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setStatus(null);
    setDevLink(null);
    try {
      const res = await requestPasswordReset(email.trim());
      // Opaque response: the copy is identical whether or not the account
      // exists. The dev token (non-prod, real send only) drives a click-
      // through shortcut so local dev works without a real SES delivery.
      setStatus(
        'If an account exists for that email, a password-reset link is on its way. The link is valid for 15 minutes.',
      );
      if (res.resetToken) {
        setDevLink(`/auth/reset-password#token=${encodeURIComponent(res.resetToken)}`);
      }
    } catch (err) {
      // A gateway-level throttle/timeout with no error envelope reads
      // the shared busy copy instead of the raw upstream status text.
      if (err instanceof ApiRequestError) setError(isBusyResponse(err) ? BUSY_MESSAGE : err.error.message);
      else setError('Could not request a reset link right now. Try again shortly.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={AUTH_PAGE_WRAP}>
      <Card className={AUTH_CARD_WIDTH}>
        <section aria-labelledby="request-reset-heading">
          <AuthBrandRow />
          <h1 id="request-reset-heading" className={authHeadingClass}>
            Reset your password
          </h1>
          <p className={`mb-3 ${authMutedClass}`}>
            Enter the email you signed in with and we&rsquo;ll send a link to
            set a new password.
          </p>
          {/* Up-front recovery-key warning, plain English. */}
          <Alert tone="warning" role="status" className="mb-4">
            Resetting your password lets you sign in again, but it does
            <strong> not</strong> unlock your saved financial data. After you
            reset, you&rsquo;ll need your recovery key (or a passkey you set up
            on this device) to unlock it. Without one of those, your encrypted
            data can&rsquo;t be recovered.
          </Alert>
          {error && <Alert tone="error">{error}</Alert>}
          <form onSubmit={onSubmit} noValidate>
            <div className={authFieldClass()}>
              <label htmlFor="reset-email" className={authLabelClass}>
                Email
              </label>
              <TextInput
                id="reset-email"
                name="reset-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={authInputClass}
              />
            </div>
            <button
              type="submit"
              disabled={submitting || !email.trim()}
              className={authPrimaryButtonClass}
            >
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
          {status && (
            <p role="status" className={`mt-4 ${authMutedClass}`}>
              {status}
            </p>
          )}
          {devLink && (
            <p className={authMutedClass}>
              <small>
                {/* Plain anchor (not <Link>) so the navigation is a full
                    reload — ResetPasswordPage reads the token from the URL
                    fragment only at mount. */}
                <DevShortcutBadge />{' '}
                <a href={devLink} className={authDevLinkClass}>
                  reset now
                </a>
                .
              </small>
            </p>
          )}
          <p className={`mt-4 text-center ${authMutedClass}`}>
            <Link to="/login" className={textLinkClass}>
              Back to sign in
            </Link>
          </p>
        </section>
      </Card>
    </div>
  );
};
