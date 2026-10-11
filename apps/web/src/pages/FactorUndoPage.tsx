/**
 * Factor-change undo landing page. Reached from the
 * "we noticed a change to your sign-in methods" mail, usually while the
 * person is signed out everywhere. Sits OUTSIDE `RequireAuth` — see
 * `App.tsx`'s public route block.
 *
 * Reads `userId` + `token` + `kind` from the URL fragment, never the server
 * (mail clients and mail-security scanners prefetch links; a GET that
 * performed the undo would fire itself in the recipient's inbox). The undo
 * only runs on an explicit button click — this component does nothing on
 * mount besides reading and scrubbing the fragment.
 *
 * `kind` chooses the page's pre-click copy AND is sent back with the consume
 * request: the server validates it against the token's stored kind before
 * acting, so a truncated or altered link's copy can never describe one
 * action (e.g. "sign out only") while a different, more destructive one
 * (e.g. deleting a passkey) actually runs. A missing or unrecognised `kind`
 * is treated the same as a missing token — the page refuses rather than
 * falling back to generic copy for an unconfirmed action.
 *
 * The consume response is opaque (`{ ok }`) — an unknown/wrong/expired/
 * already-used token renders the identical "expired or already used" state
 * as a genuinely superseded one, never a distinguishing error.
 */
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

/** Pre-click body copy, tailored to the kind when the link's `k` field named
 *  one, else the generic "a sign-in method" wording. */
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
  // Read once on mount; the effect below scrubs the fragment before any
  // subsequent render so this state is the only surviving copy.
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
      // A network/server error is not "expired or used" — say so plainly
      // rather than the misleading expired/used copy.
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
