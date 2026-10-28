/** Owner landing page for the approve and decline links in the sign-up approval mail, outside RequireAuth.
* The token comes from the URL fragment and the action runs only on an explicit click, because mail clients and link scanners prefetch links and a GET that approved would fire itself. */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { apiRequest, ApiRequestError } from '../api/client';
import { Card } from '../components/Card';
import { Alert } from '../components/Alert';
import { textLinkClass } from '../components/TextLink';
import {
  AUTH_PAGE_WRAP,
  AUTH_CARD_WIDTH,
  AuthBrandRow,
  authPrimaryButtonClass,
  authSecondaryButtonClass,
  authMutedClass,
  authHeadingClass,
} from './auth-page-chrome';

type SignupApprovalAction = 'approve' | 'decline';

const ACTIONS: Record<
  SignupApprovalAction,
  { endpoint: string; heading: string; label: string; working: string; success: (email: string) => React.ReactNode }
> = {
  approve: {
    endpoint: '/api/v1/auth/approve-signup',
    heading: 'Approve sign-up',
    label: 'Approve',
    working: 'Approving…',
    success: (email) => (
      <>
        Approved <strong>{email}</strong>. They can now sign in.
      </>
    ),
  },
  decline: {
    endpoint: '/api/v1/auth/decline-signup',
    heading: 'Decline sign-up',
    label: 'Decline',
    working: 'Declining…',
    success: (email) => (
      <>
        Declined <strong>{email}</strong>. The pending account has been deleted.
      </>
    ),
  },
};

function readTokenFromFragment(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!hash) return '';
  return new URLSearchParams(hash).get('token') ?? '';
}

export const SignupApprovalPage: React.FC<{ action: SignupApprovalAction }> = ({ action }) => {
  // Read once on mount; the effect below scrubs the fragment before any later render, so this state is the only surviving copy.
  const [token] = useState<string>(readTokenFromFragment);
  const [submitting, setSubmitting] = useState<SignupApprovalAction | null>(null);
  const [done, setDone] = useState<React.ReactNode>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.location.hash) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  const onChoose = async (chosen: SignupApprovalAction) => {
    if (!token) {
      setError('This link is missing its token. Open the link from the email again.');
      return;
    }
    setError(null);
    setSubmitting(chosen);
    try {
      const res = await apiRequest<{ email: string }>(ACTIONS[chosen].endpoint, {
        method: 'POST',
        body: { token },
        auth: false,
      });
      setDone(ACTIONS[chosen].success(res.email));
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.error.message
          : 'Something went wrong. Try again in a moment.',
      );
    } finally {
      setSubmitting(null);
    }
  };

  const button = (which: SignupApprovalAction) => (
    <button
      type="button"
      onClick={() => void onChoose(which)}
      disabled={submitting !== null}
      className={which === action ? authPrimaryButtonClass : authSecondaryButtonClass}
    >
      {submitting === which ? ACTIONS[which].working : ACTIONS[which].label}
    </button>
  );

  return (
    <div className={AUTH_PAGE_WRAP}>
      <Card className={AUTH_CARD_WIDTH}>
        <section aria-labelledby="signup-approval-heading">
          <AuthBrandRow />
          <h1 id="signup-approval-heading" className={authHeadingClass}>
            {ACTIONS[action].heading}
          </h1>
          {error && <Alert tone="error">{error}</Alert>}
          {done ? (
            <Alert tone="success">{done}</Alert>
          ) : (
            <>
              <p className={`mb-4 text-sm ${authMutedClass}`}>
                Someone is waiting for your decision to sign up. The approval email names them.
                Nothing happens until you choose. Declining deletes the pending account.
              </p>
              <div className="flex flex-col gap-3">
                {button('approve')}
                {button('decline')}
              </div>
            </>
          )}
          <p className={`mt-4 text-center ${authMutedClass}`}>
            <Link to="/login" className={textLinkClass}>
              Go to sign in
            </Link>
          </p>
        </section>
      </Card>
    </div>
  );
};
