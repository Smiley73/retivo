/**
 * Mints and verifies the short-lived "MFA challenge" JWT. When `AUTH_MFA_ENFORCED` is on and the
 * device is untrusted, login returns a challenge token instead of a session; the client presents it
 * to `POST /auth/mfa/verify` (and `POST /auth/mfa/email/send`) to complete the second factor.
 *
 * Same key store + RS256 signing (with `kid`-rotation via {@link JwtKeyStore})
 * and the same environment-specific issuer/audience claims as
 * `AccessTokenService` (jwt.service.ts), but the token carries an extra
 * `purpose: 'mfa_challenge'` claim. `JwtAuthGuard` rejects any verified token
 * that carries a `purpose`, so a challenge token can never be used as a session
 * bearer. 5-min TTL. The token is bound to the login `deviceId` (a signed claim
 * `mfa/verify` re-checks against the request body) and carries a single-use `mfa:<uuid>` `jti` that `mfa/verify`
 * conditionally consumes in a namespace-disjoint ledger, so a challenge
 * completes at most once. It carries NO `householdId` (no session
 * exists yet).
 *
 * See docs/security.md, "The second factor".
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { JwtKeyStore } from './jwt-key-store.js';
import type { EnvConfig } from '../common/env.config.js';

/** TTL for the MFA challenge token: 5 minutes. */
const MFA_CHALLENGE_TTL_SEC = 5 * 60;

/** Distinguishing claim that bars the token from being used as a session bearer. */
export const MFA_CHALLENGE_PURPOSE = 'mfa_challenge';

/**
 * The account's routine (primary) second factor(s). `passkey` leads when
 * the account has ≥1 enrolled passkey — phishing-resistant, stronger than the
 * routine factors beside it.
 */
type MfaRoutineMethod = 'totp' | 'email_otp' | 'passkey';

/** The recovery factor(s) the account can fall back to. */
type MfaRecoveryMethod = 'email_otp';

/**
 * The login response when a second factor is required (no session yet). The
 * client holds `challengeToken` and POSTs it back to `/auth/mfa/verify`.
 */
export interface MfaChallenge {
  /** The 5-min RS256 challenge JWT. */
  challengeToken: string;
  mfaRequired: true;
  /**
   * The account's routine factor(s). `passkey` leads when ≥1 passkey is
   * enrolled; `totp` when enrolled; otherwise `['email_otp']` as the
   * standing universal factor.
   */
  methods: MfaRoutineMethod[];
  /** Always `email_otp`. */
  recoveryMethods: MfaRecoveryMethod[];
}

@Injectable()
export class MfaChallengeService {
  /** Token-domain claims signed onto and strictly required by every challenge
   *  token. */
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
   * Sign a 5-min challenge token for `userId`, bound to the login `deviceId`.
   * The `purpose` claim makes it unusable
   * at any JWT-guarded route; the `deviceId` claim binds completion to the same
   * device login was started on (`mfa/verify` rejects a body deviceId that does
   * not match this signed value). Also carries the environment-specific
   * issuer/audience and a single-use `mfa:<uuid>` jti — the
   * namespace-disjoint key `mfa/verify` conditionally consumes so a challenge
   * completes at most once.
   */
  sign(
    userId: string,
    deviceId: string,
    credentialRevision: string,
    sessionGeneration: number,
  ): string {
    const { kid, privateKey } = this.keys.current();
    return jwt.sign(
      {
        userId,
        deviceId,
        purpose: MFA_CHALLENGE_PURPOSE,
        jti: `mfa:${randomUUID()}`,
        // The revision the password step verified — carried on the SIGNED claim so `mfa/verify`
        // records the same authority the password step verified rather than re-reading the
        // credential at verify time, which would hand a pre-reset plaintext a post-reset authority
        // when MFA is enforced and the two calls are minutes apart.
        credentialRevision,
        // The account session generation observed at that SAME instant —
        // for the identical
        // reason: `mfa/verify` rejects completion outright if this generation
        // has since been retired (see `verify` below), and otherwise stamps
        // this value (never a freshly re-read one) on the resulting session.
        sessionGeneration,
      },
      privateKey,
      {
        algorithm: 'RS256',
        keyid: kid,
        expiresIn: MFA_CHALLENGE_TTL_SEC,
        issuer: this.issuer,
        audience: this.audience,
      },
    );
  }

  /**
   * Verify a presented challenge token (signature + kid lookup + expiry +
   * issuer/audience + purpose). Returns the `userId`, bound `deviceId`, the
   * single-use `mfa:<uuid>` `jti`, and the token's `exp` (epoch seconds — the
   * TTL for the consumption ledger row). Throws
   * `MFA_CHALLENGE_EXPIRED` (401) when the 5-min window has elapsed and
   * `MFA_CHALLENGE_INVALID` (401) for any other failure (bad signature, unknown
   * kid, wrong/missing issuer/audience, wrong/missing purpose, missing
   * deviceId, missing/mis-prefixed jti, malformed token).
   */
  verify(token: string): {
    userId: string;
    deviceId: string;
    jti: string;
    expiresAt: number;
    credentialRevision: string;
    sessionGeneration: number;
  } {
    let decoded: ReturnType<typeof jwt.decode>;
    try {
      decoded = jwt.decode(token, { complete: true });
    } catch {
      throw this.invalid();
    }
    if (!decoded || typeof decoded === 'string') throw this.invalid();
    const kid = decoded.header.kid;
    if (!kid || typeof kid !== 'string') throw this.invalid();
    const publicKey = this.keys.publicFor(kid);
    if (!publicKey) throw this.invalid();

    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, publicKey, {
        algorithms: ['RS256'],
        issuer: this.issuer,
        audience: this.audience,
      }) as JwtPayload;
    } catch (err) {
      // jsonwebtoken throws TokenExpiredError on expiry; surface a distinct
      // code so the SPA can prompt for a fresh login rather than a generic
      // retry.
      if (err instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedException({
          code: 'MFA_CHALLENGE_EXPIRED',
          message: 'The MFA challenge has expired. Sign in again.',
        });
      }
      throw this.invalid();
    }

    if (payload.purpose !== MFA_CHALLENGE_PURPOSE) throw this.invalid();
    if (typeof payload.userId !== 'string' || payload.userId.length === 0) {
      throw this.invalid();
    }
    if (typeof payload.deviceId !== 'string' || payload.deviceId.length === 0) {
      throw this.invalid();
    }
    // Single-use jti: must be present and namespace-disjoint
    // (`mfa:`-prefixed) so the consumption ledger can never collide with a
    // bare-UUID bearer-token revocation row.
    if (typeof payload.jti !== 'string' || !payload.jti.startsWith('mfa:')) {
      throw this.invalid();
    }
    if (typeof payload.exp !== 'number') throw this.invalid();
    if (typeof payload.credentialRevision !== 'string' || payload.credentialRevision.length === 0) {
      throw this.invalid();
    }
    if (typeof payload.sessionGeneration !== 'number') throw this.invalid();
    return {
      userId: payload.userId,
      deviceId: payload.deviceId,
      jti: payload.jti,
      expiresAt: payload.exp,
      credentialRevision: payload.credentialRevision,
      sessionGeneration: payload.sessionGeneration,
    };
  }

  private invalid(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'MFA_CHALLENGE_INVALID',
      message: 'The MFA challenge is invalid.',
    });
  }
}
