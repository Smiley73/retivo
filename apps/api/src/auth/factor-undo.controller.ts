// Public consume endpoint for the factor-change undo link, reached from a mail client with no session; `@Public()`, explicit `@Throttle`,
// CSRF-exempt. The response is opaque `{ ok }` whatever the token state (see `FactorNoticeService.consume`).
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
