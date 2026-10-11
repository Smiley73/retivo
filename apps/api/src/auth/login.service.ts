/**
 * Constant-timing login. Always runs argon2 verification — even on
 * user-not-found, against a precomputed dummy hash — so response time
 * does not leak whether an email is registered.
 *
 * On success: issue access + refresh tokens with matched jti so the
 * RevokedToken denylist can target a specific session on logout.
 */
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

// Pre-computed argon2 hash for "definitely-not-a-real-password". Used
// in the user-not-found branch so the verify cost is the same as a
// real-user-wrong-password branch. Cached at module load.
const DUMMY_PASSWORD = '__phase2_constant_time_dummy_password__';
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash(DUMMY_PASSWORD, { type: argon2.argon2id });
  }
  return dummyHashPromise;
}

/**
 * The on-screen `429 LOGIN_BACKOFF` copy for the sign-in page. `LoginPage`
 * renders the server message verbatim, so the wording ships from here. The
 * last sentence describes the trusted-device bypass.
 */
function loginBackoffMessage(retryAfterSec: number): string {
  const unit = retryAfterSec === 1 ? 'second' : 'seconds';
  return (
    `Too many failed sign-in attempts for this email address. ` +
    `Try again in ${retryAfterSec} ${unit}. ` +
    `If this wasn't you, someone else may be trying passwords — ` +
    `a device you've already chosen to remember can still sign in.`
  );
}

/**
 * Carry the trusted device's row expiry on a session result so the login
 * controller can re-issue the presented cookie at the widened `/api/v1` path
 * (see `TrustedDeviceService.reissueCookie`).
 * An untrusted login returns the result untouched.
 */
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
   * The raw device-trust cookie value, when present.
   * Lets a trusted device skip the MFA challenge, and — regardless of
   * `AUTH_MFA_ENFORCED` — bypass the per-address backoff. Undefined when no cookie was sent.
   */
  deviceTrustToken?: string;
}

