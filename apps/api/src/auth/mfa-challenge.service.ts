// Mints and verifies the 5-minute MFA challenge JWT. It carries a `purpose` claim so JwtAuthGuard rejects it as a bearer, the login deviceId,
// and a single-use `mfa:<uuid>` jti consumed at `mfa/verify`; no householdId. See docs/security.md, "The second factor".
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { JwtKeyStore } from './jwt-key-store.js';
import type { EnvConfig } from '../common/env.config.js';

// TTL for the challenge token: 5 minutes.
const MFA_CHALLENGE_TTL_SEC = 5 * 60;

// The claim that bars the token from being used as a session bearer.
const MFA_CHALLENGE_PURPOSE = 'mfa_challenge';

// The routine second factors; `passkey` leads when enrolled, being phishing-resistant.
type MfaRoutineMethod = 'totp' | 'email_otp' | 'passkey';

type MfaRecoveryMethod = 'email_otp';

/**
 * The login response when a second factor is required (no session yet); the client POSTs `challengeToken` to
 * `/auth/mfa/verify`.
 */
export interface MfaChallenge {
  challengeToken: string;
  mfaRequired: true;
  /**
   * The routine factors: `passkey` first when enrolled, then `totp`, otherwise `['email_otp']` as the universal
   * factor.
   */
  methods: MfaRoutineMethod[];
  recoveryMethods: MfaRecoveryMethod[];
}

@Injectable()
export class MfaChallengeService {
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
   * Signs a 5-minute challenge token bound to the login `deviceId` (`mfa/verify` rejects a body deviceId that
   * differs) with a single-use `mfa:<uuid>` jti that is conditionally consumed so a challenge completes at most once.
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
        // The revision the password step verified, carried on the signed claim so `mfa/verify` records the same
        // authority rather than re-reading the credential minutes later, which would hand a pre-reset plaintext a
        // post-reset authority.
        credentialRevision,
        // The session generation observed at that same instant: `mfa/verify` rejects completion if it has since been
        // retired, and otherwise stamps this value, never a re-read one.
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
   * Verifies a challenge token (signature, kid, expiry, issuer, audience, purpose) and returns the `userId`, bound
   * `deviceId`, `mfa:` jti and `exp`. Throws MFA_CHALLENGE_EXPIRED (401) when expired and MFA_CHALLENGE_INVALID (401)
   * for any other failure.
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
      // Surface expiry with a distinct code so the SPA prompts a fresh login rather than a generic retry.
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
    // The jti must be `mfa:`-prefixed so the consumption ledger cannot collide with a bare-UUID bearer revocation
    // row.
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
