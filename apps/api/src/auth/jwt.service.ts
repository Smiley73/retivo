// Issues and verifies access-token JWTs with kid-rotated RS256 keys, so keys rotate without touching consumers. See docs/security.md,
// "Sessions".
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
  /**
   * Canonical user email, so the SPA `me.email` is populated on every login path. Empty string if the user row was
   * wiped between sign and verify.
   */
  email: string;
  jti: string;
  kid: string;
  iat: number;
  exp: number;
  /**
   * Token-purpose discriminator: a normal access token has none; the MFA challenge token carries `mfa_challenge`, and
   * `JwtAuthGuard` rejects any token with a `purpose` so a challenge can never be a session bearer.
   */
  purpose?: string;
  /**
   * The session generation this token was minted under; `JwtAuthGuard` rejects one that has since been retired.
   * Optional so a token predating the claim decodes; the guard rejects a missing claim with the same
   * ACCESS_TOKEN_REVOKED outcome as a tombstoned generation.
   */
  sessionGeneration?: number;
}

interface SignArgs {
  userId: string;
  householdId: string;
  deviceId: string;
  email: string;
  /** Optional caller-supplied jti, matched to the RefreshToken row. */
  jti?: string;
  /**
   * The session generation to stamp; optional only so older unit tests keep compiling, since every real
   * session-issuing caller passes it. A token signed without one is treated by `JwtAuthGuard` like a tombstoned
   * generation, never as generation 0.
   */
  sessionGeneration?: number;
}

@Injectable()
export class AccessTokenService {
  private readonly ttlSec: number;
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
        // Omitted entirely (never a literal undefined) when there is no generation to stamp.
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
   * Verifies signature and decodes; throws on any failure. The caller checks the RevokedToken denylist afterwards.
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
    // Strictly require the environment-specific issuer and audience, closing the cross-environment token-confusion
    // boundary.
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
      // The `email` claim is absent on tokens issued before it existed; the frontend falls back to its stored value.
      email: typeof payload.email === 'string' ? payload.email : '',
      jti: payload.jti,
      kid,
      iat: payload.iat,
      exp: payload.exp,
      // Surface a `purpose` claim if present; `JwtAuthGuard` rejects any token that has one.
      ...(typeof payload.purpose === 'string'
        ? { purpose: payload.purpose }
        : {}),
      // Not required here: a missing claim is rejected by `JwtAuthGuard` as ACCESS_TOKEN_REVOKED, not by `verify`
      // throwing a generic error.
      ...(typeof payload.sessionGeneration === 'number'
        ? { sessionGeneration: payload.sessionGeneration }
        : {}),
    };
  }

  /**
   * RFC 7517 JWKS view of the active public keys, served at `GET /auth/.well-known/jwks.json` so external verifiers
   * need no shared secret.
   */
  publicJwks(): JwksKey[] {
    return this.keys.jwks();
  }
}
