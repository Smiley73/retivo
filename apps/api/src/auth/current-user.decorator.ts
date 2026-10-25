// Parameter decorator extracting the authenticated claims set by JwtAuthGuard; guarded routes only.
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessTokenClaims } from './jwt.service.js';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenClaims => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.auth) {
      throw new Error('CurrentUser used on a route without JwtAuthGuard');
    }
    return req.auth;
  },
);