export interface LoginResult {
  accessToken: string;
  expiresInSec: number;
  refreshToken: string;
  refreshExpiresInSec: number;
  csrfToken: string;
  /** Profile captured at signup (optional — old accounts omit it).
   * Surfaced so the SPA can seed the primary HouseholdMember on first
   * login. Populated by `issueSession` from the UserRow. */
  firstName?: string;
  lastName?: string;
  birthdate?: string;
  /**
   * Present only when this session was issued to a device whose device-trust
   * cookie verified: the matched trust row's
   * epoch-second expiry, so the login controller can re-issue that cookie at
   * the widened `/api/v1` path with its remaining lifetime. Never serialized
   * into the response body (the controller maps fields explicitly).
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
    // MFA master switch. The code default stays 'false' so
    // local `pnpm dev` without the var is password-only; the deployed dev + prod
    // stacks set AUTH_MFA_ENFORCED via the `retivo:authMfaEnforced` stack
    // config key (lambda.ts), default true.
    // Setting the deployed value 'false' is the permanent operational kill-switch
    // (no code redeploy needed): when off, login behaves exactly as before
    // (issueSession directly).
    this.mfaEnforced = config.get('AUTH_MFA_ENFORCED', { infer: true }) === 'true';
  }

  async login(args: LoginArgs): Promise<LoginResult | MfaChallenge> {
    const emailLowercase = args.email.toLowerCase();

    // The user lookup now runs BEFORE the backoff check (constant-time
    // hazard): deciding "is this device trusted" needs
    // (userId, deviceId, cookie), so the trust decision has to move ahead of
    // the block too. Resolved REGARDLESS of AUTH_MFA_ENFORCED: a
    // device remembered while the flag was on keeps its live trust row and
    // cookie after an operational rollback to 'false', and the shared backoff
    // primitive must honour it here exactly as the authenticated
    // password-proof routes do (they never consult the flag). The flag
    // governs only whether an UNTRUSTED success is MFA-challenged below.
    // `resolveTrust` issues the SAME lookup shape whether `user` resolved or
    // not, so an unknown email pays the same cost as a real one up to this
    // point.
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

    // `findByEmail` is a Query against the `EmailIndex` GSI, which DynamoDB
    // serves eventually consistently with no `ConsistentRead` option at all,
    // and whose replication lag is independent of (and typically longer
    // than) the base table's. That image is trusted here ONLY to resolve
    // email → userId. Everything this login decides from the row — above all
    // the session generation captured further down — comes from this strongly consistent
    // base-table read of that userId, taken BEFORE the credential is read
    // and the password verified. A stale GSI image would otherwise carry the
    // generation an account-wide revoke seconds earlier (a password reset)
    // had ALREADY retired, and `RefreshTokenService.issue`'s ConditionCheck
    // would then reject the legitimate sign-in that follows that reset — the
    // over-revocation direction. Reading before the credential (rather than
    // after the password verifies) keeps the property the generation comment
    // below relies on: the captured value is never newer than the proof. A
    // base-table miss for an indexed userId (the account was deleted after
    // the index image was written) is an unknown user.
    const user = indexed ? await this.users.findByIdConsistent(indexed.userId) : null;
    const credential = user ? await this.credentials.findByUserId(user.userId) : null;

    // Always verify against argon2 — dummy hash on the missing-user branch
    // so timing is identical between unknown email and wrong password.
    const hash = credential?.argon2Hash ?? (await getDummyHash());
    const matches = await argon2.verify(hash, args.password);

    if (!user || !credential || !matches) {
      await this.failed.recordFailure(emailLowercase, args.ip ?? null, args.userAgent ?? null, trust);
      // Audit unknown-email failures with a hashed email so the table
      // can't be used as a user-existence oracle. `SHA-256(emailLowercase)` —
      // never a length-derived value, which collides for every address of the
      // same length and leaks that length — matches `dynamo/types.ts`'s
      // `AuthEventRow` doc comment.
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

    // Owner-approval gate. Pre-existing users (no `approvalStatus`
    // attribute) are treated as approved so this rollout doesn't lock
    // them out. New signups carry the field explicitly — pending +
    // declined are blocked here.
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

    // Password (and approval) gate passed: clear the backoff counter — and,
    // for a trusted device, its own per-device ceiling too.
    await this.failed.clear(emailLowercase, trust);

    // The account's session generation AS OBSERVED BY THE STRONGLY CONSISTENT
    // READ ABOVE, taken before the credential this password was verified
    // against was even read — never a fresh read taken after that instant. A read
    // taken later — arbitrarily long after the password proof above (MFA
    // step-up, an approval check, or just an event-loop gap) — would, if an
    // account-wide revoke (password reset/change, account deletion) commits
    // in that window, silently adopt the NEW generation and mint a session
    // that survives a revocation whose whole purpose was to end sessions
    // predicated on the OLD, now-invalid credential this login just
    // verified. Passing the pre-verification value through means
    // `RefreshTokenService.issue`'s ConditionCheck instead fails closed — the
    // login must be retried, which re-verifies the (possibly now-changed)
    // password rather than silently carrying old proof across the boundary.
    const sessionGeneration = resolveSessionGeneration(user);

    // MFA two-step, gated by AUTH_MFA_ENFORCED. When the
    // flag is OFF (the code/local default), behaviour is unchanged — issueSession
    // directly. When ON (the deployed dev + prod posture): a trusted device skips
    // straight to a session; everyone else gets an MFA challenge (no session yet)
    // and must complete POST /auth/mfa/verify.
    // The revision this password login records as the session's write
    // authority — resolved once from the
    // credential row this branch just verified, and reused by every issuance
    // path below (trusted-device, MFA-challenge, plain).
    const credentialRevision = resolveCredentialRevision(credential);

    if (this.mfaEnforced) {
      // Reuse the trust decision already resolved above (ahead of the
      // backoff check) instead of a second `trustedDevices.verify()` round
      // trip — `trust` was resolved against this same real `user.userId`.
      if (!trust.trusted) {
        // Bind the challenge to the same normalized device id the login DTO
        // carried so `mfa/verify` can
        // reject a device-substituted completion. The challenge also carries
        // this login's resolved revision so `mfa/verify` records the
        // SAME authority the password step verified, never re-reading the
        // credential at verify time.
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
      // Trusted device — issue a session and tag the login as device-trusted.
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

  /**
   * Build the MFA challenge response. Routine factors,
   * strongest first: `passkey` leads whenever the user has ≥1 enrolled
   * passkey (phishing-resistant), then `totp` when enrolled, else `email_otp` as
   * the standing universal factor. A passkey-only user (no TOTP) therefore gets
   * `methods: ['passkey']` instead of defaulting onto recovery Email-OTP.
   * Recovery is always Email-OTP. The challenge token is a 5-min RS256 JWT the
   * client presents to POST /auth/mfa/verify.
   */
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
    // A factor restricted post-reset must not be
    // OFFERED as a login-MFA factor — it stays refused even if named directly
    // (the belt-and-suspenders check in `passkey-assertion.service.ts` /
    // `mfa.service.ts#verifyTotp`).
    const totpEnabled = !!mfa?.totpEnabled && !mfa.totpRestrictedPostReset;
    const hasPasskey = passkeys.some((p) => !p.restrictedPostReset);
    const methods: MfaChallenge['methods'] = [];
    if (hasPasskey) methods.push('passkey');
    if (totpEnabled) methods.push('totp');
    if (methods.length === 0) methods.push('email_otp');
    return {
      // `sessionGeneration` is the
      // value observed at the SAME password-verification instant as
      // `credentialRevision` — never re-read at `mfa/verify` time, for the
      // same reason: an account-wide revoke (password reset, undo) that
      // commits during the minutes-long MFA window must not be silently
      // bypassed by a completion that re-reads a NEW, already-current
      // generation and mints a session that survives the very boundary the
      // revoke drew.
      challengeToken: this.mfaChallenge.sign(userId, deviceId, credentialRevision, sessionGeneration),
      mfaRequired: true,
      methods,
      recoveryMethods: ['email_otp'],
    };
  }

  /**
   * Issue a fresh access + refresh + csrf trio. Used by password login and
   * passkey assertion paths after they've each verified the user. Auth
   * event recording is the caller's responsibility (different `eventType`).
   */
  async issueSession(args: {
    userId: string;
    householdId: string;
    deviceId: string;
    /**
     * The credential revision to record as this session's write authority.
     * Password login and the change-password
     * re-issue pass a resolved value; a passwordless passkey sign-in omits
     * it, so the session records none and therefore holds no password-slot
     * write authority (it heals through the re-wrap prompt).
     */
    credentialRevision?: string;
    /**
     * The account session generation to stamp. REQUIRED — this method never
     * reads it itself: every caller has observed the generation at a MORE
     * correct instant than "whenever this method happens to run", and a
     * fresh read here, taken arbitrarily long after the caller's proof, would
     * silently adopt a generation an account-wide revoke committed in between
     * and mint a session that survives the very boundary the revoke drew. A
     * password login passes the value from its strongly consistent User read
     * taken before the password was verified; an MFA completion passes the
     * value carried on the challenge (captured at that same instant); a
     * passkey sign-in passes the value from its strongly consistent User
     * read taken before the assertion was verified; a change-password
     * re-issue passes the value its own `revokeAll` call just committed
     * (never re-read eventually-consistently against a bump it just made).
     */
    sessionGeneration: number;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<LoginResult> {
    const tokenFamilyId = randomUUID();
    const jti = randomUUID();
    // Look up the user's canonical email so the access-token JWT
    // carries it as a claim. Without this, the SPA's Profile page
    // can't render "Email" for passkey-only sessions (no password
    // login → no localStorage email seed; the JWT was previously
    // the only source).
    const user = await this.users.findById(args.userId);
    if (!user) {
      // Belt-and-braces: every real
      // caller has already authenticated `args.userId` moments earlier, so a
      // null read here means the account was deleted in the interim. The
      // generation `ConditionCheck`'s own `attribute_exists` guard already
      // fails a deleted account closed at commit time, but failing here too
      // costs nothing and never depends on that guard alone.
      throw new UnauthorizedException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'This account no longer exists.',
      });
    }
    // The row above is read for the email claim ONLY. The
    // session generation is the caller's `args.sessionGeneration`, verbatim
    // — never this (default, eventually consistent) read's value, which was
    // taken after the caller's proof; see the parameter doc above.
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
      // Surface the signup profile (when present) so the SPA can seed the
      // primary HouseholdMember. Covers password + passkey paths (both call
      // issueSession). Absent on old accounts → omitted from the response.
      firstName: user?.firstName,
      lastName: user?.lastName,
      birthdate: user?.birthdate,
    };
  }
}
