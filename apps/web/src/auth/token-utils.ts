/**
 * Pure JWT claim decoding for the auth layer (no storage, no React).
 *
 * Extracted from `AuthContext.tsx`. The
 * decoder only reads the token payload's claim fields; it never verifies the
 * signature — the API is the trust boundary. `atob` + base64url normalization
 * keeps it dependency-free.
 */

export interface JwtClaims {
  userId: string;
  householdId: string;
  deviceId: string;
  email?: string;
  /** Unix seconds (`exp` claim), when present, so callers can check
   *  remaining token life without a second decode. */
  exp?: number;
}

export function decodeJwt(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    if (typeof payload.userId !== 'string' || typeof payload.householdId !== 'string') return null;
    return {
      userId: payload.userId,
      householdId: payload.householdId,
      deviceId: typeof payload.deviceId === 'string' ? payload.deviceId : '',
      email: typeof payload.email === 'string' ? payload.email : undefined,
      exp: typeof payload.exp === 'number' ? payload.exp : undefined,
    };
  } catch {
    return null;
  }
}
