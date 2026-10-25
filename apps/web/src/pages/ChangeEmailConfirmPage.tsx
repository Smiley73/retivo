/** Change-email confirmation landing route, public and unauthenticated (the link may open in another browser than the one that started the change). The token arrives in the URL fragment (never sent to the server or logged), is read once on mount, scrubbed via history.replaceState, then POSTed to /auth/change-email/confirm. */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { Card } from '../components/Card';
import { textLinkClass } from '../components/TextLink';
import {
  AUTH_PAGE_WRAP,
  AuthBrandRow,
  authMutedClass,
  authHeadingClass,
} from './auth-page-chrome';

type Status =
  | { kind: 'working' }
  | { kind: 'success'; email: string }
  | { kind: 'error'; message: string };

const CONFIRM_CARD_WIDTH = 'w-full max-w-md shadow-lg';

function readTokenFromFragment(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!hash) return '';
  return new URLSearchParams(hash).get('token') ?? '';
}

export const ChangeEmailConfirmPage: React.FC = () => {
  const { confirmEmailChange } = useAuth();
  // Read once on mount; the effect below scrubs the fragment before any later render, so this state is the only surviving copy.
  const [token] = useState<string>(readTokenFromFragment);
  const [status, setStatus] = useState<Status>({ kind: 'working' });
  const consumedTokenRef = React.useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.location.hash) return;
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search,
    );
  }, []);

  useEffect(() => {
    if (!token) {
      setStatus({ kind: 'error', message: 'Confirmation token is missing from the link.' });
      return;
    }
    // Guards StrictMode double-fire, which would consume the token on the first call and fail the second with "already used".
    if (consumedTokenRef.current === token) return;
    consumedTokenRef.current = token;
    setStatus({ kind: 'working' });

    confirmEmailChange(token)
      .then((res) => setStatus({ kind: 'success', email: res.email }))
      .catch((err) => {
        if (err instanceof ApiRequestError) {
          setStatus({ kind: 'error', message: err.error.message });
        } else {
          setStatus({
            kind: 'error',
            message: 'Confirmation failed. The link may have expired.',
          });
        }
      });
  }, [token, confirmEmailChange]);

  return (
    <div className={AUTH_PAGE_WRAP}>
      <Card className={CONFIRM_CARD_WIDTH}>
        <section
          aria-labelledby="change-email-heading"
          aria-busy={status.kind === 'working'}
        >
          <AuthBrandRow />
          <h1 id="change-email-heading" className={authHeadingClass}>
            Confirm email change
          </h1>
          {status.kind === 'working' ? <p role="status">Confirming…</p> : null}
          {status.kind === 'success' ? (
            <>
              <p>
                Your sign-in email is now <strong>{status.email}</strong>. Use it
                the next time you sign in.
              </p>
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
              <p className={authMutedClass}>
                Email-change links are valid for 15 minutes. If yours expired,
                start the change again from Settings → Security.
              </p>
              <p className="mt-4 text-center">
                <Link to="/login" className={textLinkClass}>
                  Go to sign in
                </Link>
              </p>
            </>
          ) : null}
        </section>
      </Card>
    </div>
  );
};
