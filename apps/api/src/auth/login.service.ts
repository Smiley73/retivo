// Constant-timing login: argon2 always runs, against a dummy hash for an unknown email, so response time does not reveal
// registration. Issues access and refresh tokens with a matched jti.
import {
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { UsersRepository } from '../dynamo/users.repository.js';
import { CredentialsRepository } from '../dynamo/credentials.repository.js';
import { resolveCredentialRevision, resolveSessionGeneration } from '../dynamo/types.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import { UserMfaRepository } from '../dynamo/user-mfa.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { AccessTokenService } from './jwt.service.js';
import { FailedLoginService } from './failed-login.service.js';
import { RefreshTokenService } from './refresh-token.service.js';
import { MfaChallengeService, type MfaChallenge } from './mfa-challenge.service.js';
import { TrustedDeviceService, type DeviceTrustContext } from './trusted-device.service.js';
import { sha256 } from './refresh-token.service.js';
import type { EnvConfig } from '../common/env.config.js';

// Dummy password hashed at load, so the unknown-user branch costs the same as a wrong password.
const DUMMY_PASSWORD = '__phase2_constant_time_dummy_password__';
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash(DUMMY_PASSWORD, { type: argon2.argon2id });
  }
  return dummyHashPromise;
}

// The `429 LOGIN_BACKOFF` copy; `LoginPage` renders it verbatim, so the wording ships from here.
function loginBackoffMessage(retryAfterSec: number): string {
  const unit = retryAfterSec === 1 ? 'second' : 'seconds';
  return (
    `Too many failed sign-in attempts for this email address. ` +
    `Try again in ${retryAfterSec} ${unit}. ` +
    `If this wasn't you, someone else may be trying passwords — ` +
    `a device you've already chosen to remember can still sign in.`
  );
}

// Carries the trusted device row expiry so the controller can re-issue the cookie at the widened `/api/v1` path.
function withDeviceTrust(result: LoginResult, trust: DeviceTrustContext): LoginResult {
  return trust.trusted && trust.expiresAt !== undefined
    ? { ...result, deviceTrust: { expiresAt: trust.expiresAt } }
    : result;
}

export interface LoginArgs {
  email: string;
  password: string;
  deviceId: string;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * Raw device-trust cookie value; lets a trusted device skip the MFA challenge and, regardless of
   * `AUTH_MFA_ENFORCED`, bypass the per-address backoff.
   */
  deviceTrustToken?: string;
}

export interface LoginResult {
  accessToken: string;
  expiresInSec: number;
  refreshToken: string;
  refreshExpiresInSec: number;
  csrfToken: string;
  /**
   * Present only for a trusted-device session: the trust row epoch-second expiry, for the cookie re-issue. Never
   * serialized into the response body.
   */
  deviceTrust?: { expiresAt: number };
}

@Injectable()
export class LoginService {
  private readonly refreshTtlSec: number;
  private readonly mfaEnforced: boolean;

  constructor(
    private readonly users: UsersRepository,
    private readonly credentials: CredentialsRepository,
    private readonly failed: FailedLoginService,
    private readonly tokens: AccessTokenService,
    private readonly refresh: RefreshTokenService,
    private readonly auth: AuthEventsRepository,
    private readonly userMfa: UserMfaRepository,
    private readonly passkeys: PasskeysRepository,
    private readonly mfaChallenge: MfaChallengeService,
    private readonly trustedDevices: TrustedDeviceService,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.refreshTtlSec = config.get('AUTH_REFRESH_TOKEN_TTL_MIN', { infer: true }) * 60;
    // Master switch: the code default is false (local dev is password-only), deployed stacks default true via
    // `retivo:authMfaEnforced`; false is the operational kill-switch.
    this.mfaEnforced = config.get('AUTH_MFA_ENFORCED', { infer: true }) === 'true';
  }

