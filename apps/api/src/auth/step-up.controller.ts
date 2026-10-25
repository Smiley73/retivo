// Session-authed step-up prep endpoints (`email-otp/send`, `passkey/options`); a live session means CSRF and Origin stay enforced.
// `step_up_challenge` is recorded only when minted. See docs/security.md, "Step-up for sensitive actions".
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
   * Emails a fresh step-up code bound to `purpose`, to the caller current email. Always 202 with no body, whatever
   * the cooldown or cap state.
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
    // Record the challenge only when a code was minted: a no-op mints nothing, and the audit log must not claim
    // otherwise (the 202 stays opaque).
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
   * Issues purpose-scoped WebAuthn step-up options for the session user, under the `stepup:<userId>:<purpose>`
   * namespace so it can only authorize that operation.
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
