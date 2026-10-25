// HTTP layer for signup, verify-email, login, refresh, logout and account changes. See docs/security.md, "Accounts and sign-in".
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
   * Consumes a verification token POSTed from the mail link URL fragment, which keeps it out of access logs and
   * `Referer`. CSRF-exempt: the unverified user has no `csrf-token` cookie yet, so Origin/Referer, the per-IP
   * throttle and token entropy carry it.
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
      // Dev-only shortcut (same trapdoor as `verificationToken`) so the approval gate can be flipped without a real
      // mail.
      ...(result.approvalToken
        ? { approvalToken: result.approvalToken }
        : {}),
    };
  }

  /**
   * Owner-approval endpoints consuming the approve and decline mail-link tokens. CSRF-exempt and public: the owner
   * clicks from a mail client with no `csrf-token` cookie, so Origin/Referer, the per-IP throttle and token entropy
   * carry it.
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
   * Resends the verification mail. Always 202 with the same shape, so the per-IP throttle plus per-email cooldown and
   * daily cap give no user-existence oracle.
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
   * Requests a password-reset link. Always 202 with the same shape (no user-existence oracle); the non-prod dev token
   * is returned only on a real send. CSRF-exempt and public: no session cookie exists yet.
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
   * Consumes a reset token: rotates the credential, revokes every session and clears the per-email login backoff.
   * 204; 410 RESET_TOKEN_EXPIRED or 400 RESET_TOKEN_INVALID on a bad token. CSRF-exempt and public, like
   * request-password-reset.
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

  /** First-run probe: if no users exist the SPA routes the visitor to /signup instead of /login. */
  @Public()
  @Get('setup-status')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async setupStatus() {
    return { hasUsers: await this.users.hasAnyUser() };
  }

  /**
   * RFC 7517 JWKS for the access-token signing keys, so external verifiers can validate JWTs without a shared secret.
   * Cached 5 minutes at the edge; the JWT header `kid` pins the key, so rotation surfaces within the cache window.
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
      // Lets a trusted device skip the MFA challenge and the per-address backoff; the cookie is scoped to /api/v1, so
      // it arrives here.
      deviceTrustToken: cookies[DEVICE_TRUST_COOKIE_NAME],
    });

    // MFA enforced on an untrusted device: no session yet, so return the challenge as JSON with no cookies.
    if ('mfaRequired' in result) {
      return result;
    }

    // Re-issue the trust cookie at the widened /api/v1 path and expire any copy at the older /api/v1/auth path
    // (devices remembered before the widening).
    const presentedTrust = cookies[DEVICE_TRUST_COOKIE_NAME];
    if (result.deviceTrust && presentedTrust) {
      this.trustedDeviceSvc.reissueCookie(res, presentedTrust, result.deviceTrust.expiresAt);
    }

    res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, refreshCookieOptions(result.refreshExpiresInSec * 1000));
    res.cookie(CSRF_COOKIE_NAME, result.csrfToken, csrfCookieOptions(result.refreshExpiresInSec * 1000));
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresInSec,
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
    // Minted before rotate() so the rotated row is inserted with its final jti, which a read/spread/full-row Put
    // afterwards could use to clear a concurrent revocation or recreate a deleted row.
    const newAccessJti = randomUUID();
    const rotated = await this.refreshSvc.rotate(presented, newAccessJti, ip, userAgent);

    // Carry the original deviceId and householdId forward so the rotated token claims still match the SPA and the
    // persisted ownership (userId is only a proxy while the 1:1 invariant holds). The canonical email is looked up
    // so the `email` claim survives rotation.
    const refreshUser = await this.users.findById(rotated.newRow.userId);
    const newAccess = this.tokens.sign({
      userId: rotated.newRow.userId,
      householdId: rotated.newRow.householdId,
      deviceId: rotated.newRow.deviceId,
      email: refreshUser?.email ?? '',
      jti: newAccessJti,
      // Carried verbatim from the rotated row, never re-derived, so a refreshed token matches the generation its own
      // refresh row committed under.
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
    // The session recorded write authority, resolved from the refresh cookie as `logout` does, never
    // client-supplied.
    const sessionCredentialRevision = await resolveSessionCredentialRevision(
      req,
      me.userId,
      me.jti,
      this.refreshTokensRepo,
    );
    // A trusted device re-verify bypasses the per-address backoff here too.
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
      // Step-up proof, enforced by the service when `AUTH_MFA_ENFORCED` is on; the passkey factor rides in
      // `response`.
      method: dto.method,
      code: dto.code,
      assertion: dto.response as unknown as AuthenticationResponseJSON | undefined,
      sessionCredentialRevision,
      // The re-wrapped password slot: all four fields present or all absent (the server-confirmed no-slot exception);
      // the service decides which applies.
      slot: dto.slot,
      envelopeSetVersion: dto.envelopeSetVersion,
      expectedEnvelopeSetVersion: dto.expectedEnvelopeSetVersion,
      envelopeSetTag: dto.envelopeSetTag,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    // The old refresh token was revoked with the others; mint a fresh one so the caller tab keeps working.
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
   * Session-preserving password re-verification (import, demo, export gate). Sessions are untouched, but it shares
   * the per-account login backoff (429 LOGIN_BACKOFF). `purpose` is `data_export`, `change_password`,
   * `password_slot_rewrap`, or absent; only `data_export` mints the 5-minute session-bound export-authorization
   * cookie.
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
    // A successful verification grants the current session the password-slot write authority a login records,
    // resolved under the same active-session and jti-pairing guard as the key-envelope write path, so a revoked or
    // superseded session cannot lend it.
    const sessionTokenHash = await resolveSessionTokenHash(
      req,
      me.userId,
      me.jti,
      this.refreshTokensRepo,
    );
    // A trusted device re-verify bypasses the per-address backoff, as in login.
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
    // Only `data_export` mints the export authorization (bound to userId, householdId and the access-token jti); it
    // carries `purpose`, so it can never be presented as a session bearer.
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
   * Account-record read for the Security-page card: a typed projection of the `User` row, never the raw row (which
   * carries token, cooldown and pending-email fields). Light read limit.
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
    // Typed serializer (CODING_STANDARDS "Serialize API responses explicitly").
    return {
      email: user.email,
      ...(user.firstName !== undefined ? { firstName: user.firstName } : {}),
      ...(user.lastName !== undefined ? { lastName: user.lastName } : {}),
      ...(user.birthdate !== undefined ? { birthdate: user.birthdate } : {}),
    };
  }

  /**
   * `PATCH /auth/me`: corrects `firstName`, `lastName` and `birthdate`. `JwtAuthGuard` only, no password or MFA
   * step-up, because the write touches no credential or session state. Returns the typed projection of the
   * just-written values.
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
    // Which fields changed is audited by name; the old and new values are PII and never written into metadata.
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
   * Starts a verified email change: re-verifies the password, pre-checks the new address (409 EMAIL_TAKEN) and
   * persists the pending intent. With `AUTH_MFA_ENFORCED` returns `{ stepUpRequired: true, methods }`; otherwise it
   * mints the token and mails the link. Logic lives in ChangeEmailService.
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
    // A trusted device re-verify bypasses the per-address backoff here too.
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

  /** Sends a fresh Email-OTP for the pending change-email step-up; rejects an expired or absent intent. */
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
   * Verifies the fresh MFA factor for the pending change-email intent, then mints the token and mails the new
   * address; rejects an expired or absent intent.
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
      // The passkey factor rides in `response`, validated as the login finish body; the service maps it to the
      // step-up assertion.
      assertion: dto.response as unknown as AuthenticationResponseJSON | undefined,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
  }

  /**
   * Consumes the change-email token. Public and CSRF-exempt but Origin-checked: clicked from the new inbox, possibly
   * in another browser. The swap moves email and reservation old to new under the single-valid-link invariant.
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
    // A trusted device re-verify bypasses the per-address backoff here too.
    const deleteCookies = parseCookies(req.headers.cookie ?? '');
    await this.deleteAccountSvc.deleteAccount({
      userId: me.userId,
      householdId: me.householdId,
      currentJti: me.jti,
      currentAccessExp: me.exp,
      currentPassword: dto.currentPassword,
      // Step-up proof; the passkey factor rides in `response`, validated as the WebAuthn envelope.
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
   * Account-preserving encrypted-workspace reset, the recovery path when encrypted household data is unreadable:
   * wipes sync state, snapshots and key envelopes and revokes all sessions, keeping credentials and audit history.
   * The service checks the confirmation phrase, the password and, with `AUTH_MFA_ENFORCED`, a fresh step-up.
   * Throttled like `DELETE /auth/account`.
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
    // A trusted device re-verify bypasses the per-address backoff here too.
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
    // Clear the caller cookies so the SPA hard reload to /login does not replay a revoked refresh cookie.
    res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
    res.clearCookie(CSRF_COOKIE_NAME, clearCsrfCookieOptions());
  }

  /**
   * Sign-out. A 2xx is the client proof that the server session is gone (the fail-closed device-clear flow relies on
   * it), so cookies are cleared only after both the access-token denylist and the refresh-row revoke committed;
   * clearing them after a thrown revocation would fake that proof and drop the credential a retry needs. The trailing
   * audit write must never turn a committed sign-out into a 5xx.
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() me: AccessTokenClaims,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.revoked.revoke({
      jti: me.jti,
      userId: me.userId,
      revokedAt: new Date().toISOString(),
      expiresAt: me.exp,
    });

    const cookies = parseCookies(req.headers.cookie ?? '');
    const refresh = cookies[REFRESH_COOKIE_NAME];
    if (refresh) {
      const userIdFromCookie = refresh.split('.')[0];
      if (userIdFromCookie === me.userId) {
        await this.refreshSvc.revokeOne(me.userId, sha256(refresh));
      }
    }

    res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
    res.clearCookie(CSRF_COOKIE_NAME, clearCsrfCookieOptions());

    // Best-effort audit: the revocation already committed, so a rejected write must not fail the response. Never
    // log the cookie value or a token hash.
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
