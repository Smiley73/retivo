/**
 * HTTP layer for signup, verify-email, login, refresh, logout.
 * See docs/security.md, "Accounts and sign-in".
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Request, Response } from 'express';
import { Public } from './public.decorator.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import {
  CSRF_COOKIE_NAME,
  DEVICE_TRUST_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  clearCsrfCookieOptions,
  clearRefreshCookieOptions,
  csrfCookieOptions,
  refreshCookieOptions,
} from './cookie-config.js';
import {
  ApproveSignupDto,
  ChangeEmailConfirmDto,
  ChangeEmailRequestDto,
  ChangeEmailVerifyStepUpDto,
  ChangePasswordDto,
  DeclineSignupDto,
  DeleteAccountDto,
  EncryptedWorkspaceResetDto,
  SignupDto,
  LoginDto,
  RequestPasswordResetDto,
  ResendVerificationDto,
  ResetPasswordDto,
  UpdateAccountDto,
  VerifyEmailDto,
  VerifyPasswordDto,
} from './dto/auth.dto.js';
import { SignupService } from './signup.service.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { LoginService } from './login.service.js';
import { ChangePasswordService } from './change-password.service.js';
import { ChangeEmailService } from './change-email.service.js';
import { DeleteAccountService } from './delete-account.service.js';
import { EncryptedWorkspaceResetService } from './encrypted-workspace-reset.service.js';
import { VerifyPasswordService } from './verify-password.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';
import { DataExportAuthorizationService } from './data-export-authorization.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { ResendVerificationService } from './resend-verification.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { SignupApprovalService } from './signup-approval.service.js';
import { RefreshTokenService, sha256 } from './refresh-token.service.js';
import { RefreshTokensRepository } from '../dynamo/refresh-tokens.repository.js';
import {
  parseCookies,
  resolveSessionCredentialRevision,
  resolveSessionTokenHash,
} from './session-authority.js';
import { AccessTokenService } from './jwt.service.js';
import type { AccessTokenClaims } from './jwt.service.js';
import { RevokedTokensRepository } from '../dynamo/revoked-tokens.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { PasswordValidatorService } from './password-validator.service.js';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { EnvConfig } from '../common/env.config.js';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly accessTtlSec: number;
  private readonly refreshTtlSec: number;

  constructor(
    private readonly signupSvc: SignupService,
    private readonly loginSvc: LoginService,
    private readonly verification: EmailVerificationService,
    private readonly resendSvc: ResendVerificationService,
    private readonly passwordResetSvc: PasswordResetService,
    private readonly refreshSvc: RefreshTokenService,
    private readonly tokens: AccessTokenService,
    private readonly revoked: RevokedTokensRepository,
    private readonly auth: AuthEventsRepository,
    private readonly passwords: PasswordValidatorService,
    private readonly users: UsersRepository,
    private readonly changePasswordSvc: ChangePasswordService,
    private readonly changeEmailSvc: ChangeEmailService,
    private readonly deleteAccountSvc: DeleteAccountService,
    private readonly encryptedWorkspaceResetSvc: EncryptedWorkspaceResetService,
    private readonly verifyPasswordSvc: VerifyPasswordService,
    private readonly dataExportAuth: DataExportAuthorizationService,
    private readonly approvalSvc: SignupApprovalService,
    private readonly refreshTokensRepo: RefreshTokensRepository,
    private readonly trustedDeviceSvc: TrustedDeviceService,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.accessTtlSec = config.get('AUTH_ACCESS_TOKEN_TTL_MIN', { infer: true }) * 60;
    this.refreshTtlSec = config.get('AUTH_REFRESH_TOKEN_TTL_MIN', { infer: true }) * 60;
  }

  @Public()
  @Post('signup')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async signup(@Body() dto: SignupDto, @Req() req: Request) {
    await this.passwords.validate(dto.password);
    const passwordHash = await SignupService.hashPassword(dto.password);
    const result = await this.signupSvc.signup({
      email: dto.email,
      passwordHash,
      firstName: dto.firstName,
      lastName: dto.lastName,
      birthdate: dto.birthdate,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
    return {
      userId: result.userId,
      email: result.email,
      verificationRequired: true,
      ...(result.verificationToken
        ? { verificationToken: result.verificationToken }
        : {}),
    };
  }

  /**
   * Consume a verification token. The SPA reads
   * the token from the mail link's URL fragment (`#token=…`, never sent
   * to the server) and POSTs it as JSON. Switching from GET-with-query
   * to POST-with-body keeps the token out of API Gateway / CloudFront
   * access logs and out of `Referer` headers on subsequent navigation.
   *
   * CSRF-exempt: the unverified user has no `csrf-token` cookie yet —
   * Origin/Referer + the per-IP throttle + token entropy carry the
   * abuse story until login mints the cookie.
   */
  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    const result = await this.verification.consumeToken(dto.token);
    return {
      verified: true,
      userId: result.userId,
      // Dev-only shortcut so local-dev (and AWS dev stacks where SES
      // delivery to APPROVER_EMAIL is awkward) can flip the gate
      // without a real mail. Same trapdoor as `verificationToken` in
      // the signup / resend response.
      ...(result.approvalToken
        ? { approvalToken: result.approvalToken }
        : {}),
    };
  }

  /**
   * Owner-approval gate.
   * The approval mail dispatched after email verification carries two
   * links — approve + decline — both pointing at this app with the
   * token in the URL fragment. These endpoints consume the token.
   *
   * CSRF-exempt + Public — the owner clicks the link from a mail
   * client and has no `csrf-token` cookie. Origin/Referer + per-IP
   * throttle + token entropy carry the abuse story.
   */
  @Public()
  @Post('approve-signup')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async approveSignup(@Body() dto: ApproveSignupDto) {
    const result = await this.approvalSvc.approve(dto.token);
    return { approved: true, email: result.email };
  }

  @Public()
  @Post('decline-signup')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async declineSignup(@Body() dto: DeclineSignupDto) {
    const result = await this.approvalSvc.decline(dto.token);
    return { declined: true, email: result.email };
  }

  /**
   * Resend the email-verification mail. Always returns 202 with the
   * same shape regardless of whether the email exists, is verified,
   * or is in cooldown — the per-IP throttle plus per-email cooldown +
   * daily cap inside the service contain abuse without giving callers
   * a user-existence oracle.
   */
  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async resendVerification(
    @Body() dto: ResendVerificationDto,
    @Req() req: Request,
  ) {
    const result = await this.resendSvc.resend({
      email: dto.email,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
    return {
      accepted: true,
      ...(result.verificationToken
        ? { verificationToken: result.verificationToken }
        : {}),
    };
  }

  /**
   * Request a password-reset link. Always returns 202 with the same shape
   * regardless of whether the email exists, is verified, or is in cooldown —
   * the per-IP throttle plus per-email cooldown + daily cap inside the
   * service contain abuse without giving callers a user-existence oracle.
   * The non-prod dev token is returned only on a real send.
   *
   * CSRF-exempt + Public: no session cookie exists yet for the user
   * requesting a reset. Token entropy + Origin/Referer + the per-IP
   * throttle carry the abuse story (mirrors resend-verification).
   */
  @Public()
  @Post('request-password-reset')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async requestPasswordReset(
    @Body() dto: RequestPasswordResetDto,
    @Req() req: Request,
  ) {
    const result = await this.passwordResetSvc.request({
      email: dto.email,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
    return {
      accepted: true,
      ...(result.resetToken ? { resetToken: result.resetToken } : {}),
    };
  }

  /**
   * Consume a password-reset token: rotate the credential, revoke every
   * session, and clear the per-email login backoff. Returns 204 (no body);
   * the SPA redirects to /login. Throws 410 RESET_TOKEN_EXPIRED /
   * 400 RESET_TOKEN_INVALID on a bad token.
   *
   * CSRF-exempt + Public: same posture as request-password-reset above.
   */
  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    await this.passwordResetSvc.consume({
      token: dto.token,
      newPassword: dto.newPassword,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
  }

  /**
   * First-run probe for the unauthenticated web root: if no users exist
   * yet, the SPA routes the visitor straight to /signup instead of /login.
   */
  @Public()
  @Get('setup-status')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async setupStatus() {
    return { hasUsers: await this.users.hasAnyUser() };
  }

  /**
   * RFC 7517 JWKS for the access-token signing keys. External verifiers — Lambda@Edge, mobile
   * clients, future microservices — can fetch this to validate JWTs without contacting the api or
   * holding any shared secret.
   *
   * Cached for 5 minutes at the edge; key rotation surfaces within the
   * cache window because the kid embedded in the JWT header pins the
   * specific public key needed.
   */
  @Public()
  @Get('.well-known/jwks.json')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  async jwks(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return { keys: this.tokens.publicJwks() };
  }

  @Public()
  @Post('login')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookies = parseCookies(req.headers.cookie ?? '');
    const result = await this.loginSvc.login({
      email: dto.email,
      password: dto.password,
      deviceId: dto.deviceId,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      // Carried so a trusted device can skip the MFA challenge and bypass the per-address backoff.
      // The cookie is scoped to /api/v1 (pre-widening browsers: /api/v1/auth), so either way it
      // arrives here.
      deviceTrustToken: cookies[DEVICE_TRUST_COOKIE_NAME],
    });

    // MFA enforced + untrusted device: no session yet — return the challenge as
    // JSON, set NO cookies. The SPA holds the challengeToken and completes
    // POST /auth/mfa/verify.
    if ('mfaRequired' in result) {
      return result;
    }

    // A trusted-device login re-issues the cookie that just verified at the
    // widened /api/v1 path (its remaining lifetime) and expires any copy still
    // scoped to the older /api/v1/auth path — the migration
    // for devices remembered before the widening, whose cookie reached login
    // but never `POST /sync/workspace/clear`. Idempotent for a
    // cookie already at /api/v1.
    const presentedTrust = cookies[DEVICE_TRUST_COOKIE_NAME];
    if (result.deviceTrust && presentedTrust) {
      this.trustedDeviceSvc.reissueCookie(res, presentedTrust, result.deviceTrust.expiresAt);
    }

    res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, refreshCookieOptions(result.refreshExpiresInSec * 1000));
    res.cookie(CSRF_COOKIE_NAME, result.csrfToken, csrfCookieOptions(result.refreshExpiresInSec * 1000));
    // The new profile fields are not spread automatically — map them
    // explicitly so the SPA can seed the primary HouseholdMember on first
    // login. Absent (old account) → undefined, omitted from the JSON.
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresInSec,
      firstName: result.firstName,
      lastName: result.lastName,
      birthdate: result.birthdate,
    };
  }

  @Public()
  @Post('refresh')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookies = parseCookies(req.headers.cookie ?? '');
    const presented = cookies[REFRESH_COOKIE_NAME];
    if (!presented) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh cookie missing.',
      });
    }
    const ip = req.ip ?? null;
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;
    // Minted BEFORE rotate() so the rotated refresh-token row is inserted carrying its FINAL jti
    // from the start (replaces the deleted `setJti` read/spread/full-row Put, which could clear a
    // concurrent revocation or recreate a deleted row).
    const newAccessJti = randomUUID();
    const rotated = await this.refreshSvc.rotate(presented, newAccessJti, ip, userAgent);

    // Carry the original login's deviceId + householdId forward so the
    // rotated access token's claims still match the SPA's localStorage
    // value (deviceId — the sync controller's
    // `dto.deviceId === me.deviceId` check) and the persisted ownership
    // scope (householdId — using `userId` as a proxy here is
    // fragile if the 1:1 invariant ever breaks).
    // Look up canonical email so the rotated access token continues
    // to carry the `email` claim that the SPA's Profile page reads
    // through. Refresh rotates the JWT — losing the claim here would
    // black-hole the email field one token-TTL after every login.
    const refreshUser = await this.users.findById(rotated.newRow.userId);
    const newAccess = this.tokens.sign({
      userId: rotated.newRow.userId,
      householdId: rotated.newRow.householdId,
      deviceId: rotated.newRow.deviceId,
      email: refreshUser?.email ?? '',
      jti: newAccessJti,
      // The rotated row's stamped generation — carried forward verbatim by
      // RefreshTokenService.rotate, never re-derived here, so a refreshed access token always
      // matches the generation its own refresh row was just committed under.
      sessionGeneration: rotated.newRow.sessionGeneration,
    });

    res.cookie(REFRESH_COOKIE_NAME, rotated.newToken, refreshCookieOptions(this.refreshTtlSec * 1000));
    const newCsrf = randomUUID();
    res.cookie(CSRF_COOKIE_NAME, newCsrf, csrfCookieOptions(this.refreshTtlSec * 1000));

    await this.auth.record({
      userId: rotated.newRow.userId,
      eventType: 'refresh',
      ip,
      userAgent,
    });

    return { accessToken: newAccess.token, expiresIn: newAccess.expiresInSec };
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // The session's recorded write authority,
    // resolved from the refresh cookie exactly the way `logout` resolves its
    // row — never a client-supplied value.
    const sessionCredentialRevision = await resolveSessionCredentialRevision(
      req,
      me.userId,
      me.jti,
      this.refreshTokensRepo,
    );
    // Device identity: a trusted device's
    // password re-verify bypasses the per-address backoff here too.
    const cookies = parseCookies(req.headers.cookie ?? '');
    const result = await this.changePasswordSvc.change({
      userId: me.userId,
      householdId: me.householdId,
      deviceId: me.deviceId,
      deviceTrustToken: cookies[DEVICE_TRUST_COOKIE_NAME],
      currentJti: me.jti,
      currentAccessExp: me.exp,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
      // Step-up factor proof — enforced by the
      // service when `AUTH_MFA_ENFORCED` is on. The passkey factor rides in
      // `response` (mirrors delete-account / change-email/verify-step-up).
      method: dto.method,
      code: dto.code,
      assertion: dto.response as unknown as AuthenticationResponseJSON | undefined,
      sessionCredentialRevision,
      // The re-wrapped password slot: present together, or all four
      // absent (the server-confirmed no-slot exception). The service decides
      // which shape applies from its own read of the household's slots.
      slot: dto.slot,
      envelopeSetVersion: dto.envelopeSetVersion,
      expectedEnvelopeSetVersion: dto.expectedEnvelopeSetVersion,
      envelopeSetTag: dto.envelopeSetTag,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    // The current device's old refresh token was revoked along with the
    // others; mint a fresh one so the caller's tab keeps working.
    res.cookie(
      REFRESH_COOKIE_NAME,
      result.refreshToken,
      refreshCookieOptions(result.refreshExpiresInSec * 1000),
    );
    res.cookie(
      CSRF_COOKIE_NAME,
      result.csrfToken,
      csrfCookieOptions(result.refreshExpiresInSec * 1000),
    );

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresInSec,
    };
  }

  /**
   * Session-preserving password re-verification (import / demo / export gate).
   * Tokens/cookies/sessions are untouched, but it shares the centralized
   * per-account login backoff — a wrong
   * password counts toward the counter and a lockout returns `429 LOGIN_BACKOFF`.
   *
   * The optional `purpose` is `data_export`, `change_password` or
   * `password_slot_rewrap`; a bare call (import, demo load,
   * encrypted-workspace reset) is also accepted. A successful `data_export`
   * verification mints the 5-min session-bound export-authorization cookie;
   * the other purposes mint nothing.
   */
  @Post('verify-password')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async verifyPassword(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: VerifyPasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // A successful verification grants the CURRENT session the password-slot
    // write authority a fresh login records —
    // resolved under the same active-session + jti-pairing guard as the
    // key-envelope write path, so a revoked or different (superseded) session
    // can never lend this write authority to a bearer it was never issued
    // for. Absent when no matching live session resolves; the service then
    // skips the update rather than granting authority to nothing.
    const sessionTokenHash = await resolveSessionTokenHash(
      req,
      me.userId,
      me.jti,
      this.refreshTokensRepo,
    );
    // Device identity: lets a trusted device's password
    // re-verify bypass the per-address backoff too, the same as login.
    const cookies = parseCookies(req.headers.cookie ?? '');
    await this.verifyPasswordSvc.verify({
      userId: me.userId,
      currentPassword: dto.currentPassword,
      purpose: dto.purpose,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      sessionTokenHash,
      deviceId: me.deviceId,
      deviceTrustToken: cookies[DEVICE_TRUST_COOKIE_NAME],
    });
    // A successful export-preparation re-auth mints the session-bound export
    // authorization (bound to userId + householdId + current access-token jti).
    // Only set on the `data_export` purpose — the bare/other callers are normal
    // product operations and mint nothing. The token carries `purpose`, so it can
    // never be presented as a session bearer.
    if (dto.purpose === 'data_export') {
      this.dataExportAuth.issueCookie(res, {
        userId: me.userId,
        householdId: me.householdId,
        jti: me.jti,
      });
    }
  }

  // ---------- Self-service email change + account record ----------

  /**
   * Account-record read for the Security-page account card.
   * Returns ONLY a typed projection of the
   * caller's `User` row — `{ email, firstName?, lastName?, birthdate? }` —
   * never the raw `UserRow` (which carries token / cooldown / pending-email
   * fields). Authenticated read; no CSRF (safe method). Light read limit.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async me(@CurrentUser() me: AccessTokenClaims) {
    const user = await this.users.findById(me.userId);
    if (!user) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Account not found.',
      });
    }
    // Typed serializer — emit only the account-record fields, never the raw row
    // (CODING_STANDARDS "Serialize API responses explicitly").
    return {
      email: user.email,
      ...(user.firstName !== undefined ? { firstName: user.firstName } : {}),
      ...(user.lastName !== undefined ? { lastName: user.lastName } : {}),
      ...(user.birthdate !== undefined ? { birthdate: user.birthdate } : {}),
    };
  }

  /**
   * Correct the account-record fields.
   * `PATCH /auth/me` — a `PUT` precedent exists (`key-envelope.controller.ts`)
   * but this body corrects three fields on the existing row rather than
   * replacing it wholesale, so PATCH is the better fit. `JwtAuthGuard` only:
   * **no password re-entry, no MFA step-up** — the write touches no
   * credential or session state, so being signed in is the whole gate.
   * CSRF + Origin apply automatically (non-safe method). Returns the same
   * typed projection `me()` returns, built from the just-written values —
   * never the raw row.
   */
  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  async updateMe(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: UpdateAccountDto,
    @Req() req: Request,
  ) {
    const user = await this.users.findById(me.userId);
    if (!user) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Account not found.',
      });
    }
    await this.users.updateProfile({
      userId: me.userId,
      firstName: dto.firstName,
      lastName: dto.lastName,
      birthdate: dto.birthdate,
    });
    // Which fields changed, by name, is fine to audit; the old and new values
    // are PII and are never written into metadata (mirrors email_change).
    await this.auth.record({
      userId: me.userId,
      eventType: 'account_record_correction',
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      metadata: { fields: ['firstName', 'lastName', 'birthdate'] },
    });
    return {
      email: user.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      birthdate: dto.birthdate,
    };
  }

  /**
   * Start a verified email change. Re-verifies the password, pre-checks
   * the new address (`409 EMAIL_TAKEN`), persists the pending intent. When
   * `AUTH_MFA_ENFORCED` returns `{ stepUpRequired: true, methods }`; otherwise
   * mints the change-email token + mails the link straight away. Handler is
   * thin — all logic in ChangeEmailService.
   */
  @Post('change-email/request')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  async changeEmailRequest(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: ChangeEmailRequestDto,
    @Req() req: Request,
  ) {
    // Device identity: a trusted device's
    // password re-verify bypasses the per-address backoff here too.
    const cookies = parseCookies(req.headers.cookie ?? '');
    return this.changeEmailSvc.request({
      userId: me.userId,
      newEmail: dto.newEmail,
      currentPassword: dto.currentPassword,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      deviceId: me.deviceId,
      deviceTrustToken: cookies[DEVICE_TRUST_COOKIE_NAME],
    });
  }

  /**
   * Send a fresh Email-OTP for the pending change-email step-up. Rejects
   * an expired/absent pending intent. OTP-send throttle precedent.
   */
  @Post('change-email/send-otp')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  @HttpCode(HttpStatus.ACCEPTED)
  async changeEmailSendOtp(
    @CurrentUser() me: AccessTokenClaims,
    @Req() req: Request,
  ) {
    await this.changeEmailSvc.sendStepUpOtp({
      userId: me.userId,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
  }

  /**
   * Verify the fresh MFA factor for the pending change-email intent. On a
   * valid factor mints the change-email token + mails the link to the new
   * address. Rejects an expired/absent pending intent.
   */
  @Post('change-email/verify-step-up')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  async changeEmailVerifyStepUp(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: ChangeEmailVerifyStepUpDto,
    @Req() req: Request,
  ) {
    return this.changeEmailSvc.verifyStepUp({
      userId: me.userId,
      method: dto.method,
      code: dto.code,
      // The passkey factor rides in `response`, validated as the same
      // WebAuthn envelope as the login finish body; the service maps it to the
      // step-up assertion.
      assertion: dto.response as unknown as AuthenticationResponseJSON | undefined,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
  }

  /**
   * Consume the change-email verification token. Public + CSRF-exempt +
   * Origin-checked — clicked from the new inbox, possibly another browser
   * (mirrors verify-email). The atomic swap moves email + EmailReservation
   * old→new under the single-valid-link invariant.
   */
  @Public()
  @Post('change-email/confirm')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  async changeEmailConfirm(
    @Body() dto: ChangeEmailConfirmDto,
    @Req() req: Request,
  ) {
    const result = await this.changeEmailSvc.confirm({
      token: dto.token,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
    return { changed: true, email: result.email };
  }

  @Delete('account')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAccount(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: DeleteAccountDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Device identity: a trusted device's password
    // re-verify bypasses the per-address backoff here too.
    const deleteCookies = parseCookies(req.headers.cookie ?? '');
    await this.deleteAccountSvc.deleteAccount({
      userId: me.userId,
      householdId: me.householdId,
      currentJti: me.jti,
      currentAccessExp: me.exp,
      currentPassword: dto.currentPassword,
      // Step-up factor proof. The passkey factor
      // rides in `response`, validated as the WebAuthn envelope; the service
      // maps it to the step-up assertion (mirrors change-email/verify-step-up).
      method: dto.method,
      code: dto.code,
      assertion: dto.response as unknown as AuthenticationResponseJSON | undefined,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      deviceId: me.deviceId,
      deviceTrustToken: deleteCookies[DEVICE_TRUST_COOKIE_NAME],
    });
    res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
    res.clearCookie(CSRF_COOKIE_NAME, clearCsrfCookieOptions());
  }

  /**
   * Account-preserving encrypted-workspace reset. The
   * recovery path when a user's encrypted household data is unreadable:
   * wipes the unreadable sync state + snapshots + key envelopes and revokes
   * all sessions, but keeps the account credentials + audit history so the
   * household can be re-keyed. Requires the exact confirmation phrase.
   *
   * Throttled like the destructive `DELETE /auth/account` posture
   * (`{ ttl: 60_000, limit: 3 }`).
   *
   * The gate is now phrase + password re-verify + (when `AUTH_MFA_ENFORCED`) a
   * fresh step-up factor — the service performs
   * the checks; the handler threads the proof from the body.
   */
  @Post('encrypted-workspace-reset')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async encryptedWorkspaceReset(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: EncryptedWorkspaceResetDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Device identity: a trusted device's
    // password re-verify bypasses the per-address backoff here too.
    const cookies = parseCookies(req.headers.cookie ?? '');
    await this.encryptedWorkspaceResetSvc.resetEncryptedWorkspace({
      userId: me.userId,
      householdId: me.householdId,
      currentJti: me.jti,
      currentAccessExp: me.exp,
      currentPassword: dto.currentPassword,
      method: dto.method,
      code: dto.code,
      assertion: dto.response as unknown as AuthenticationResponseJSON | undefined,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      deviceId: me.deviceId,
      deviceTrustToken: cookies[DEVICE_TRUST_COOKIE_NAME],
    });
    // Sessions were revoked server-side; clear the caller's cookies so the
    // SPA's hard reload to /login doesn't replay a now-revoked refresh
    // cookie at GET /auth/refresh (mirrors DELETE /auth/account).
    res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
    res.clearCookie(CSRF_COOKIE_NAME, clearCsrfCookieOptions());
  }

  /**
   * Sign-out. The two revocation steps below (access-token denylist +
   * refresh-row revoke) are the caller's proof of sign-out — the fail-closed
   * device-clear flow on the web client treats a 2xx here as "the server
   * session is provably gone". Cookies are
   * cleared ONLY after both have committed: clearing them on a path where a
   * revocation instead threw would manufacture that proof while a live
   * session row survives, and would take away the credential a retry needs
   * (the client's 401→refresh→retry still works because the refresh row is
   * untouched). The trailing audit write is a non-essential follow-up — it
   * must never turn an already-committed sign-out into a 5xx.
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() me: AccessTokenClaims,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Denylist the current access token so it stops working immediately.
    await this.revoked.revoke({
      jti: me.jti,
      userId: me.userId,
      revokedAt: new Date().toISOString(),
      expiresAt: me.exp,
    });

    // Revoke the refresh-token row paired with this jti, if present.
    const cookies = parseCookies(req.headers.cookie ?? '');
    const refresh = cookies[REFRESH_COOKIE_NAME];
    if (refresh) {
      const userIdFromCookie = refresh.split('.')[0];
      if (userIdFromCookie === me.userId) {
        await this.refreshSvc.revokeOne(me.userId, sha256(refresh));
      }
    }

    // Both revocations committed — safe to clear the cookies now.
    res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
    res.clearCookie(CSRF_COOKIE_NAME, clearCsrfCookieOptions());

    // Best-effort audit write (mirrors TrustedDeviceService.verify's hygiene
    // delete): the revocation already committed, so a rejected write here
    // must never fail the response — never log the cookie value or a token
    // hash.
    try {
      await this.auth.record({
        userId: me.userId,
        eventType: 'logout',
        ip: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });
    } catch (err) {
      this.logger.warn('Best-effort logout audit write failed', {
        userId: me.userId,
        reason: err instanceof Error ? err.name : 'unknown',
      });
    }
  }
}
