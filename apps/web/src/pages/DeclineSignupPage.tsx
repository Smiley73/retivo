/** Owner-decline landing route, mirroring ApproveSignupPage but POSTing to /auth/decline-signup, which marks the user declined and cascade-deletes the user-row sub-graph synchronously. */
import React, { useEffect, useState } from 'react';
import { textLinkClass } from '../components/TextLink';
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

const DECLINE_CARD_WIDTH = 'w-full max-w-md shadow-lg';

function readTokenFromFragment(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!hash) return '';
  return new URLSearchParams(hash).get('token') ?? '';
}

export const DeclineSignupPage: React.FC = () => {
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
      setStatus({ kind: 'error', message: 'Decline token is missing from the link.' });
      return;
    }
    if (consumedTokenRef.current === token) return;
    consumedTokenRef.current = token;
    setStatus({ kind: 'working' });
    apiRequest<{ declined: true; email: string }>(
      '/api/v1/auth/decline-signup',
      { method: 'POST', body: { token }, auth: false },
    )
      .then((res) => setStatus({ kind: 'success', email: res.email }))
      .catch((err) => {
        if (err instanceof ApiRequestError) {
          setStatus({ kind: 'error', message: err.error.message });
        } else {
          setStatus({
            kind: 'error',
            message: 'Decline failed. The link may have expired.',
          });
        }
      });
  }, [token]);

  return (
    <div className={AUTH_PAGE_WRAP}>
      <Card className={DECLINE_CARD_WIDTH}>
        <section
          aria-labelledby="decline-heading"
          aria-busy={status.kind === 'working'}
        >
          <AuthBrandRow />
          <h1 id="decline-heading" className={authHeadingClass}>
            Decline sign-up
          </h1>
          {status.kind === 'working' ? <p>Declining…</p> : null}
          {status.kind === 'success' ? (
            <>
              <p>
                Declined <strong>{status.email}</strong>. The pending account has
                been deleted.
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
                Decline links are valid for 7 days. If the link has expired, the
                pending account will be cleaned up automatically.
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
