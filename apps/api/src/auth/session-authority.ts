// Resolves the write authority a session carries for password-slot mutations: the credential revision on the server-side RefreshTokenRow, read
// per request from the refresh cookie, never client-supplied and never an access-token claim.
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

// Resolves the presented refresh cookie row as `logout` does (cookie `userId` matches the JWT, `sha256` as the key).
// Null when the cookie is absent or foreign, the row is missing, revoked or expired, or its `jti` differs from the
// bearer: the revoked, expired and jti checks stop a revoked or other-session row from lending its recorded authority
// to a request it was never issued for.
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
 * Resolves the current session recorded write authority, or `NO_SESSION_REVISION_SENTINEL` (which no credential
 * carries) when no session resolves, so the write ConditionCheck fails as a condition of the write. The row must be
 * paired to the bearer `currentJti`, never just any unrevoked row for the user.
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
 * Resolves the current session refresh-token hash under the same active-session and jti-pairing guard, for the
 * in-place authority update of `verify-password`; undefined when no live session matches.
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
