// Route guard for `GET /auth/account-export`: always requires the session-bound export-authorization cookie, so a bearer token alone never
// downloads the export.
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
    // Fail closed even though JwtAuthGuard already requires a bearer, so `claims` is set in practice.
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
