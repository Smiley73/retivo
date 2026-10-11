/**
 * Resolves the write authority a request's session carries for password-slot
 * mutations: the credential revision recorded
 * on the server-side `RefreshTokenRow` at issuance, read per request from the
 * refresh cookie — never a client-supplied value, and never an access-token
 * claim (a signed claim can't be amended mid-session, which is exactly what
 * the derived post-reset-rewrap prompt needs). Works on the key-envelope
 * routes and `verify-password` because the refresh cookie's path is
 * `/api/v1/auth` and every route involved sits under it (cookie-config.ts).
 *
 * `parseCookies` is the same parser `auth.controller.ts`'s `logout` /
 * `refresh` / `login` handlers use — factored out here rather than copied a
 * further time.
 */
import type { Request } from 'express';
import { REFRESH_COOKIE_NAME } from './cookie-config.js';
import { sha256 } from './refresh-token.service.js';
import type { RefreshTokensRepository } from '../dynamo/refresh-tokens.repository.js';
import { NO_SESSION_REVISION_SENTINEL } from '../dynamo/types.js';

export function parseCookies(cookieHeader: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const [k, ...rest] = pair.trim().split('=');
    if (k) out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

/**
 * Resolve the presented refresh cookie's row, the same way `logout` does:
 * parse the cookie, check the leading `userId` segment against the caller's
 * JWT `userId`, then `sha256(cookie)` for the row key. Returns `null` when the
 * cookie is absent, does not belong to `userId`, its row cannot be found, the
 * row is revoked or expired, or its recorded `jti` does not match the
 * bearer's current access-token `jti` — every one of those is "no session to
 * resolve", handled uniformly by the caller.
 *
 * The revoked/expired/jti checks close
 * a lending vector: without them, ANY refresh row that still parses for this
 * user — including one already revoked, or one belonging to a different, live
 * session than the bearer presenting it — would hand its recorded
 * write-authority revision to a request it was never issued for.
 */
async function resolveSessionRow(
  req: Request,
  userId: string,
  currentJti: string,
  refreshTokens: RefreshTokensRepository,
) {
  const cookies = parseCookies(req.headers.cookie ?? '');
  const presented = cookies[REFRESH_COOKIE_NAME];
  if (!presented) return null;
  const userIdFromCookie = presented.split('.')[0];
  if (userIdFromCookie !== userId) return null;
  const row = await refreshTokens.find(userId, sha256(presented));
  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  if (row.jti !== currentJti) return null;
  return row;
}

/**
 * Resolve the current session's recorded write authority. Returns
 * {@link NO_SESSION_REVISION_SENTINEL} — a value no credential row can ever
 * carry — when the session cannot be resolved at all, so a session with no
 * recorded authority always fails the `ConditionCheck`/conditional `Put` it
 * is compared against as a condition of the write, rather than short-
 * circuiting on a preceding branch. `currentJti` is the bearer access
 * token's own `jti` claim — the row must still be paired to it, never merely
 * "any unrevoked row for this user".
 */
export async function resolveSessionCredentialRevision(
  req: Request,
  userId: string,
  currentJti: string,
  refreshTokens: RefreshTokensRepository,
): Promise<string> {
  const row = await resolveSessionRow(req, userId, currentJti, refreshTokens);
  return row?.credentialRevision ?? NO_SESSION_REVISION_SENTINEL;
}

/**
 * Resolve the current session's refresh-token hash, under the SAME active-
 * session + jti-pairing guard as {@link resolveSessionCredentialRevision} —
 * used by `POST /auth/verify-password`'s
 * in-place session-authority update so a revoked or different session can
 * never inherit another session's grant. Returns `undefined` when no matching
 * live session can be resolved, exactly the shape `verify-password`'s
 * controller/service already treat as "nothing to update".
 */
export async function resolveSessionTokenHash(
  req: Request,
  userId: string,
  currentJti: string,
  refreshTokens: RefreshTokensRepository,
): Promise<string | undefined> {
  const row = await resolveSessionRow(req, userId, currentJti, refreshTokens);
  return row?.tokenHash;
}
