/**
 * Shared cookie configuration for refresh and CSRF tokens.
 *
 * Refresh cookie:
 * - Production: `__Secure-rt` — the `__Secure-` prefix forces browsers to
 *   reject the cookie unless the `Secure` flag is set, preventing silent
 *   config drift from dropping HTTPS.
 * - Development: `dev-rt` — `__Secure-` requires HTTPS, which HTTP localhost
 *   does not satisfy. The fallback name keeps dev working without a local cert.
 *
 * Device-trust cookie:
 * - Production: `__Secure-dt` / Development: `dev-dt` — same prefix posture as
 *   the refresh cookie. httpOnly + `SameSite=Strict`. ~30-day TTL. Scoped to
 *   `/api/v1` (widened from `/api/v1/auth`, mirroring
 *   the export-authorization cookie below) so it rides along on
 *   `POST /auth/login`, the other auth password-proof routes, AND
 *   `POST /sync/workspace/clear` — every consumer of the shared per-account
 *   backoff primitive that needs to resolve device trust.
 *
 * Export-authorization cookie:
 * - Production: `__Secure-xa` / Development: `dev-xa` — same prefix posture as
 *   the refresh cookie. httpOnly + `SameSite=Strict`, scoped to the broader
 *   `/api/v1` path (not `/api/v1/auth`). It is SET by
 *   `POST /auth/verify-password` and READ by `ExportAuthorizationGuard` at
 *   `GET /auth/account-export`. Short 5-minute TTL; carries a signed,
 *   session-bound token minted by `DataExportAuthorizationService`.
 */
import type { CookieOptions } from 'express';

const isProd = process.env.NODE_ENV === 'production';

export const REFRESH_COOKIE_NAME = isProd ? '__Secure-rt' : 'dev-rt';
export const CSRF_COOKIE_NAME = 'csrf-token';
export const DEVICE_TRUST_COOKIE_NAME = isProd ? '__Secure-dt' : 'dev-dt';
export const EXPORT_AUTHORIZATION_COOKIE_NAME = isProd ? '__Secure-xa' : 'dev-xa';

/** Device-trust window: 30 days (matches the TrustedDevice row TTL). */
export const DEVICE_TRUST_TTL_SEC = 30 * 24 * 60 * 60;

/** Export-authorization window: 5 minutes (matches the signed token TTL). */
export const EXPORT_AUTHORIZATION_TTL_SEC = 5 * 60;

export function refreshCookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: maxAgeMs,
  };
}

export function csrfCookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: false, // JS must be able to read this to echo it in X-CSRF-Token
    secure: isProd,
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function clearRefreshCookieOptions(): CookieOptions {
  return { ...refreshCookieOptions(0), maxAge: 0 };
}

export function clearCsrfCookieOptions(): CookieOptions {
  return { ...csrfCookieOptions(0), maxAge: 0 };
}

/**
 * Device-trust cookie options. httpOnly + `SameSite=Strict`, scoped to
 * `/api/v1` (widened from `/api/v1/auth` so the
 * cookie also reaches `POST /sync/workspace/clear`, the shared backoff
 * primitive's non-auth consumer).
 */
export function deviceTrustCookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/api/v1',
    maxAge: maxAgeMs,
  };
}

export function clearDeviceTrustCookieOptions(): CookieOptions {
  return { ...deviceTrustCookieOptions(0), maxAge: 0 };
}

/**
 * Clears a device-trust cookie set under the older path
 * (`/api/v1/auth`, before the cookie was widened to `/api/v1` above). A
 * browser that minted its cookie before this deploy still holds one scoped
 * to that narrower path — same name, different path, so it is a distinct
 * cookie the browser keeps sending alongside the live one until it is
 * explicitly expired at ITS OWN path (a `Set-Cookie` clear only matches a
 * cookie whose path is an exact prefix match, so `clearDeviceTrustCookieOptions()`
 * above cannot reach it). Emitted by `TrustedDeviceService` wherever the
 * widened cookie is written (mint, the trusted-login re-issue that migrates a
 * pre-widening device) and on "forget all devices"; not a live
 * security control on its own, since the underlying `TrustedDevice` row
 * governs trust.
 */
export function legacyDeviceTrustCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: 0,
  };
}

/**
 * Export-authorization cookie options.
 * httpOnly + `SameSite=Strict` + production-`Secure`, but scoped to `/api/v1`
 * (not `/api/v1/auth`). The cookie is set at `POST /auth/verify-password` and
 * read by `ExportAuthorizationGuard` at `GET /auth/account-export`.
 * The signed token itself is session-bound (userId + householdId + access-token
 * jti), so the broader path never widens who the authorization is valid for.
 */
export function exportAuthorizationCookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/api/v1',
    maxAge: maxAgeMs,
  };
}
