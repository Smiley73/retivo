/**
 * Pure mail-body builder for the factor-change notice. Kept separate from
 * `factor-notice.service.ts` and free of any SES / Nest wiring so it is unit-testable without a
 * stub client — the service calls this to get the strings it hands to `SendEmailCommand`.
 *
 * Copy below is a DRAFT pending owner approval. The TOTP wording is derived
 * from the passkey wording by substituting the factor label; it is not itself
 * independently drafted and needs the same sign-off.
 */
import { escapeHtml } from '../common/escape-html.js';

export type FactorUndoKind = 'passkey_add' | 'passkey_remove' | 'totp_add' | 'totp_remove';

export interface FactorNoticeMail {
  subject: string;
  text: string;
  html: string;
}

const SUBJECTS: Record<FactorUndoKind, string> = {
  passkey_add: 'A passkey was added to your Retivo account',
  totp_add: 'An authenticator app was added to your Retivo account',
  passkey_remove: 'A passkey was removed from your Retivo account',
  totp_remove: 'Your authenticator app was turned off',
};

const FACTOR_LABEL: Record<FactorUndoKind, string> = {
  passkey_add: 'passkey',
  totp_add: 'authenticator app',
  passkey_remove: 'passkey',
  totp_remove: 'authenticator app',
};

function isAddKind(kind: FactorUndoKind): boolean {
  return kind === 'passkey_add' || kind === 'totp_add';
}

/** Plain-English body, shared by the text and HTML parts before the link is
 *  spliced in — differs only by whether the change is undoable (an add
 *  is fully undoable; a removal only ends every session). */
export function bodyIntro(kind: FactorUndoKind): string {
  const label = FACTOR_LABEL[kind];
  return isAddKind(kind)
    ? `A new ${label} was just added to your Retivo account. If that was you, ` +
        `there is nothing to do. If it wasn't, use the link below to remove the ` +
        `new ${label} and sign out on every device. The link works once and ` +
        `expires in 24 hours. After that, sign in and change your password.`
    : `A ${label} was just removed from your Retivo account. If that was you, ` +
        `there is nothing to do. If it wasn't, use the link below to sign out ` +
        `on every device. The link works once and expires in 24 hours. It ` +
        `can't put the ${label} back — sign in and set one up again.`;
}

/**
 * Build the fragment-form undo link (repo-wide rule: a token-bearing link
 * always rides the URL fragment, never a query string, so it never reaches
 * CloudFront/API-GW access logs or a `Referer`). Carries `userId` alongside
 * the opaque `token` — the consume endpoint has no session to resolve the
 * account from otherwise. Also carries
 * `kind` — NOT sent to the consume endpoint, only read by the landing page
 * to choose its pre-click copy (which factor, undoable or not); the kind is
 * not secret (the recipient already read it in this same mail) and the
 * consume response stays opaque regardless of what the fragment claims.
 */
export function buildFactorUndoLink(
  webOrigin: string,
  userId: string,
  token: string,
  kind: FactorUndoKind,
): string {
  return (
    `${webOrigin}/auth/factor-undo#u=${encodeURIComponent(userId)}` +
    `&t=${encodeURIComponent(token)}&k=${encodeURIComponent(kind)}`
  );
}

/**
 * Build the subject + text + HTML parts for a factor-change notice. Every
 * interpolated value in the HTML body is routed through the shared
 * `escapeHtml` — the link is built from operator config
 * plus opaque tokens, not user input, but the rule is applied mechanically
 * rather than case-by-case.
 */
export function buildFactorNoticeMail(args: {
  kind: FactorUndoKind;
  link: string;
}): FactorNoticeMail {
  const { kind, link } = args;
  const intro = bodyIntro(kind);
  const text = `${intro}\n\n${link}`;
  const html = `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`;
  return { subject: SUBJECTS[kind], text, html };
}
