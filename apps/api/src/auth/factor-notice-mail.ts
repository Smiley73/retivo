// Pure mail-body builder for the factor-change notice, free of SES wiring so it is unit-testable. Copy is a draft pending owner approval; the
// TOTP wording derives from the passkey wording.
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

/**
 * Plain-English body shared by the text and HTML parts; an add is fully undoable, a removal only ends every session.
 */
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
 * Builds the fragment-form undo link (a token-bearing link always rides the URL fragment, so it never reaches access
 * logs or Referer). Carries `userId` (the consume endpoint has no session) and `kind`, which is read only by the
 * landing page to pick its copy; it is not secret and the consume response stays opaque.
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
 * Builds the subject, text and HTML parts. Every HTML interpolation goes through `escapeHtml` mechanically, even
 * though the link is built from operator config and opaque tokens.
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
