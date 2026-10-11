/**
 * Issue + verify access-token JWTs with kid-rotated RS256 keys
 * (replaces the previous HS256 implementation).
 * Kept as a thin wrapper over `jsonwebtoken` semantics so we can rotate
 * keys without touching consumers.
 *
 * See docs/security.md, "Sessions".
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { JwtKeyStore, type JwksKey } from './jwt-key-store.js';
import type { EnvConfig } from '../common/env.config.js';
import jwt, { type JwtPayload } from 'jsonwebtoken';

export interface AccessTokenClaims {
  userId: string;
  householdId: string;
  deviceId: string;
  /** Canonical user email. Surfaced so the SPA's `me.email` is
   *  populated regardless of which login path (password / passkey /
   *  silent refresh) issued the token. Empty string when the user row
   *  has somehow been wiped between sign + verify (shouldn't happen
   *  in practice; defensive `?? ''` keeps the JWT shape stable). */
  email: string;
  jti: string;
  kid: string;
  iat: number;
  exp: number;
  /**
   * Token-purpose discriminator. A normal access
   * token has NO `purpose` claim. The MFA challenge token (mfa-challenge.service)
   * carries `purpose: 'mfa_challenge'`; `JwtAuthGuard` rejects any verified token
   * that carries a `purpose` so a challenge token can never be used as a session
   * bearer. Surfaced here as optional so the guard can read it after verify.
   */
  purpose?: string;
  /**
   * The account session generation this token was minted under.
   * Every session-bearing access token
   * signed after this shipped carries the value the signing caller read at
   * issuance/rotation time; `JwtAuthGuard` rejects a token whose generation
   * has since been retired. Surfaced as optional (not required by
   * `verify()` itself) so a token that predates this claim decodes normally —
   * the guard, not `verify`, is where a missing claim is rejected,
   * mapped to the SAME `ACCESS_TOKEN_REVOKED` outcome as a tombstoned
   * generation (no legacy no-generation path stays trusted).
   */
  sessionGeneration?: number;
}

interface SignArgs {
  userId: string;
  householdId: string;
  deviceId: string;
  email: string;
  /** Optional: caller-supplied jti so it can be matched to RefreshToken row. */
  jti?: string;
  /**
   * The account session generation to stamp onto this token — optional here ONLY so the many
   * pre-existing unit tests that mint a bare token without a session-revocation concern keep
   * compiling; every REAL session-issuing caller (`LoginService.issueSession`, the `/auth/refresh`
   * handler) resolves and passes a concrete value. A token signed without one is treated by
   * `JwtAuthGuard` exactly like a tombstoned generation — never trusted as an implicit "generation
   * 0".
   */
  sessionGeneration?: number;
}

@Injectable()
export class AccessTokenService {
  private readonly ttlSec: number;
  /** Token-domain claims signed onto and strictly required by every access
   *  token. */
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    private readonly keys: JwtKeyStore,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.ttlSec = config.get('AUTH_ACCESS_TOKEN_TTL_MIN', { infer: true }) * 60;
    this.issuer = config.get('AUTH_JWT_ISSUER', { infer: true });
    this.audience = config.get('AUTH_JWT_AUDIENCE', { infer: true });
  }

  sign(args: SignArgs): { token: string; jti: string; expiresInSec: number } {
    const { kid, privateKey } = this.keys.current();
    const jti = args.jti ?? randomUUID();
    const token = jwt.sign(
      {
        userId: args.userId,
        householdId: args.householdId,
        deviceId: args.deviceId,
        email: args.email,
        // Omitted entirely (never a literal `undefined`) when the caller has
        // no generation to stamp — see `SignArgs.sessionGeneration`.
        ...(args.sessionGeneration !== undefined
          ? { sessionGeneration: args.sessionGeneration }
          : {}),
      },
      privateKey,
      {
        algorithm: 'RS256',
        keyid: kid,
        jwtid: jti,
        expiresIn: this.ttlSec,
        issuer: this.issuer,
        audience: this.audience,
      },
    );
    return { token, jti, expiresInSec: this.ttlSec };
  }

  /**
   * Verify signature + decode. Throws on any failure (expired, bad
   * signature, unknown kid). Caller is responsible for checking the
   * RevokedToken denylist after this returns successfully.
   */
  verify(token: string): AccessTokenClaims {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') {
      throw new Error('Malformed token');
    }
    const kid = decoded.header.kid;
    if (!kid || typeof kid !== 'string') {
      throw new Error('Missing kid header');
    }
    const publicKey = this.keys.publicFor(kid);
    if (!publicKey) {
      throw new Error(`Unknown kid: ${kid}`);
    }
    // Strictly require the environment-specific issuer/audience: a token
    // missing either claim, or carrying a wrong value, throws here and is
    // rejected by the guard — closing the cross-environment/service
    // token-confusion boundary.
    const payload = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: this.issuer,
      audience: this.audience,
    }) as JwtPayload;
    if (!payload.jti || !payload.exp || !payload.iat) {
      throw new Error('Missing required claim');
    }
    if (
      typeof payload.userId !== 'string' ||
      typeof payload.householdId !== 'string' ||
      typeof payload.deviceId !== 'string'
    ) {
      throw new Error('Missing custom claim');
    }
    return {
      userId: payload.userId,
      householdId: payload.householdId,
      deviceId: payload.deviceId,
      // `email` was added after the initial token issuance — existing
      // sessions whose access token predates this change still verify;
      // the FE falls back to its stored email value when the claim is
      // absent so the regression window is one token refresh wide.
      email: typeof payload.email === 'string' ? payload.email : '',
      jti: payload.jti,
      kid,
      iat: payload.iat,
      exp: payload.exp,
      // Surface a `purpose` claim if present (MFA challenge tokens
      // carry one); JwtAuthGuard rejects any token that does. A normal access
      // token has no `purpose`, leaving this undefined.
      ...(typeof payload.purpose === 'string'
        ? { purpose: payload.purpose }
        : {}),
      // Surface a `sessionGeneration` claim if present. Deliberately NOT required here — a missing
      // claim is rejected by JwtAuthGuard (mapped to the same ACCESS_TOKEN_REVOKED outcome as a
      // tombstoned generation), not by `verify` throwing a generic UNAUTHENTICATED error.
      ...(typeof payload.sessionGeneration === 'number'
        ? { sessionGeneration: payload.sessionGeneration }
        : {}),
    };
  }

  /**
   * RFC 7517 JWKS view of the active public-key set. Surfaced by the
   * `GET /auth/.well-known/jwks.json` endpoint so external verifiers
   * (Lambda@Edge, mobile clients, future microservices) can validate
   * tokens without contacting the api or holding any shared secret.
   */
  publicJwks(): JwksKey[] {
    return this.keys.jwks();
  }
}
