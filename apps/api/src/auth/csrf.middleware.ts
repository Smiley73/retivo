// Double-submit-cookie CSRF middleware: state-changing requests need an `X-CSRF-Token` header equal to the `csrf-token` cookie. See
// docs/security.md, "Request-forgery protection".
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { CSRF_COOKIE_NAME } from './cookie-config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Match `req.originalUrl` minus the query, which always carries the `api/v1` prefix; `req.path` shape varies across
// NestJS and Express versions.
const EXEMPT_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/signup',
  '/api/v1/auth/refresh',
  '/api/v1/auth/resend-verification',
  // Exempt paths below run before any session, so no `csrf-token` cookie exists; token entropy, Origin/Referer and
  // the per-IP throttle carry the abuse story, and Origin/Referer is still enforced. verify-email is POST so the
  // token stays out of access logs.
  '/api/v1/auth/verify-email',
  // Owner-approval: clicked from a mail client with no session cookie.
  '/api/v1/auth/approve-signup',
  '/api/v1/auth/decline-signup',
  // Password reset: no cookie exists for the requester or the link-clicker.
  '/api/v1/auth/request-password-reset',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/passkey/authenticate/start',
  '/api/v1/auth/passkey/authenticate/finish',
  // MFA challenge endpoints are a pre-session handshake gated by the challenge token; CSRF stays enforced on the
  // management endpoints.
  '/api/v1/auth/mfa/email/send',
  '/api/v1/auth/mfa/verify',
  // MFA passkey-start is pre-session too, gated by a challenge token.
  '/api/v1/auth/mfa/passkey/start',
  // Change-email confirm is clicked from the new inbox, possibly another browser; the authenticated change-email
  // endpoints keep CSRF.
  '/api/v1/auth/change-email/confirm',
  // Factor-undo consume is clicked from the mail client, usually signed out everywhere; the `{ ok }` response is
  // opaque.
  '/api/v1/auth/factor-undo/consume',
]);

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) return next();
    // Login, signup, refresh and passkey-authenticate set the CSRF cookie, so they cannot require the header.
    const pathOnly = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
    if (EXEMPT_PATHS.has(pathOnly)) return next();

    const cookieHeader = req.headers.cookie ?? '';
    const cookieValue = cookieFromHeader(cookieHeader, CSRF_COOKIE_NAME);
    const headerValue = req.headers['x-csrf-token'];
    const headerString = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (
      !cookieValue ||
      !headerString ||
      cookieValue.length === 0 ||
      cookieValue !== headerString
    ) {
      res.status(403).json({
        error: {
          code: 'CSRF_TOKEN_MISMATCH',
          message:
            'Missing or invalid X-CSRF-Token header. Refresh your session.',
        },
      });
      return;
    }
    next();
  }
}

function cookieFromHeader(cookieHeader: string, name: string): string | null {
  for (const pair of cookieHeader.split(';')) {
    const [k, ...rest] = pair.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