  async login(args: LoginArgs): Promise<LoginResult | MfaChallenge> {
    const emailLowercase = args.email.toLowerCase();

    // The user lookup runs before the backoff check because the trust decision needs the user. Trust resolves
    // regardless of `AUTH_MFA_ENFORCED`, so a device remembered while it was on is still honoured after a rollback.
    // `resolveTrust` has the same lookup shape for an unknown email, keeping cost equal.
    const indexed = await this.users.findByEmail(emailLowercase);
    const trust = await this.trustedDevices.resolveTrust(
      indexed?.userId ?? null,
      args.deviceId,
      args.deviceTrustToken,
    );

    const backoff = await this.failed.checkBackoff(emailLowercase, trust);
    if (backoff.blocked) {
      throw new HttpException(
        {
          code: 'LOGIN_BACKOFF',
          message: loginBackoffMessage(backoff.retryAfterSec),
        },
        429,
      );
    }

    // `findByEmail` is an eventually consistent GSI Query, trusted only to resolve email to userId. Everything
    // decided from the row, above all the session generation, comes from a strongly consistent base-table read
    // taken before the credential is read: a stale GSI image could carry a generation a reset just retired and fail
    // the legitimate sign-in at the issuance ConditionCheck. A base-table miss means an unknown user.
    const user = indexed ? await this.users.findByIdConsistent(indexed.userId) : null;
    const credential = user ? await this.credentials.findByUserId(user.userId) : null;

    // Always verify against argon2 (dummy hash for a missing user), so timing is identical for an unknown email and
    // a wrong password.
    const hash = credential?.argon2Hash ?? (await getDummyHash());
    const matches = await argon2.verify(hash, args.password);

    if (!user || !credential || !matches) {
      await this.failed.recordFailure(emailLowercase, args.ip ?? null, args.userAgent ?? null, trust);
      // Unknown-email failures are audited with `SHA-256(emailLowercase)`, so the table is no user-existence oracle;
      // a length-derived value would collide and leak the length.
      await this.auth.record({
        userId: user?.userId ?? `anonymous-${sha256(emailLowercase)}`,
        eventType: 'login_failed',
        ip: args.ip,
        userAgent: args.userAgent,
        metadata: { reason: user ? 'wrong_password' : 'unknown_email' },
      });
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password.',
      });
    }

    if (!user.emailVerifiedAt) {
      throw new UnauthorizedException({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Verify your email address before signing in.',
      });
    }

    // Pre-existing users with no `approvalStatus` count as approved so the rollout does not lock them out; pending
    // and declined are blocked.
    if (user.approvalStatus === 'pending') {
      throw new HttpException(
        {
          code: 'ACCOUNT_PENDING_APPROVAL',
          message: 'Your account is waiting for the owner to approve sign-in.',
        },
        403,
      );
    }
    if (user.approvalStatus === 'declined') {
      throw new HttpException(
        {
          code: 'ACCOUNT_DECLINED',
          message: 'The owner declined this account. Contact them to retry.',
        },
        403,
      );
    }

    // Password and approval passed: clear the backoff counter, and for a trusted device its own ceiling.
    await this.failed.clear(emailLowercase, trust);

    // The generation observed by the strongly consistent read before the credential was read, never a later read:
    // an account-wide revoke committing in between would otherwise be adopted silently and mint a session that
    // survives it. Passing the earlier value makes the issuance ConditionCheck fail closed, forcing a retry that
    // re-verifies the password.
    const sessionGeneration = resolveSessionGeneration(user);

    // MFA two-step, gated by `AUTH_MFA_ENFORCED`. The revision recorded as the session write authority is resolved
    // once from the credential this branch verified, and reused by every issuance path.
    const credentialRevision = resolveCredentialRevision(credential);

    if (this.mfaEnforced) {
      // Reuse the trust decision resolved ahead of the backoff check; no second verify round trip.
      if (!trust.trusted) {
        // Bind the challenge to the login device id so `mfa/verify` rejects a device-substituted completion, and carry
        // this login revision so verify records the same authority.
        const challenge = await this.buildChallenge(
          user.userId,
          args.deviceId,
          credentialRevision,
          sessionGeneration,
        );
        await this.auth.record({
          userId: user.userId,
          eventType: 'mfa_challenge_issued',
          ip: args.ip,
          userAgent: args.userAgent,
          metadata: { deviceId: args.deviceId },
        });
        return challenge;
      }
      // Trusted device: issue a session and tag it device-trusted.
      const trustedResult = await this.issueSession({
        userId: user.userId,
        householdId: user.householdId,
        deviceId: args.deviceId,
        credentialRevision,
        sessionGeneration,
        ip: args.ip,
        userAgent: args.userAgent,
      });
      await this.auth.record({
        userId: user.userId,
        eventType: 'login',
        ip: args.ip,
        userAgent: args.userAgent,
        metadata: { deviceId: args.deviceId, mfa: 'device_trusted' },
      });
      return withDeviceTrust(trustedResult, trust);
    }

    const result = await this.issueSession({
      userId: user.userId,
      householdId: user.householdId,
      deviceId: args.deviceId,
      credentialRevision,
      sessionGeneration,
      ip: args.ip,
      userAgent: args.userAgent,
    });

    await this.auth.record({
      userId: user.userId,
      eventType: 'login',
      ip: args.ip,
      userAgent: args.userAgent,
      metadata: { deviceId: args.deviceId },
    });

    return withDeviceTrust(result, trust);
  }

  // Builds the MFA challenge, factors strongest first: `passkey` when the user has one, then `totp` when enrolled,
  // else `email_otp`, so a passkey-only user is not defaulted onto recovery Email-OTP. Recovery is always Email-OTP.
  // The challenge token is a 5-minute RS256 JWT.
  private async buildChallenge(
    userId: string,
    deviceId: string,
    credentialRevision: string,
    sessionGeneration: number,
  ): Promise<MfaChallenge> {
    const [mfa, passkeys] = await Promise.all([
      this.userMfa.get(userId),
      this.passkeys.listForUser(userId),
    ]);
    // A factor restricted post-reset is not offered; it stays refused if named directly (see
    // `passkey-assertion.service.ts` and `mfa.service.ts#verifyTotp`).
    const totpEnabled = !!mfa?.totpEnabled && !mfa.totpRestrictedPostReset;
    const hasPasskey = passkeys.some((p) => !p.restrictedPostReset);
    const methods: MfaChallenge['methods'] = [];
    if (hasPasskey) methods.push('passkey');
    if (totpEnabled) methods.push('totp');
    if (methods.length === 0) methods.push('email_otp');
    return {
      // `sessionGeneration` is the value from the password verification instant, never re-read at `mfa/verify`, so a
      // revoke during the MFA window is not silently bypassed.
      challengeToken: this.mfaChallenge.sign(userId, deviceId, credentialRevision, sessionGeneration),
      mfaRequired: true,
      methods,
      recoveryMethods: ['email_otp'],
    };
  }

  /**
   * Issues a fresh access, refresh and csrf trio after password login or a passkey assertion; the caller records the
   * audit event.
   */
  async issueSession(args: {
    userId: string;
    householdId: string;
    deviceId: string;
    /**
     * Credential revision to record as the session write authority. A passwordless passkey sign-in omits it, so the
     * session holds no password-slot write authority and heals through the re-wrap prompt.
     */
    credentialRevision?: string;
    /**
     * The account session generation to stamp. Required, never read here: the caller observed it at the right instant,
     * and a read here could adopt a generation an account-wide revoke committed in between.
     */
    sessionGeneration: number;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<LoginResult> {
    const tokenFamilyId = randomUUID();
    const jti = randomUUID();
    // The email claim: without it the SPA Profile page cannot show Email for passkey-only sessions.
    const user = await this.users.findById(args.userId);
    if (!user) {
      // Belt-and-braces: a null read means the account was deleted in the interim; the generation ConditionCheck
      // `attribute_exists` guard also fails it closed.
      throw new UnauthorizedException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'This account no longer exists.',
      });
    }
    // This read is for the email claim only; the generation is the caller `args.sessionGeneration`.
    const { sessionGeneration } = args;
    const access = this.tokens.sign({
      userId: args.userId,
      householdId: args.householdId,
      deviceId: args.deviceId,
      email: user?.email ?? '',
      jti,
      sessionGeneration,
    });
    const issued = await this.refresh.issueInitial({
      userId: args.userId,
      householdId: args.householdId,
      tokenFamilyId,
      jti: access.jti,
      deviceId: args.deviceId,
      credentialRevision: args.credentialRevision,
      sessionGeneration,
      ip: args.ip ?? null,
      userAgent: args.userAgent ?? null,
    });
    return {
      accessToken: access.token,
      expiresInSec: access.expiresInSec,
      refreshToken: issued.token,
      refreshExpiresInSec: this.refreshTtlSec,
      csrfToken: randomUUID(),
    };
  }
}
