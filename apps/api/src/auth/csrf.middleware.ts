/**
 * Double-submit-cookie CSRF middleware. Every state-changing request
 * (POST/PUT/PATCH/DELETE) must carry an `X-CSRF-Token` header equal to
 * the `csrf-token` cookie. Reads (GET/HEAD/OPTIONS) bypass.
 *
 * Login sets the cookie; refresh rotates it. Mismatch → 403.
 *
 * See docs/security.md, "Request-forgery protection".
 */
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { CSRF_COOKIE_NAME } from './cookie-config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Match against `req.originalUrl` minus query — that always carries the
// full URL including the `api/v1` global prefix. `req.path` shape changed
// between NestJS / Express versions (sometimes prefix-stripped under
// `forRoutes('*')`), so we anchor to a stable source.
const EXEMPT_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/signup',
  '/api/v1/auth/refresh',
  '/api/v1/auth/resend-verification',
  // verify-email runs before any login → no csrf-token cookie exists
  // yet for the unverified user. Token entropy + Origin/Referer + the
  // per-IP throttle carry the abuse story (the
  // POST migration moved the token out of access logs / Referer; CSRF
  // posture is unchanged from the prior GET).
  '/api/v1/auth/verify-email',
  // Owner-approval gate: the owner clicks a link from a mail client
  // with no session cookie established. Token entropy + Origin/Referer +
  // per-IP throttle carry the abuse story, mirroring the verify-email
  // posture above.
  '/api/v1/auth/approve-signup',
  '/api/v1/auth/decline-signup',
  // Password reset runs before any login → no csrf-token cookie exists
  // for the requester (request) or the link-clicker (reset). Token
  // entropy + Origin/Referer + the per-IP throttle carry the abuse story,
  // mirroring the verify-email / approve-signup posture above.
  '/api/v1/auth/request-password-reset',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/passkey/authenticate/start',
  '/api/v1/auth/passkey/authenticate/finish',
  // MFA challenge endpoints run before any session exists (pre-session handshake
  // like login/refresh). No CSRF cookie exists yet — challenge-token entropy +
  // Origin/Referer + per-IP throttle carry the abuse story. CSRF is enforced on all management endpoints (enroll/
  // disable/trusted-devices) which run after login.
  '/api/v1/auth/mfa/email/send',
  '/api/v1/auth/mfa/verify',
  // The MFA passkey-start endpoint (passkey as a second factor) is pre-session
  // too — gated by a valid challenge token, not a csrf-token cookie. Mirrors
  // passkey/authenticate/start's public + CSRF-exempt posture; Origin/Referer
  // is still enforced.
  '/api/v1/auth/mfa/passkey/start',
  // Change-email confirm is clicked from the new inbox, possibly in another
  // browser with no csrf-token cookie — public + token-authenticated, mirroring
  // verify-email. The change-email token entropy + Origin/Referer + the per-IP
  // throttle carry the abuse story. The authenticated request/send-otp/
  // verify-step-up endpoints keep CSRF+Origin (they run with a session).
  '/api/v1/auth/change-email/confirm',
  // Factor-undo consume is clicked from the mail client, usually signed out
  // everywhere — no csrf-token cookie exists.
  // Mirrors reset-password / change-email/confirm: token entropy +
  // Origin/Referer + the per-IP throttle carry the abuse story, and the
  // opaque `{ ok }` response reveals nothing about the token's validity.
  '/api/v1/auth/factor-undo/consume',
]);

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) return next();
    // Login + signup + refresh + passkey-authenticate set the CSRF cookie;
    // they cannot themselves require the header (chicken/egg).
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
