/**
 * HTTP layer for the account half of "Export my data".
 *
 *   GET /api/v1/auth/account-export?cursor=<opaque> — one page of the export
 *
 * Mounted under the existing `auth` concern, mirroring the key-envelope
 * controller. The route needs a bearer token AND a valid
 * export-authorization cookie (`POST /auth/verify-password` with
 * `purpose: 'data_export'`). Throttled
 * like the sync read routes: the export cookie is a 5-minute window, and the
 * history section pages in a small, bounded number of round trips within it.
 */
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
  // `ExportAuthorizationGuard` re-verifies the export cookie for EVERY caller,
  // so a bearer token alone is never sufficient.
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
      // A concurrent account deletion removed the User row mid-request
      // (deletion sweeps the other stores non-atomically after it, so
      // continuing would return a partial bundle presented as complete).
      // Fail closed with a `409` rather than fabricating an empty account
      // record — never a `200` with a silently-incomplete export.
      if (err instanceof AccountExportUserGoneError) {
        throw new ConflictException({
          code: 'ACCOUNT_EXPORT_CONFLICT',
          message: err.message,
        });
      }
      // The bracketed, strongly-consistent User read around the email-keyed
      // sections (emailReservations, failedLoginAttempt) could not settle
      // within the bounded retry — mirrors the envelope-set conflict mapping
      // just below rather than risk keying those sections off a recycled
      // `emailLowercase`.
      if (err instanceof AccountExportEmailKeyReadConflictError) {
        throw new ServiceUnavailableException({
          code: 'ACCOUNT_EXPORT_EMAIL_KEY_CONFLICT',
          message: err.message,
        });
      }
      // The key-envelope slots/meta are now read via the bracketed,
      // strongly-consistent `getStableEnvelopeSet`, which fails
      // closed with this error rather than risking a torn slots/meta pair —
      // mirrors `key-envelope.controller.ts`'s own mapping of the same error.
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
