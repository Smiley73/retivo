// Mints and verifies the 5-minute export-authorization cookie (HttpOnly, SameSite=Strict, signed, bound to userId, householdId and the
// access-token jti). Its `purpose` claim bars it as a session bearer. See docs/security.md, "Deleting and exporting your data".
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

// The claim that bars the token from being used as a session bearer.
const DATA_EXPORT_AUTHORIZATION_PURPOSE = 'data_export';

interface ExportAuthorizationBinding {
  userId: string;
  householdId: string;
  jti: string;
}

@Injectable()
export class DataExportAuthorizationService {
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    private readonly keys: JwtKeyStore,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.issuer = config.get('AUTH_JWT_ISSUER', { infer: true });
    this.audience = config.get('AUTH_JWT_AUDIENCE', { infer: true });
  }

  /** Sets the cookie bound to the caller session, only after a successful `data_export` re-verification. */
  issueCookie(res: Response, binding: ExportAuthorizationBinding): void {
    res.cookie(
      EXPORT_AUTHORIZATION_COOKIE_NAME,
      this.sign(binding),
      exportAuthorizationCookieOptions(EXPORT_AUTHORIZATION_TTL_SEC * 1000),
    );
  }

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
   * Verifies the cookie against the authenticated session; false (never throws) for a missing, expired, malformed or
   * wrong-session cookie, so the guard fails closed with EXPORT_AUTHORIZATION_REQUIRED.
   */
  verifyFromRequest(req: Request, expected: ExportAuthorizationBinding): boolean {
    const token = readCookie(req, EXPORT_AUTHORIZATION_COOKIE_NAME);
    if (!token) return false;
    return this.verify(token, expected);
  }

  /** Verifies signature, kid, expiry, purpose and all three bindings; false on any failure. */
  verify(token: string, expected: ExportAuthorizationBinding): boolean {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') return false;
    const kid = decoded.header.kid;
    if (!kid || typeof kid !== 'string') return false;
    const publicKey = this.keys.publicFor(kid);
    if (!publicKey) return false;

    let payload: JwtPayload;
    try {
      // Strictly require the environment-specific issuer and audience; a missing or wrong claim fails closed.
      payload = jwt.verify(token, publicKey, {
        algorithms: ['RS256'],
        issuer: this.issuer,
        audience: this.audience,
      }) as JwtPayload;
    } catch {
      // Bad signature, unknown kid, expiry or wrong claims all fail closed.
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

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie ?? '';
  for (const pair of header.split(';')) {
    const [k, ...rest] = pair.trim().split('=');
    if (k === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        // Malformed percent-encoding in an attacker-controlled cookie: treat as absent so `verify*` fails closed
        // instead of throwing URIError.
        return undefined;
      }
    }
  }
  return undefined;
}
