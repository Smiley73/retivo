/**
 * Public consume endpoint for the factor-change undo link. Reached from a mail client with no
 * session — usually signed out everywhere. `POST /auth/password-reset` consume is the shape
 * reference: `@Public()` + explicit `@Throttle`, CSRF-exempt (see `csrf.middleware.ts`).
 *
 * Response is opaque `{ ok }` regardless of the token's state (unknown user,
 * wrong/expired/superseded token) — never a 4xx that would reveal whether a
 * given `userId` exists or which state the token was in. See
 * `FactorNoticeService.consume`'s doc comment for the full contract.
 */
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from './public.decorator.js';
import { FactorUndoConsumeDto } from './dto/auth.dto.js';
import { FactorNoticeService, type FactorUndoConsumeResult } from './factor-notice.service.js';

@Controller('auth/factor-undo')
export class FactorUndoController {
  constructor(private readonly factorNotice: FactorNoticeService) {}

  @Public()
  @Post('consume')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async consume(@Body() dto: FactorUndoConsumeDto): Promise<FactorUndoConsumeResult> {
    return this.factorNotice.consume({ userId: dto.userId, token: dto.token, kind: dto.kind });
  }
}
