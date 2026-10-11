/**
 * Mints and verifies the short-lived export-authorization cookie.
 *
 * Account export requires an explicit password re-verification. After a
 * successful `data_export`-purpose `POST /auth/verify-password`,
 * this service sets a 5-minute, HttpOnly, `SameSite=Strict`, production-`Secure`
 * signed cookie bound to the caller's `userId`, `householdId`, and the CURRENT
 * access-token `jti`. `GET /auth/account-export` (via `ExportAuthorizationGuard`)
 * accepts it only when all three bindings match the request's authenticated
 * claims — a wrong session / user / household, a tampered token, or an expired
 * one is rejected.
 *
 * Same key store + RS256 signing as `AccessTokenService` (jwt.service.ts) and
 * `MfaChallengeService`, but the token carries `purpose: 'data_export'`.
 * `JwtAuthGuard` rejects any verified token that carries a `purpose`, so the
 * export authorization can NEVER be used as a session bearer — it only works as
 * the HttpOnly cookie read here.
 *
 * See docs/security.md, "Deleting and exporting your data".
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { JwtKeyStore } from './jwt-key-store.js';
import type { EnvConfig } from '../common/env.config.js';
import {
  EXPORT_AUTHORIZATION_COOKIE_NAME,
  EXPORT_AUTHORIZATION_TTL_SEC,
  exportAuthorizationCookieOptions,
} from './cookie-config.js';

/** Distinguishing claim that bars the token from being used as a session bearer. */
export const DATA_EXPORT_AUTHORIZATION_PURPOSE = 'data_export';

/** The session identity an export authorization is bound to. */
export interface ExportAuthorizationBinding {
  userId: string;
  householdId: string;
  /** The access-token `jti` in force when the authorization was minted. */
  jti: string;
}

@Injectable()
export class DataExportAuthorizationService {
  /** Token-domain claims signed onto and strictly required by every
   *  export-authorization token. */
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    private readonly keys: JwtKeyStore,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.issuer = config.get('AUTH_JWT_ISSUER', { infer: true });
    this.audience = config.get('AUTH_JWT_AUDIENCE', { infer: true });
  }

  /**
   * Set the export-authorization cookie on the response, bound to the caller's
   * session. Called only after a successful `data_export` re-verification.
   */
  issueCookie(res: Response, binding: ExportAuthorizationBinding): void {
    res.cookie(
      EXPORT_AUTHORIZATION_COOKIE_NAME,
      this.sign(binding),
      exportAuthorizationCookieOptions(EXPORT_AUTHORIZATION_TTL_SEC * 1000),
    );
  }

  /** Sign a 5-min export-authorization token bound to `binding`. */
  sign(binding: ExportAuthorizationBinding): string {
    const { kid, privateKey } = this.keys.current();
    return jwt.sign(
      {
        userId: binding.userId,
        householdId: binding.householdId,
        boundJti: binding.jti,
        purpose: DATA_EXPORT_AUTHORIZATION_PURPOSE,
      },
      privateKey,
      {
        algorithm: 'RS256',
        keyid: kid,
        expiresIn: EXPORT_AUTHORIZATION_TTL_SEC,
        issuer: this.issuer,
        audience: this.audience,
      },
    );
  }

  /**
   * Read the export-authorization cookie off `req` and verify it against the
   * caller's authenticated session. Returns `false` (never throws) for a
   * missing / expired / malformed / wrong-session cookie so the guard can fail
   * closed with `EXPORT_AUTHORIZATION_REQUIRED`.
   */
  verifyFromRequest(req: Request, expected: ExportAuthorizationBinding): boolean {
    const token = readCookie(req, EXPORT_AUTHORIZATION_COOKIE_NAME);
    if (!token) return false;
    return this.verify(token, expected);
  }

  /**
   * Verify a presented export-authorization token: signature + kid lookup +
   * expiry + `purpose` + all three session bindings. Returns `false` on ANY
   * failure (fail closed). Never accepted as a session bearer — the `purpose`
   * claim also bars it at `JwtAuthGuard`.
   */
  verify(token: string, expected: ExportAuthorizationBinding): boolean {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') return false;
    const kid = decoded.header.kid;
    if (!kid || typeof kid !== 'string') return false;
    const publicKey = this.keys.publicFor(kid);
    if (!publicKey) return false;

    let payload: JwtPayload;
    try {
      // Strictly require the environment-specific issuer/audience alongside
      // the existing purpose/binding checks below — a missing or wrong claim
      // fails closed like any other verification failure.
      payload = jwt.verify(token, publicKey, {
        algorithms: ['RS256'],
        issuer: this.issuer,
        audience: this.audience,
      }) as JwtPayload;
    } catch {
      // Bad signature, unknown kid, expiry, or wrong/missing issuer/audience —
      // all fail closed.
      return false;
    }

    if (payload.purpose !== DATA_EXPORT_AUTHORIZATION_PURPOSE) return false;
    return (
      payload.userId === expected.userId &&
      payload.householdId === expected.householdId &&
      payload.boundJti === expected.jti
    );
  }
}

/** Read a single cookie value off the raw `Cookie` header. */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie ?? '';
  for (const pair of header.split(';')) {
    const [k, ...rest] = pair.trim().split('=');
    if (k === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        // Malformed percent-encoding in an attacker-controlled cookie: treat as
        // an absent cookie so `verify*` fails closed rather than throwing URIError.
        return undefined;
      }
    }
  }
  return undefined;
}
