/**
 * Route guard for `GET /auth/account-export`: ALWAYS requires a valid session-bound
 * export-authorization cookie. A bearer token alone is never sufficient to
 * download the full account export — the route requires a password
 * re-verification (`POST /auth/verify-password` with `purpose: 'data_export'`).
 * This guard re-checks `DataExportAuthorizationService` against the
 * authenticated `userId` / `householdId` / `jti` on every request.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { DataExportAuthorizationService } from './data-export-authorization.service.js';

@Injectable()
export class ExportAuthorizationGuard implements CanActivate {
  constructor(private readonly exportAuth: DataExportAuthorizationService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const claims = req.auth;
    // JwtAuthGuard (global, registered before this route guard) already
    // requires a verified bearer token — `claims` is always set in practice.
    // Fail closed regardless, rather than assume it.
    if (!claims) {
      throw new UnauthorizedException({
        code: 'EXPORT_AUTHORIZATION_REQUIRED',
        message: 'Re-verify your password to download your account export.',
      });
    }
    const ok = this.exportAuth.verifyFromRequest(req, {
      userId: claims.userId,
      householdId: claims.householdId,
      jti: claims.jti,
    });
    if (!ok) {
      throw new UnauthorizedException({
        code: 'EXPORT_AUTHORIZATION_REQUIRED',
        message: 'Re-verify your password to download your account export.',
      });
    }
    return true;
  }
}
