/**
 * Email-verification landing route. The signup mail link points here
 * with the token in the URL fragment (`#token=…` — never sent to the
 * server, never logged at the edge). We extract
 * it once on mount, scrub it from the URL via `history.replaceState`
 * so a back-button or copy-and-share doesn't expose it, then POST it
 * to the API. Error path lets the user request a fresh link without
 * re-entering their password.
 *
 * Layout mirrors LoginPage / SignupPage: centered card outside the app
 * shell so the unauthenticated surface stays visually consistent.
 */
import React, { useEffect, useState } from 'react';
import { textLinkClass } from '../components/TextLink';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { Card } from '../components/Card';
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

type Status =
  | { kind: 'verifying' }
  | { kind: 'verified'; approvalToken?: string }
  | { kind: 'error'; message: string };

function readTokenFromFragment(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!hash) return '';
  const parsed = new URLSearchParams(hash);
  return parsed.get('token') ?? '';
}

export const VerifyEmailPage: React.FC = () => {
  const { verifyEmail, resendVerification } = useAuth();
  // Read once on mount; the effect below scrubs the fragment before
  // any subsequent render so this state is the only surviving copy.
  const [token] = useState<string>(readTokenFromFragment);
  const [status, setStatus] = useState<Status>({ kind: 'verifying' });
  const [resendEmail, setResendEmail] = useState('');
  const [resending, setResending] = useState(false);
  const [resendStatus, setResendStatus] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  const [resendDevLink, setResendDevLink] = useState<string | null>(null);
  const verifiedTokenRef = React.useRef<string | null>(null);

  // Scrub the fragment from the URL as soon as we've captured it so a
  // back-button, share, or browser-history snapshot doesn't keep the
  // raw token around. Runs once after the first render.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.location.hash) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  useEffect(() => {
    if (!token) {
      setStatus({ kind: 'error', message: 'Verification token is missing from the link.' });
      return;
    }
    // Guard against StrictMode double-fire which would consume the token
    // on the first call, then fail on the second with "already used".
    // Tracking the attempted token (rather than a boolean) means a new
    // token in the same mount still triggers a fresh verification.
    if (verifiedTokenRef.current === token) return;
    verifiedTokenRef.current = token;
    setStatus({ kind: 'verifying' });

    verifyEmail(token)
      .then((res) => {
        setStatus({ kind: 'verified', approvalToken: res.approvalToken });
      })
      .catch((err) => {
        if (err instanceof ApiRequestError) setStatus({ kind: 'error', message: err.error.message });
        else setStatus({ kind: 'error', message: 'Verification failed. Try requesting a new link.' });
      });
  }, [token, verifyEmail]);

  const onResend = async (e: React.FormEvent) => {
    e.preventDefault();
    setResending(true);
    setResendStatus(null);
    setResendDevLink(null);
    try {
      const res = await resendVerification(resendEmail);
      setResendStatus({
        tone: 'success',
        text: res.verificationToken
          ? 'New link issued. Check your inbox (or use the dev shortcut below).'
          : 'If your account is still unverified, a fresh link is on its way.',
      });
      if (res.verificationToken) {
        setResendDevLink(`/auth/verify-email#token=${encodeURIComponent(res.verificationToken)}`);
      }
    } catch (err) {
      if (err instanceof ApiRequestError)
        setResendStatus({ tone: 'error', text: err.error.message });
      else
        setResendStatus({
          tone: 'error',
          text: 'Could not request a new link right now. Try again shortly.',
        });
    } finally {
      setResending(false);
    }
  };

  return (
    <div className={AUTH_PAGE_WRAP}>
      <Card className={AUTH_CARD_WIDTH}>
        <section
          aria-labelledby="verify-heading"
          aria-busy={status.kind === 'verifying'}
        >
        <AuthBrandRow />
        <h1 id="verify-heading" className={authHeadingClass}>
          Email verification
        </h1>
        {status.kind === 'verifying' ? <p role="status">Verifying…</p> : null}
        {status.kind === 'verified' ? (
          <>
            {status.approvalToken ? (
              <>
                <p>
                  Your email is verified. The owner has been notified and can
                  approve your account from the link in their inbox; sign-in
                  is locked until they do.
                </p>
                <p className={authMutedClass}>
                  <small>
                    {/* Plain anchor (not <Link>) so the navigation is a
                        full reload — same rationale as the verify-now dev
                        shortcut: the page reads the token from the
                        fragment only at mount. */}
                    <DevShortcutBadge />{' '}
                    <a
                      href={`/auth/approve-signup#token=${encodeURIComponent(status.approvalToken)}`}
                      className={authDevLinkClass}
                    >
                      approve this account
                    </a>
                    {' · '}
                    <a
                      href={`/auth/decline-signup#token=${encodeURIComponent(status.approvalToken)}`}
                      className={authDevLinkClass}
                    >
                      decline
                    </a>
                    .
                  </small>
                </p>
              </>
            ) : (
              <p>Your email is verified. You can sign in now.</p>
            )}
            <p className="text-center">
              <Link to="/login" className={textLinkClass}>
                Go to sign in
              </Link>
            </p>
          </>
        ) : null}
        {status.kind === 'error' ? (
          <>
            <p
              className="mb-4 rounded-md border border-negative/40 bg-surface-sunken px-3.5 py-2.5 text-sm text-negative"
              role="alert"
            >
              {status.message}
            </p>
            <p>
              Verification links are valid for 15 minutes. Enter the email you signed up
              with to receive a fresh link.
            </p>
            <form onSubmit={onResend} noValidate>
              <div className={authFieldClass()}>
                <label htmlFor="resend-email" className={authLabelClass}>
                  Email
                </label>
                <TextInput
                  id="resend-email"
                  type="email"
                  value={resendEmail}
                  onChange={(e) => setResendEmail(e.target.value)}
                  autoComplete="email"
                  required
                  className={authInputClass}
                />
              </div>
              <button
                type="submit"
                disabled={resending || !resendEmail}
                className={authPrimaryButtonClass}
              >
                {resending ? 'Sending…' : 'Send a new verification email'}
              </button>
            </form>
            {resendStatus ? (
              <p
                role={resendStatus.tone === 'error' ? 'alert' : 'status'}
                className={`mt-4 text-sm ${
                  resendStatus.tone === 'error' ? 'text-negative' : 'text-positive'
                }`}
              >
                {resendStatus.text}
              </p>
            ) : null}
            {resendDevLink ? (
              <p className={authMutedClass}>
                <small>
                  {/* Plain anchor (not <Link>) so the navigation is a
                      full reload — `useState(readTokenFromFragment)` only
                      runs at mount, and a same-path hash-only nav under
                      react-router would not remount the page. */}
                  <DevShortcutBadge />{' '}
                  <a href={resendDevLink} className={authDevLinkClass}>
                    verify now
                  </a>
                  .
                </small>
              </p>
            ) : null}
            <p className={`mt-4 text-center ${authMutedClass}`}>
              <Link to="/signup" className={textLinkClass}>
                Sign up again
              </Link>
            </p>
          </>
        ) : null}
        </section>
      </Card>
    </div>
  );
};
