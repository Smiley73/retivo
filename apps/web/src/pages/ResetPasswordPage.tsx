/**
 * Password-reset consume page. The reset mail link points here with the
 * token in the URL fragment (`#token=…` — never sent to the server, never
 * logged at the edge). We read it once on mount,
 * scrub it from the URL via `history.replaceState` so a back-button or
 * share doesn't expose it, then let the user set a new password.
 *
 * On a successful reset the endpoint returns 204; we redirect to /login so
 * the user signs in with the new password. Because a reset cannot unwrap
 * the encrypted `password` slot, the post-reset sign-in lands on the
 * "Unlock your data" prompt where the recovery key / passkey re-keys it.
 * The up-front warning here sets that expectation.
 *
 * Layout mirrors LoginPage / VerifyEmailPage: a centered card built from
 * shared typed components + the shared auth chrome.
 */
import React, { useEffect, useState } from 'react';
import { textLinkClass } from '../components/TextLink';
import { Link, useNavigate } from 'react-router';
import { useAuth, readStoredAuthEmail } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { BUSY_MESSAGE, isBusyResponse } from '../api/busy-response';
import { Card } from '../components/Card';
import { Alert } from '../components/Alert';
import { HiddenUsernameField } from '../components/password-manager';
import {
  AUTH_PAGE_WRAP,
  AUTH_CARD_WIDTH,
  AuthBrandRow,
  AuthPasswordField,
  authPrimaryButtonClass,
  authMutedClass,
  authHeadingClass,
} from './auth-page-chrome';

function readTokenFromFragment(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!hash) return '';
  const parsed = new URLSearchParams(hash);
  return parsed.get('token') ?? '';
}

export const ResetPasswordPage: React.FC = () => {
  const { resetPassword } = useAuth();
  const navigate = useNavigate();
  // Read once on mount; the effect below scrubs the fragment before any
  // subsequent render so this state is the only surviving copy.
  const [token] = useState<string>(readTokenFromFragment);
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Scrub the fragment from the URL once we've captured the token so a
  // back-button, share, or browser-history snapshot doesn't keep it around.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.location.hash) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError('This reset link is missing its token. Request a new link.');
      return;
    }
    if (newPassword !== confirm) {
      setError('The two passwords don’t match.');
      return;
    }
    setSubmitting(true);
    try {
      await resetPassword(token, newPassword);
      setDone(true);
      // 204 success: send the user to sign in with the new password. The
      // post-login unlock prompt then re-keys their encrypted data.
      navigate('/login', { replace: true });
    } catch (err) {
      // A gateway-level throttle/timeout with no error envelope reads
      // the shared busy copy instead of the raw upstream status text.
      if (err instanceof ApiRequestError) setError(isBusyResponse(err) ? BUSY_MESSAGE : err.error.message);
      else setError('Could not reset your password. The link may have expired. Request a new one.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={AUTH_PAGE_WRAP}>
      <Card className={AUTH_CARD_WIDTH}>
        <section aria-labelledby="reset-password-heading">
          <AuthBrandRow />
          <h1 id="reset-password-heading" className={authHeadingClass}>
            Set a new password
          </h1>
          {/* Up-front recovery-key warning, plain English. */}
          <Alert tone="warning" role="status" className="mb-4">
            Setting a new password lets you sign in again, but it does
            <strong> not</strong> unlock your saved financial data. Right after
            this you&rsquo;ll be asked for your recovery key (or a passkey on
            this device) to unlock it. Without one of those, your encrypted
            data can&rsquo;t be recovered.
          </Alert>
          {error && <Alert tone="error">{error}</Alert>}
          {!token && !error && (
            <Alert tone="error">
              This reset link is missing its token. Request a new link from the
              sign-in page.
            </Alert>
          )}
          <form onSubmit={onSubmit} noValidate>
            {/* Best-effort hidden username from the last-known sign-in email
                (this page only has the reset token), so the manager's
                "update password?" prompt targets the right credential. */}
            <HiddenUsernameField email={readStoredAuthEmail()} />
            <AuthPasswordField
              id="new-password"
              name="new-password"
              label="New password"
              autoComplete="new-password"
              required
              ariaInvalid={!!error}
              value={newPassword}
              onValueChange={setNewPassword}
            />
            <AuthPasswordField
              id="confirm-password"
              name="confirm-password"
              label="Confirm new password"
              autoComplete="new-password"
              required
              ariaInvalid={!!error}
              value={confirm}
              onValueChange={setConfirm}
            />
            <button
              type="submit"
              disabled={submitting || done || !newPassword || !confirm}
              className={authPrimaryButtonClass}
            >
              {submitting ? 'Setting password…' : 'Set new password'}
            </button>
          </form>
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
