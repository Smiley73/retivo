// HTTP layer for the enforced second-factor (MFA) endpoints: challenge send and verify, TOTP enroll and disable, status and trusted
// devices.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
  csrfCookieOptions,
  refreshCookieOptions,
} from './cookie-config.js';
import { parseCookies } from './session-authority.js';
import {
  MfaDisableDto,
  MfaEmailSendDto,
  MfaEnrollConfirmDto,
  MfaPasskeyStartDto,
  MfaVerifyDto,
  TrustedDeviceForgetDto,
} from './dto/mfa.dto.js';
import { ConfirmRestrictedFactorDto } from './dto/step-up.dto.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { LoginService } from './login.service.js';
import { VerifyPasswordService } from './verify-password.service.js';
import { MfaService } from './mfa.service.js';
import { StepUpService } from './step-up.service.js';
import { FactorEnrollmentGuardService } from './factor-enrollment-guard.service.js';
import { resolveOpenResetWindow } from './factor-restriction.js';
import { MfaChallengeService } from './mfa-challenge.service.js';
import { PasskeyAssertionService } from './passkey-assertion.service.js';
import { MfaEmailOtpService } from './mfa-email-otp.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { RevokedTokensRepository } from '../dynamo/revoked-tokens.repository.js';
import { FactorNoticeService } from './factor-notice.service.js';
import type { AccessTokenClaims } from './jwt.service.js';
import { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../common/env.config.js';

@Controller('auth')
export class MfaController {
  private readonly mfaEnforced: boolean;

  constructor(
    private readonly loginSvc: LoginService,
    private readonly auth: AuthEventsRepository,
    private readonly users: UsersRepository,
    private readonly verifyPasswordSvc: VerifyPasswordService,
    private readonly mfaSvc: MfaService,
    private readonly stepUpSvc: StepUpService,
    private readonly mfaChallengeSvc: MfaChallengeService,
    private readonly passkeyAssertions: PasskeyAssertionService,
    private readonly mfaEmailOtpSvc: MfaEmailOtpService,
    private readonly trustedDeviceSvc: TrustedDeviceService,
    private readonly revoked: RevokedTokensRepository,
    private readonly factorNotice: FactorNoticeService,
    private readonly factorEnrollmentGuard: FactorEnrollmentGuardService,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.mfaEnforced = config.get('AUTH_MFA_ENFORCED', { infer: true }) === 'true';
  }

  /**
   * Sends a 6-digit Email-OTP for the pending MFA challenge, to the user the challenge token names. Public and
   * CSRF-exempt (no session yet; Origin/Referer is still enforced); the challenge entropy, the per-IP throttle and
   * the per-user cooldown and cap carry abuse. Always 202 with no body.
   */
  @Public()
  @Post('mfa/email/send')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  async mfaEmailSend(@Body() dto: MfaEmailSendDto, @Req() req: Request) {
    const { userId } = this.mfaChallengeSvc.verify(dto.challengeToken);
    const user = await this.users.findById(userId);
    if (user) {
      await this.mfaEmailOtpSvc.send({
        userId,
        email: user.email,
        ip: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });
    }
  }

  /**
   * Starts a passkey second-factor assertion for the pending challenge, scoped to the user the token names; the
   * WebAuthn challenge is stored under `mfa:<userId>:<challenge>`. Public and CSRF-exempt like `mfa/email/send`. A
   * forged or expired token returns the same MFA_CHALLENGE_INVALID or _EXPIRED regardless of passkey count, so it is
   * no passkey-existence oracle.
   */
  @Public()
  @Post('mfa/passkey/start')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async mfaPasskeyStart(@Body() dto: MfaPasskeyStartDto) {
    const { userId } = this.mfaChallengeSvc.verify(dto.challengeToken);
    return this.passkeyAssertions.generateMfaStartOptions(userId);
  }

  /**
   * Completes the MFA challenge: verifies the second factor, optionally remembers the device, and issues a session.
   * Public and CSRF-exempt (pre-session; Origin/Referer enforced); the challenge token is the identity proof.
   */
  @Public()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 300_000, limit: 5 } })
  async mfaVerify(
    @Body() dto: MfaVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? null;
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;
    const {
      userId,
      deviceId: challengeDeviceId,
      jti: challengeJti,
      expiresAt: challengeExpiresAt,
      credentialRevision,
      sessionGeneration,
    } = this.mfaChallengeSvc.verify(dto.challengeToken);

    // Device binding: reject a body deviceId that differs from the signed claim before any verification, trust row
    // or session, so a captured challenge cannot mint a session for a caller-selected device. Maps to
    // MFA_CHALLENGE_INVALID, adding no oracle.
    if (dto.deviceId !== challengeDeviceId) {
      throw new UnauthorizedException({
        code: 'MFA_CHALLENGE_INVALID',
        message: 'The MFA challenge is invalid.',
      });
    }

    const user = await this.users.findById(userId);
    if (!user) {
      // The challenge named a user that no longer exists: a bad challenge, without leaking the deletion.
      throw new UnauthorizedException({
        code: 'MFA_CHALLENGE_INVALID',
        message: 'The MFA challenge is invalid.',
      });
    }

    // Reject when an account-wide revoke has retired the generation the challenge was minted under, before the
    // proof or challenge consumption. The challenge `credentialRevision` only denies stale write authority; it does
    // not stop a session being minted, which a revocation between the password step and here must.
    if (await this.revoked.isGenerationRevoked(userId, sessionGeneration)) {
      throw new UnauthorizedException({
        code: 'MFA_CHALLENGE_INVALID',
        message: 'The MFA challenge is invalid.',
      });
    }

    // Code factors return a boolean; the passkey factor verifies an assertion scoped to the challenge user and
    // throws a passkey-specific code on failure, bypassing the `ok` gate. The DTO guarantees `code` or `response`
    // presence per method.
    let ok: boolean;
    let passkeyCredentialId: string | null = null;
    if (dto.method === 'totp') {
      ok = await this.mfaSvc.verifyTotp(userId, dto.code!, ip, userAgent);
    } else if (dto.method === 'email_otp') {
      ok = (await this.mfaEmailOtpSvc.verify({ userId, code: dto.code!, ip, userAgent })).ok;
    } else {
      // Derive the user solely from the challenge token and ignore the assertion userHandle.
      const result = await this.passkeyAssertions.verifyMfaAssertion(
        userId,
        dto.response! as unknown as AuthenticationResponseJSON,
      );
      passkeyCredentialId = result.credentialId;
      ok = true;
    }

    if (!ok) {
      throw new UnauthorizedException({
        code: 'MFA_CODE_INVALID',
        message: 'The code is incorrect or no longer valid.',
      });
    }

    // Single-use consumption after the factor verifies but before any trust row or session: a replay loses the
    // single-winner write and is rejected as MFA_CHALLENGE_INVALID. If session issuance then fails the challenge
    // stays consumed by design; the user signs in again.
    const consumed = await this.revoked.consumeMfaChallenge({
      jti: challengeJti,
      userId,
      expiresAt: challengeExpiresAt,
    });
    if (!consumed) {
      throw new UnauthorizedException({
        code: 'MFA_CHALLENGE_INVALID',
        message: 'The MFA challenge is invalid.',
      });
    }

    // Only a routine factor may mint device trust: TOTP, passkey, or Email-OTP when the account has no authenticator
    // app and no usable passkey; Email-OTP used as recovery for such an account does not. The MFA state is read only
    // on the email_otp path, avoiding DynamoDB round trips on the common TOTP and passkey paths.
    const isRoutineFactor =
      dto.method === 'email_otp'
        ? await this.stepUpSvc.emailCodeMayRememberDevice(userId)
        : true;
    let deviceRemembered = false;
    if (dto.rememberDevice && isRoutineFactor) {
      // The deviceId rides in the login body, not the challenge.
      await this.trustedDeviceSvc.set(userId, dto.deviceId, sessionGeneration, res, ip, userAgent);
      deviceRemembered = true;
    }

    // Record the revision the challenge carries (verified at the password step), never re-read at verify time: the
    // two calls can be minutes apart, and a re-read would hand a pre-reset plaintext a post-reset authority.
    const session = await this.loginSvc.issueSession({
      userId,
      householdId: user.householdId,
      deviceId: dto.deviceId,
      credentialRevision,
      sessionGeneration,
      ip,
      userAgent,
    });
    res.cookie(
      REFRESH_COOKIE_NAME,
      session.refreshToken,
      refreshCookieOptions(session.refreshExpiresInSec * 1000),
    );
    res.cookie(
      CSRF_COOKIE_NAME,
      session.csrfToken,
      csrfCookieOptions(session.refreshExpiresInSec * 1000),
    );
    await this.auth.record({
      userId,
      eventType: 'login',
      ip,
      userAgent,
      // A passkey factor records the credentialId so the second factor is reconstructable for incident response
      // (NYDFS 500.06(b)).
      metadata: {
        deviceId: dto.deviceId,
        mfa: dto.method,
        ...(passkeyCredentialId ? { credentialId: passkeyCredentialId } : {}),
      },
    });
    return {
      accessToken: session.accessToken,
      expiresIn: session.expiresInSec,
      deviceRemembered,
    };
  }

  /**
   * Starts TOTP enrollment: mints a pending secret and returns the otpauth URL. Rejected when TOTP is already
   * enabled; replacing a factor goes through disable then add (see `MfaService.enrollStart`).
   */
  @Post('mfa/totp/enroll/start')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  async mfaTotpEnrollStart(@CurrentUser() me: AccessTokenClaims) {
    const result = await this.mfaSvc.enrollStart(me.userId, me.email || me.userId);
    if (!result) {
      throw new BadRequestException({
        code: 'MFA_TOTP_ALREADY_ENABLED',
        message: 'An authenticator app is already enabled. Turn it off before adding a new one.',
      });
    }
    return { secret: result.secret, otpauthUrl: result.otpauthUrl };
  }

  /**
   * Confirms TOTP enrollment by proving a live code. The enrollment gate protects this write, not `start`, which only
   * mints a pending secret. A read-only check of `dto.code` runs first: the gate consumes the single-use step-up
   * factor riding in the same request, so a mistyped code would burn the proof and make every retry fail.
   */
  @Post('mfa/totp/enroll/confirm')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 300_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  async mfaTotpEnrollConfirm(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: MfaEnrollConfirmDto,
    @Req() req: Request,
  ) {
    const ip = req.ip ?? null;
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;
    // Fail fast before the gate spends the single-use step-up proof.
    if (!(await this.mfaSvc.verifyPendingCode(me.userId, dto.code))) {
      throw new UnauthorizedException({
        code: 'MFA_CODE_INVALID',
        message: 'The code is incorrect or enrollment was not started.',
      });
    }
    await this.factorEnrollmentGuard.enforce({
      userId: me.userId,
      purpose: 'mfa_totp_enroll',
      proof: {
        currentPassword: dto.stepUp.currentPassword,
        method: dto.stepUp.method,
        code: dto.stepUp.code,
        response: dto.stepUp.response as unknown as AuthenticationResponseJSON | undefined,
      },
      mfaEnforced: this.mfaEnforced,
      ip,
      userAgent,
    });
    // Resolve whether this write lands inside an open password-reset window and stamp the factor restricted in the
    // same write that promotes it.
    const user = await this.users.findById(me.userId);
    const openWindow = user ? resolveOpenResetWindow(user, Date.now()) : null;
    const ok = await this.mfaSvc.enrollConfirm(me.userId, dto.code, openWindow, ip, userAgent);
    if (!ok) {
      throw new UnauthorizedException({
        code: 'MFA_CODE_INVALID',
        message: 'The code is incorrect or enrollment was not started.',
      });
    }
    if (openWindow) {
      await this.auth.record({
        userId: me.userId,
        eventType: 'factor_restriction_applied',
        ip,
        userAgent,
        metadata: { factorType: 'totp' },
      });
    }
    // Notify only after a true promotion; `notify` never rejects, and `noticeSent` tells the card whether the mail
    // went out.
    const noticeSent = user
      ? await this.factorNotice.notify({ userId: me.userId, email: user.email, kind: 'totp_add' })
      : false;
    return { totpEnabled: true, noticeSent };
  }

  /**
   * Disables the TOTP factor. Needs the current password via `VerifyPasswordService` and, when `AUTH_MFA_ENFORCED` is
   * on, a fresh step-up; a live TOTP code or the Email-OTP no-lockout fallback satisfies it, so a user who lost the
   * authenticator can still remove it. Idempotent; wrong password is 401 INVALID_CREDENTIALS.
   */
  @Post('mfa/totp/disable')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  async mfaTotpDisable(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: MfaDisableDto,
    @Req() req: Request,
  ) {
    // A trusted device re-verify bypasses the per-address backoff here too.
    const cookies = parseCookies(req.headers.cookie ?? '');
    await this.verifyPasswordSvc.verify({
      userId: me.userId,
      currentPassword: dto.currentPassword,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      deviceId: me.deviceId,
      deviceTrustToken: cookies[DEVICE_TRUST_COOKIE_NAME],
    });
    // Layered on the password gate when `AUTH_MFA_ENFORCED` is on; Email-OTP is the no-lockout floor.
    await this.enforceStepUpFactor(me.userId, 'mfa_totp_disable', dto, req);
    const disabled = await this.mfaSvc.disable(
      me.userId,
      req.ip ?? null,
      (req.headers['user-agent'] as string | undefined) ?? null,
    );
    // Notify only on an actual change, since a no-op disable has nothing to undo; `notify` never rejects.
    let noticeSent = false;
    if (disabled) {
      const user = await this.users.findById(me.userId);
      if (user) {
        noticeSent = await this.factorNotice.notify({
          userId: me.userId,
          email: user.email,
          kind: 'totp_remove',
        });
      }
    }
    return { totpEnabled: false, noticeSent };
  }

  /**
   * Current MFA factor status for the management UI, with no secret material, plus `stepUpRequired` and the eligible
   * `methods` and `recoveryMethods`. These flows have no request phase, so this read is where the client learns
   * whether step-up applies.
   */
  @Get('mfa/status')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async mfaStatus(@CurrentUser() me: AccessTokenClaims) {
    const [status, factors] = await Promise.all([
      this.mfaSvc.getStatus(me.userId),
      this.stepUpSvc.computeFactors(me.userId),
    ]);
    return {
      ...status,
      stepUpRequired: this.mfaEnforced,
      methods: factors.methods,
      recoveryMethods: factors.recoveryMethods,
    };
  }

  @Get('mfa/trusted-devices')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async mfaTrustedDevices(@CurrentUser() me: AccessTokenClaims) {
    const devices = await this.trustedDeviceSvc.list(me.userId);
    // Never surface the at-rest tokenHash.
    return {
      devices: devices.map((d) => ({
        deviceId: d.deviceId,
        createdAt: d.createdAt,
        expiresAt: d.expiresAt,
        lastUsedAt: d.lastUsedAt,
        ip: d.ip,
        userAgent: d.userAgent,
      })),
    };
  }

  /** Forgets the listed trusted devices, or every one when `deviceIds` is omitted. Idempotent. */
  @Post('mfa/trusted-devices/forget')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 3_600_000, limit: 20 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async mfaForgetTrustedDevices(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: TrustedDeviceForgetDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? null;
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;

    if (dto.deviceIds === undefined) {
      await this.trustedDeviceSvc.revokeAll(me.userId, ip, userAgent);
      this.trustedDeviceSvc.clearCookie(res);
    } else {
      await this.trustedDeviceSvc.revokeMany(me.userId, dto.deviceIds, ip, userAgent);
    }
  }

  /**
   * Lifts the TOTP post-reset restriction. The proof must come from a different, already-enrolled factor whose
   * enrollment predates the reset request that opened the window; the server resolves this. When nothing predates it,
   * the escape hatch is disabling and re-enrolling.
   */
  @Post('mfa/totp/confirm-restriction')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  async mfaTotpConfirmRestriction(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: ConfirmRestrictedFactorDto,
    @Req() req: Request,
  ) {
    await this.stepUpSvc.confirmRestrictedTotp({
      userId: me.userId,
      method: dto.method,
      code: dto.code,
      assertion: dto.response as unknown as AuthenticationResponseJSON | undefined,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
    return { totpRestrictedPostReset: false };
  }

  // Enforces the fresh step-up for TOTP disable after its password gate; a no-op when `AUTH_MFA_ENFORCED` is off. A
  // missing factor is 400 before any side effect; a bad one throws via `StepUpService.verify`, which emits the
  // `step_up_*` audit. The passkey factor rides in `dto.response`.
  private async enforceStepUpFactor(
    userId: string,
    purpose: 'mfa_totp_disable',
    dto: MfaDisableDto,
    req: Request,
  ): Promise<void> {
    if (!this.mfaEnforced) return;
    if (!dto.method) {
      await this.stepUpSvc.recordMissingProofFailure({
        userId,
        purpose,
        ip: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });
      throw new BadRequestException({
        code: 'STEP_UP_PROOF_MISSING',
        message: 'A second factor is required for this action.',
      });
    }
    await this.stepUpSvc.verify({
      userId,
      purpose,
      method: dto.method,
      code: dto.code,
      assertion: dto.response as unknown as AuthenticationResponseJSON | undefined,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
  }
}
