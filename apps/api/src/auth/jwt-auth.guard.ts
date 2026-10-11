/**
 * Authenticated route guard. Verifies the access-token JWT (signature,
 * kid lookup, expiry), checks the RevokedToken denylist, and attaches
 * the resolved claims to the request object for `@CurrentUser()`.
 *
 * Routes marked `@Public()` skip both checks. There is **no** role
 * check — v1 has no roles.
 *
 * The household-claim equality check (JWT householdId === body
 * householdId) is enforced separately by `HouseholdClaimGuard` on
 * sync routes; the JWT guard is concerned with identity only.
 */
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

    // Reject a non-session token presented as a bearer. The MFA challenge token is signed by the
    // same key store but carries `purpose: 'mfa_challenge'`; a normal access token has NO
    // `purpose`. Any verified token that carries one is not a session bearer.
    if (claims.purpose !== undefined) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Challenge token cannot be used as a session bearer.',
      });
    }

    // Cutover: a token minted before
    // this shipped carries no `sessionGeneration` claim at all. Rejected
    // with the SAME outcome as a tombstoned generation — never trusted as an
    // implicit "generation 0" — so no legacy no-generation session survives
    // the deploy.
    if (claims.sessionGeneration === undefined) {
      throw new UnauthorizedException({
        code: 'ACCESS_TOKEN_REVOKED',
        message: 'Access token has been revoked.',
      });
    }

    // Both point reads against the SAME table, issued CONCURRENTLY — never
    // one `await`ed before the other starts. A sequential implementation
    // would pass every behavioural test here while doubling this hot path's
    // added latency.
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
