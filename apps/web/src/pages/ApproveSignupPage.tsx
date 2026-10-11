/**
 * Owner-approval landing route. The approval mail link points here with
 * the token in the URL fragment (`#token=…`). Same posture as
 * VerifyEmailPage: read once on mount, scrub the fragment via
 * `history.replaceState`, then POST.
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { apiRequest, ApiRequestError } from '../api/client';
import { Card } from '../components/Card';
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

// Tailwind max-w-md — one-sentence outcome copy card.
const APPROVE_CARD_WIDTH = 'w-full max-w-md shadow-lg';

function readTokenFromFragment(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!hash) return '';
  return new URLSearchParams(hash).get('token') ?? '';
}

export const ApproveSignupPage: React.FC = () => {
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
      setStatus({ kind: 'error', message: 'Approval token is missing from the link.' });
      return;
    }
    if (consumedTokenRef.current === token) return;
    consumedTokenRef.current = token;
    setStatus({ kind: 'working' });
    apiRequest<{ approved: true; email: string }>(
      '/api/v1/auth/approve-signup',
      { method: 'POST', body: { token }, auth: false },
    )
      .then((res) => setStatus({ kind: 'success', email: res.email }))
      .catch((err) => {
        if (err instanceof ApiRequestError) {
          setStatus({ kind: 'error', message: err.error.message });
        } else {
          setStatus({
            kind: 'error',
            message: 'Approval failed. The link may have expired.',
          });
        }
      });
  }, [token]);

  return (
    <div className={AUTH_PAGE_WRAP}>
      <Card className={APPROVE_CARD_WIDTH}>
        <section
          aria-labelledby="approve-heading"
          aria-busy={status.kind === 'working'}
        >
          <AuthBrandRow />
          <h1 id="approve-heading" className={authHeadingClass}>
            Approve sign-up
          </h1>
          {status.kind === 'working' ? <p>Approving…</p> : null}
          {status.kind === 'success' ? (
            <>
              <p>
                Approved <strong>{status.email}</strong>. They can now sign in.
              </p>
              <p className="text-center">
                <Link to="/login">Go to sign in</Link>
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
                Approval links are valid for 7 days. If the link has expired,
                ask the applicant to sign up again.
              </p>
              <p className="mt-4 text-center">
                <Link to="/login">Go to sign in</Link>
              </p>
            </>
          ) : null}
        </section>
      </Card>
    </div>
  );
};
