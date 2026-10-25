/** Password-reset consume page. The token arrives in the URL fragment (never sent to the server or logged at the edge); read once on mount, then scrubbed via history.replaceState.
* A reset cannot unwrap the encrypted password slot, so the next sign-in lands on the "Unlock your data" prompt; the up-front warning sets that expectation. */
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
  // Read once on mount; the effect below scrubs the fragment before any later render, so this state is the only surviving copy.
  const [token] = useState<string>(readTokenFromFragment);
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

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
      navigate('/login', { replace: true });
    } catch (err) {
      // A gateway-level throttle or timeout with no error envelope reads the shared busy copy.
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
            {/* Best-effort hidden username from the last-known sign-in email (this page only has the token), so the manager's "update password?" prompt targets the right credential. */}
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
