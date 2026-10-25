// Authenticated route guard: verifies the access-token JWT, checks the RevokedToken denylist and attaches claims for `@CurrentUser()`.
// `@Public()` routes skip it; there are no roles in v1.
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { AccessTokenService, AccessTokenClaims } from './jwt.service.js';
import { RevokedTokensRepository } from '../dynamo/revoked-tokens.repository.js';

declare module 'express' {
  interface Request {
    auth?: AccessTokenClaims;
  }
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
    private readonly revoked: RevokedTokensRepository,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Missing or malformed Authorization header.',
      });
    }

    let claims: AccessTokenClaims;
    try {
      claims = this.tokens.verify(match[1]);
    } catch {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Access token is invalid or expired.',
      });
    }

    // Reject a non-session token presented as a bearer: the MFA challenge token (same keys) carries a `purpose`
    // claim, and a normal access token has none.
    if (claims.purpose !== undefined) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Challenge token cannot be used as a session bearer.',
      });
    }

    // Cutover: a token minted before `sessionGeneration` existed is rejected like a tombstoned generation, never
    // trusted as generation 0.
    if (claims.sessionGeneration === undefined) {
      throw new UnauthorizedException({
        code: 'ACCESS_TOKEN_REVOKED',
        message: 'Access token has been revoked.',
      });
    }

    // Both point reads are issued concurrently, never one awaited before the other starts: a sequential version
    // passes every behavioural test while doubling this hot path latency.
    const [jtiRevoked, generationRevoked] = await Promise.all([
      this.revoked.isRevoked(claims.jti),
      this.revoked.isGenerationRevoked(claims.userId, claims.sessionGeneration),
    ]);
    if (jtiRevoked || generationRevoked) {
      throw new UnauthorizedException({
        code: 'ACCESS_TOKEN_REVOKED',
        message: 'Access token has been revoked.',
      });
    }

    req.auth = claims;
    return true;
  }
}
