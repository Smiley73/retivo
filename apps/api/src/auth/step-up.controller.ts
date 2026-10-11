/**
 * Generic session-authed step-up prep endpoints.
 * The client calls one of these before verifying a server-issued factor:
 *   - `POST /auth/step-up/email-otp/send` — email a purpose-bound step-up code.
 *   - `POST /auth/step-up/passkey/options` — issue purpose-scoped WebAuthn options.
 *
 * A dedicated controller so the already-large `auth.controller.ts` doesn't grow
 * further. Both are session-authed (JwtAuthGuard) and therefore keep CSRF +
 * Origin enforcement — they are NOT added to `csrf.middleware.ts` `EXEMPT_PATHS`:
 * unlike the pre-session login-MFA prep endpoints, a step-up caller
 * always has a live session (and thus a `csrf-token` cookie). Each carries an
 * explicit `@Throttle`. Both emit `step_up_challenge` with the op `purpose`
 * + factor `method` when a challenge is actually minted — the Email-OTP send only
 * records it when a code row was committed (a cooldown / cap no-op mints nothing,
 * so no event is written); codes / challenges are never logged.
 *
 * See docs/security.md, "Step-up for sensitive actions".
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import type { AccessTokenClaims } from './jwt.service.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { MfaEmailOtpService } from './mfa-email-otp.service.js';
import { PasskeyAssertionService } from './passkey-assertion.service.js';
import { StepUpEmailOtpSendDto, StepUpPasskeyOptionsDto } from './dto/step-up.dto.js';

@Controller('auth/step-up')
export class StepUpController {
  constructor(
    private readonly users: UsersRepository,
    private readonly auth: AuthEventsRepository,
    private readonly mfaEmailOtpSvc: MfaEmailOtpService,
    private readonly passkeyAssertions: PasskeyAssertionService,
  ) {}

  /**
   * Email a fresh step-up code bound to the op `purpose`. Opaque + rate-
   * limited (its own budget) — always 202 with no body regardless of the
   * cooldown / cap state. Sent to the caller's current email.
   */
  @Post('email-otp/send')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  @HttpCode(HttpStatus.ACCEPTED)
  async emailOtpSend(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: StepUpEmailOtpSendDto,
    @Req() req: Request,
  ): Promise<void> {
    const ip = req.ip ?? null;
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;
    const user = await this.users.findById(me.userId);
    let committed = false;
    if (user) {
      ({ committed } = await this.mfaEmailOtpSvc.sendStepUp({
        userId: me.userId,
        email: user.email,
        purpose: dto.purpose,
        ip,
        userAgent,
      }));
    }
    // Only record a step-up challenge when a code was actually minted — a
    // cooldown / daily-cap / lost-race no-op mints nothing, so the audit log
    // must not claim an Email-OTP challenge was issued (the 202 stays opaque).
    if (committed) {
      await this.auth.record({
        userId: me.userId,
        eventType: 'step_up_challenge',
        ip,
        userAgent,
        metadata: { purpose: dto.purpose, method: 'email_otp' },
      });
    }
  }

  /**
   * Issue purpose-scoped WebAuthn step-up options. `allowCredentials` is
   * scoped to the session user; the challenge lives in the
   * `stepup:<userId>:<purpose>` namespace so it can only authorize that op.
   */
  @Post('passkey/options')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  async passkeyOptions(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: StepUpPasskeyOptionsDto,
    @Req() req: Request,
  ) {
    const options = await this.passkeyAssertions.generateStepUpOptions(
      me.userId,
      dto.purpose,
    );
    await this.auth.record({
      userId: me.userId,
      eventType: 'step_up_challenge',
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      metadata: { purpose: dto.purpose, method: 'passkey' },
    });
    return options;
  }
}
