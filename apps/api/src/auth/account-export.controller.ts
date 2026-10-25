// HTTP layer for the account half of "Export my data" (`GET /auth/account-export?cursor=`). Needs a bearer token and the export-authorization
// cookie from `POST /auth/verify-password` with `purpose: data_export`; throttled like the sync reads.
import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { ExportAuthorizationGuard } from './export-authorization.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import type { AccessTokenClaims } from './jwt.service.js';
import {
  AccountExportEmailKeyReadConflictError,
  AccountExportService,
  AccountExportUserGoneError,
  type AccountExportFirstPage,
  type AccountExportNextPage,
} from './account-export.service.js';
import { InvalidAccountExportCursorError } from '../dynamo/auth-events.repository.js';
import { EnvelopeReadConflictError } from '../dynamo/household-key-envelopes.repository.js';

@Controller('auth')
export class AccountExportController {
  constructor(private readonly accountExport: AccountExportService) {}

  @Get('account-export')
  @UseGuards(JwtAuthGuard, ExportAuthorizationGuard)
  // `ExportAuthorizationGuard` re-verifies the cookie for every caller, so a bearer token alone is never enough.
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  async export(
    @CurrentUser() me: AccessTokenClaims,
    @Query('cursor') cursor?: string,
  ): Promise<AccountExportFirstPage | AccountExportNextPage> {
    try {
      return await this.accountExport.build(me.userId, me.householdId, cursor ?? null);
    } catch (err) {
      if (err instanceof InvalidAccountExportCursorError) {
        throw new BadRequestException({
          code: 'INVALID_EXPORT_CURSOR',
          message: err.message,
        });
      }
      // A concurrent account deletion removed the User row mid-request and the other stores are swept non-atomically
      // after it, so continuing would present a partial bundle as complete. Fail closed with 409.
      if (err instanceof AccountExportUserGoneError) {
        throw new ConflictException({
          code: 'ACCOUNT_EXPORT_CONFLICT',
          message: err.message,
        });
      }
      // The bracketed User read could not settle within the bounded retry; refuse rather than key the email sections
      // off a recycled `emailLowercase`.
      if (err instanceof AccountExportEmailKeyReadConflictError) {
        throw new ServiceUnavailableException({
          code: 'ACCOUNT_EXPORT_EMAIL_KEY_CONFLICT',
          message: err.message,
        });
      }
      // The bracketed key-envelope read fails closed rather than return a torn slots and meta pair, as in
      // `key-envelope.controller.ts`.
      if (err instanceof EnvelopeReadConflictError) {
        throw new ServiceUnavailableException({
          code: 'ENVELOPE_READ_CONFLICT',
          message: 'Could not read the envelope set right now. Try again.',
        });
      }
      throw err;
    }
  }
}
