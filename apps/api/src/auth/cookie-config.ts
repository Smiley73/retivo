// Cookie configuration for the refresh, CSRF, device-trust and export-authorization cookies: `__Secure-` prefixed in production (forcing
// Secure), `dev-` names locally. All httpOnly and SameSite=Strict except CSRF.
import type { CookieOptions } from 'express';

const isProd = process.env.NODE_ENV === 'production';

export const REFRESH_COOKIE_NAME = isProd ? '__Secure-rt' : 'dev-rt';
export const CSRF_COOKIE_NAME = 'csrf-token';
export const DEVICE_TRUST_COOKIE_NAME = isProd ? '__Secure-dt' : 'dev-dt';
export const EXPORT_AUTHORIZATION_COOKIE_NAME = isProd ? '__Secure-xa' : 'dev-xa';

export const DEVICE_TRUST_TTL_SEC = 30 * 24 * 60 * 60;

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
 * Device-trust cookie options: httpOnly, SameSite=Strict, scoped to `/api/v1` so it also reaches `POST
 * /sync/workspace/clear`, the backoff primitive non-auth consumer.
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
 * Expires a device-trust cookie set under the older `/api/v1/auth` path. A browser that minted one before the
 * widening keeps sending it alongside the live one, and a clear only matches its exact path. Not a security control
 * on its own: the TrustedDevice row governs trust.
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
 * Export-authorization cookie options: httpOnly, SameSite=Strict, production Secure, scoped to `/api/v1`. The signed
 * token is session-bound (userId, householdId, access-token jti), so the broader path never widens who it is valid
 * for.
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
