/** Factor-change undo landing page, reached from the "we noticed a change to your sign-in methods" mail (usually while signed out), outside RequireAuth.
* userId, token and kind come from the URL fragment, never the server, and the undo runs only on an explicit click, because mail scanners prefetch links and a GET that undid would fire itself. */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { apiRequest } from '../api/client';
import { Card } from '../components/Card';
import { Alert } from '../components/Alert';
import { textLinkClass } from '../components/TextLink';
import {
  AUTH_PAGE_WRAP,
  AUTH_CARD_WIDTH,
  AuthBrandRow,
  authPrimaryButtonClass,
  authMutedClass,
  authHeadingClass,
} from './auth-page-chrome';

type FactorUndoKind = 'passkey_add' | 'passkey_remove' | 'totp_add' | 'totp_remove';

interface FragmentFields {
  userId: string;
  token: string;
  kind: FactorUndoKind | null;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  'passkey_add',
  'passkey_remove',
  'totp_add',
  'totp_remove',
]);

function readFieldsFromFragment(): FragmentFields {
  if (typeof window === 'undefined') return { userId: '', token: '', kind: null };
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!hash) return { userId: '', token: '', kind: null };
  const parsed = new URLSearchParams(hash);
  const kind = parsed.get('k');
  return {
    userId: parsed.get('u') ?? '',
    token: parsed.get('t') ?? '',
    kind: kind && KNOWN_KINDS.has(kind) ? (kind as FactorUndoKind) : null,
  };
}

const FACTOR_LABEL: Record<FactorUndoKind, string> = {
  passkey_add: 'passkey',
  passkey_remove: 'passkey',
  totp_add: 'authenticator app',
  totp_remove: 'authenticator app',
};

function isAddKind(kind: FactorUndoKind | null): boolean {
  return kind === 'passkey_add' || kind === 'totp_add';
}

function bodyCopy(kind: FactorUndoKind | null): string {
  const label = kind ? FACTOR_LABEL[kind] : 'sign-in method';
  return isAddKind(kind)
    ? `This removes the ${label} that was just added to your account and signs you out on every device.`
    : `This signs you out on every device. It can't restore the ${label} — sign in and set one up again if this wasn't you.`;
}

function buttonLabel(kind: FactorUndoKind | null): string {
  if (kind === 'totp_add') return 'Turn it off and sign out everywhere';
  return isAddKind(kind) ? 'Remove it and sign out everywhere' : 'Sign out everywhere';
}

function successCopy(kind: FactorUndoKind | null): string {
  const label = kind ? FACTOR_LABEL[kind] : 'sign-in method';
  return isAddKind(kind)
    ? `Done. The ${label} was removed and every device was signed out. Sign in again to continue.`
    : 'Done. Every device was signed out. Sign in again to continue.';
}

const EXPIRED_OR_USED_MESSAGE =
  'This link has already been used or has expired. Sign in and check your sign-in methods on the Security page.';

export const FactorUndoPage: React.FC = () => {
  // Read once on mount; the effect below scrubs the fragment before any later render, so this state is the only surviving copy.
  // kind is sent with the consume request and validated server-side against the token's stored kind, so an altered link's copy can never describe a different action than the one that runs; a missing or unknown kind refuses like a missing token.
  const [fields] = useState<FragmentFields>(readFieldsFromFragment);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<'success' | 'failed' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.location.hash) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  const onConfirm = async () => {
    if (!fields.userId || !fields.token) {
      setError('This link is missing its token. Open the link from the email again.');
      return;
    }
    if (!fields.kind) {
      setError('This link is missing information. Open the link from the email again.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiRequest<{ ok: boolean }>('/api/v1/auth/factor-undo/consume', {
        method: 'POST',
        body: { userId: fields.userId, token: fields.token, kind: fields.kind },
        auth: false,
      });
      setResult(res.ok ? 'success' : 'failed');
    } catch {
      // A network or server error is not "expired or used"; say so plainly.
      setError('Something went wrong. Try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={AUTH_PAGE_WRAP}>
      <Card className={AUTH_CARD_WIDTH}>
        <section aria-labelledby="factor-undo-heading">
          <AuthBrandRow />
          <h1 id="factor-undo-heading" className={authHeadingClass}>
            {result === 'success' ? 'Done' : 'Undo this change?'}
          </h1>
          {error && <Alert tone="error">{error}</Alert>}
          {result === 'success' && (
            <Alert tone="success" role="status">
              {successCopy(fields.kind)}
            </Alert>
          )}
          {result === 'failed' && (
            <Alert tone="warning" role="status">
              {EXPIRED_OR_USED_MESSAGE}
            </Alert>
          )}
          {result === null && (
            <>
              <p className={`mb-4 text-sm ${authMutedClass}`}>{bodyCopy(fields.kind)}</p>
              <button
                type="button"
                onClick={() => void onConfirm()}
                disabled={submitting}
                className={authPrimaryButtonClass}
              >
                {submitting ? 'Working…' : buttonLabel(fields.kind)}
              </button>
            </>
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
