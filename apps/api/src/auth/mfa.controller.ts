/**
 * HTTP layer for the enforced second-factor (MFA) endpoints. Extracted verbatim from
 * `auth.controller.ts` — same `@Controller('auth')` prefix, so every
 * route path is byte-identical to before the move. Decorators (guards, throttle ttl/limit,
 * HttpCode, Public) and the private `enforceStepUpFactor` step-up gate are preserved exactly; only
 * the services these routes use are injected.
 */
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
import { UserMfaRepository } from '../dynamo/user-mfa.repository.js';
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
    private readonly userMfa: UserMfaRepository,
    private readonly revoked: RevokedTokensRepository,
    private readonly factorNotice: FactorNoticeService,
    private readonly factorEnrollmentGuard: FactorEnrollmentGuardService,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.mfaEnforced = config.get('AUTH_MFA_ENFORCED', { infer: true }) === 'true';
  }

  // ---------- Enforced second-factor (MFA) endpoints ----------

  /**
   * Send a 6-digit Email-OTP for the pending MFA challenge.
   * Pre-session: the only identity proof is the 5-min challenge token, so the
   * code is only sent to the user it names.
   *
   * `@Public()` + CSRF-exempt: the user has no `csrf-token` cookie at the MFA
   * step (no session yet). Origin/Referer is STILL enforced by
   * `OriginCheckMiddleware` (same precedent as verify-email /
   * request-password-reset). The challenge-token
   * entropy + the per-IP throttle + the per-user cooldown/cap carry the abuse
   * story. Always returns 202 with no body.
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
   * Start a passkey second-factor assertion for the pending MFA challenge.
   * Returns WebAuthn authentication
   * options whose `allowCredentials` are scoped to the user the challenge token
   * names — a step-up against the already-authenticated account, not a
   * discoverable login. The WebAuthn challenge is stored under the userId-scoped
   * `mfa:<userId>:<challenge>` namespace, consumed only by the `passkey` branch
   * of `mfa/verify`.
   *
   * `@Public()` + CSRF-exempt (pre-session, no `csrf-token` cookie at the MFA
   * step); Origin/Referer is STILL enforced by `OriginCheckMiddleware` (same
   * precedent as `mfa/email/send` / `passkey/authenticate/start`). The explicit
   * `@Throttle` matches `passkey/authenticate/start`. A forged/expired
   * token returns the same `MFA_CHALLENGE_INVALID`/`_EXPIRED` regardless of
   * passkey count, so it is not a passkey-existence oracle. Delegates to the
   * shared PasskeyAssertionService so this controller holds no @simplewebauthn
   * deps.
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
   * Complete the MFA challenge: verify the second factor, optionally remember
   * the device, and issue a session.
   *
   * `@Public()` + CSRF-exempt (pre-session); Origin/Referer enforced (same
   * precedent as verify-email). The challenge token is the
   * identity proof; the chosen factor is the knowledge proof.
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

    // Device binding: the challenge was
    // signed for the device login started on. Reject a body deviceId that does
    // not match the signed claim BEFORE any factor verification, trusted-device
    // creation, or session issuance — a captured challenge cannot be replayed to
    // mint a session/trust row for a caller-selected device. Maps to the
    // existing `MFA_CHALLENGE_INVALID` response so no new client branch or
    // public oracle is introduced.
    if (dto.deviceId !== challengeDeviceId) {
      throw new UnauthorizedException({
        code: 'MFA_CHALLENGE_INVALID',
        message: 'The MFA challenge is invalid.',
      });
    }

    const user = await this.users.findById(userId);
    if (!user) {
      // The challenge named a user that no longer exists. Treat as a bad
      // challenge rather than leaking the deletion.
      throw new UnauthorizedException({
        code: 'MFA_CHALLENGE_INVALID',
        message: 'The MFA challenge is invalid.',
      });
    }

    // Reject outright when an account-wide revoke (password reset/change,
    // account deletion, factor-notice undo) has retired the generation this
    // challenge was minted under —
    // the same one-key lookup `JwtAuthGuard` already does. The challenge's
    // `credentialRevision` alone only denies stale WRITE authority; it
    // does not stop a session from being minted at all, which is exactly the
    // boundary a revocation between the password step and this completion is
    // meant to draw. Checked BEFORE the factor proof / challenge consumption
    // below so a retired challenge is never treated as a live one.
    if (await this.revoked.isGenerationRevoked(userId, sessionGeneration)) {
      throw new UnauthorizedException({
        code: 'MFA_CHALLENGE_INVALID',
        message: 'The MFA challenge is invalid.',
      });
    }

    // Factor proof. The two code factors return a boolean (false → bad code);
    // the passkey factor verifies a WebAuthn assertion scoped to the challenge
    // user and THROWS a passkey-specific code on failure (so it
    // bypasses the `ok` gate below). `credentialId` is carried into the audit
    // metadata. `dto.code` / `dto.response` presence is guaranteed by the
    // method-conditional DTO validation, so the non-null assertions are safe.
    let ok: boolean;
    let passkeyCredentialId: string | null = null;
    if (dto.method === 'totp') {
      ok = await this.mfaSvc.verifyTotp(userId, dto.code!, ip, userAgent);
    } else if (dto.method === 'email_otp') {
      ok = (await this.mfaEmailOtpSvc.verify({ userId, code: dto.code!, ip, userAgent })).ok;
    } else {
      // passkey: derive the user solely from the challenge token (above), verify
      // the assertion against that user's enrolled credentials, ignoring the
      // assertion userHandle. Throws PASSKEY_USER_VERIFICATION_REQUIRED /
      // PASSKEY_COUNTER_ANOMALY / MFA_CODE_INVALID on failure.
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

    // Single-use challenge consumption: after the factor is verified but BEFORE any trusted-device
    // creation or session issuance, conditionally consume the challenge's `mfa:<uuid>` jti. A
    // replay (sequential or concurrent) loses this single-winner write and is rejected as
    // `MFA_CHALLENGE_INVALID` — no alternative session or trust row is minted; the user simply
    // signs in again. If session issuance below subsequently fails, the challenge stays consumed by
    // design: a fresh login is required rather than a silent retry.
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

    // Remember-this-device eligibility: only a ROUTINE factor may mint
    // trust — Email-OTP used as RECOVERY for a TOTP account does not. A TOTP
    // account's routine factor is TOTP; an account with no TOTP factor uses
    // Email-OTP as its routine factor (so that IS eligible). Passkey is always
    // routine (phishing-resistant).
    //
    // isRoutineFactor: trust minted only for the routine second factor.
    // - totp: always routine (you enrolled it precisely to use it)
    // - passkey: always routine (the strongest factor, eligible for trust)
    // - email_otp: routine when TOTP is not enrolled; recovery when it is
    let isRoutineFactor: boolean;
    if (dto.method === 'totp' || dto.method === 'passkey') {
      isRoutineFactor = true;
    } else {
      // email_otp — fetch MFA state only on this path (avoids a DynamoDB
      // round-trip on the more common TOTP path).
      const mfa = await this.userMfa.get(userId);
      isRoutineFactor = !mfa?.totpEnabled;
    }
    let deviceRemembered = false;
    if (dto.rememberDevice && isRoutineFactor) {
      // The deviceId rides in the login body, not the challenge — read it from
      // the same client-persisted source the SPA sends at login.
      await this.trustedDeviceSvc.set(userId, dto.deviceId, res, ip, userAgent);
      deviceRemembered = true;
    }

    // Record the revision carried on the challenge — the one the PASSWORD
    // step verified — never re-read from the credential at verify time:
    // with MFA enforced the password call and
    // this completion can be minutes apart, and re-reading would hand a
    // pre-reset plaintext a post-reset authority while looking correct.
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
      // A passkey second factor records the credentialId so the second factor is
      // reconstructable for incident response (NYDFS 500.06(b)).
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
   * Start TOTP enrollment: mint a pending secret + return the otpauth URL for
   * the QR. Authenticated (the user is enrolling a factor on their own account).
   * Rejected when TOTP is already enabled — replacing an enabled factor must
   * go through the existing disable-then-add flow (see `MfaService.enrollStart`'s
   * doc comment for why an enroll-over-enabled is unsafe).
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
   * Confirm TOTP enrollment by proving a live code. Promotes the pending secret
   * to the active factor. Wrong / missing code → 401 MFA_CODE_INVALID.
   *
   * This is the WRITE the enrollment gate protects — `mfa/totp/enroll/start` only mints a pending
   * secret on the `UserMfa` row, so gating `start` alone would leave a `confirm` replayable against
   * state minted earlier. `dto.stepUp` carries the fresh proof.
   *
   * A read-only check of `dto.code` runs BEFORE the gate: the gate consumes the caller's single-use step-up
   * factor (an Email-OTP code or passkey assertion), and that factor rides in
   * the SAME request as `dto.code` — so without this pre-check, a wrong or
   * mistyped TOTP code still burned the proof, and every retry (even with the
   * right code) failed the same way because the resubmitted proof had
   * already been spent. `mfaSvc.enrollConfirm` below still performs the
   * authoritative check + mutation once the gate has passed.
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
    // Fail fast on a wrong/mistyped code — before the gate below spends the
    // caller's single-use step-up proof on a request that could never have
    // succeeded anyway (see the doc comment above).
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
    // Reset-window restriction: resolve whether
    // this write lands inside an open password-reset window and, if so,
    // stamp the confirmed factor restricted in the SAME write that promotes
    // it (`enrollConfirm` → `confirmTotpEnrollment`).
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
    // Factor-change notice + undo: only after a
    // `true` promotion, so the notice never fires on a rejected code. `notify`
    // never rejects (the promotion has already committed); `noticeSent` tells
    // the card whether the mail actually went out.
    const noticeSent = user
      ? await this.factorNotice.notify({ userId: me.userId, email: user.email, kind: 'totp_add' })
      : false;
    return { totpEnabled: true, noticeSent };
  }

  /**
   * Disable the TOTP factor. Step-up: the caller proves their current password
   * server-side via `VerifyPasswordService` AND, when `AUTH_MFA_ENFORCED` is on, passes a
   * fresh second-factor step-up (`enforceStepUpFactor` below); off that floor
   * the password alone suffices. Any eligible fresh factor satisfies that
   * step-up — including a live TOTP code (`method: 'totp'`, verified by
   * `StepUpService.verify` against the very factor being removed) — and
   * Email-OTP is the no-lockout fallback, so a caller who has already lost the
   * authenticator can still complete the removal. There is no
   * dedicated TOTP body field: the code rides the shared step-up proof
   * (`method` + `code`). Clears the TOTP secret. Idempotent when no factor is
   * enabled. Wrong password → 401 INVALID_CREDENTIALS.
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
    // Device identity: a trusted device's
    // password re-verify bypasses the per-address backoff here too.
    const cookies = parseCookies(req.headers.cookie ?? '');
    await this.verifyPasswordSvc.verify({
      userId: me.userId,
      currentPassword: dto.currentPassword,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      deviceId: me.deviceId,
      deviceTrustToken: cookies[DEVICE_TRUST_COOKIE_NAME],
    });
    // Fresh second-factor step-up layered on the
    // password gate when `AUTH_MFA_ENFORCED` is on. Email-OTP is the no-lockout
    // floor, so disabling TOTP stays completable even via an emailed code when
    // TOTP is the very factor being removed. Skipped on the flag-off floor.
    await this.enforceStepUpFactor(me.userId, 'mfa_totp_disable', dto, req);
    const disabled = await this.mfaSvc.disable(
      me.userId,
      req.ip ?? null,
      (req.headers['user-agent'] as string | undefined) ?? null,
    );
    // Factor-change notice + undo: only on an actual
    // change — a no-op disable (no factor enabled) has nothing to undo.
    // `notify` never rejects (the clear has already committed); `noticeSent`
    // tells the card whether the mail actually went out.
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
   * Current MFA factor status for the management UI (no secret material), plus
   * the step-up eligibility signal the destructive / factor-management cards read
   * before opening the reusable step-up modal:
   * `stepUpRequired` (= `AUTH_MFA_ENFORCED`) and the eligible `methods` /
   * `recoveryMethods` from the single shared factor computation. These flows have
   * no "request" phase (unlike change-email), so this idempotent read is where the
   * client learns whether step-up applies + which factors to offer.
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

  /** List the caller's trusted devices for the manage-devices UI. */
  @Get('mfa/trusted-devices')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async mfaTrustedDevices(@CurrentUser() me: AccessTokenClaims) {
    const devices = await this.trustedDeviceSvc.list(me.userId);
    // Never surface the at-rest tokenHash — only display-safe fields.
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

  /**
   * Forget trusted devices. An explicit `deviceIds` list forgets those; an
   * omitted list forgets every trusted device for the caller. Idempotent.
   */
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
    const revokeAll = async (ids: string[]) => {
      // Cap at 10 concurrent DynamoDB deletes to avoid hot-partition spikes.
      const BATCH = 10;
      for (let i = 0; i < ids.length; i += BATCH) {
        await Promise.all(
          ids
            .slice(i, i + BATCH)
            .map((id) => this.trustedDeviceSvc.revoke(me.userId, id, ip, userAgent)),
        );
      }
    };

    if (dto.deviceIds === undefined) {
      const all = await this.trustedDeviceSvc.list(me.userId);
      await revokeAll(all.map((d) => d.deviceId));
      // Forgetting all also drops the caller's own trust cookie.
      this.trustedDeviceSvc.clearCookie(res);
    } else {
      await revokeAll(dto.deviceIds);
    }
  }

  /**
   * Lift the TOTP factor's post-reset restriction.
   * The proof must come from a DIFFERENT, already-enrolled factor whose own
   * enrollment predates the reset request that opened the window — the
   * server resolves and checks this, never the client. When nothing predates
   * the reset, the escape hatch is disabling and re-enrolling the factor
   * (already step-up-gated), not this endpoint.
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

  /**
   * Enforce the fresh second-factor step-up for TOTP disable after its password gate.
   * No-op when `AUTH_MFA_ENFORCED` is off (the
   * password-only degrade floor). A missing factor is a 400 before any
   * side effect; a bad factor throws via `StepUpService.verify` (`MFA_CODE_INVALID`
   * or a passkey-specific code), which also emits the `step_up_*` audit. The
   * passkey factor rides in `dto.response`, mapped to the WebAuthn assertion.
   */
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
