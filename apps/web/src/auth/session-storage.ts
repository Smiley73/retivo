/**
 * localStorage-backed auth session helpers (device id, last-known email, idle
 * marker, blocked-reset marker).
 *
 * Extracted from `AuthContext.tsx`.
 * Pure module helpers — no React. Every key here is a session guard flag, NOT
 * persisted user data; the wholesale local-data nuke
 * (`clearStoragePreserving(localStorage, …)` in `lib/local-data.ts`) clears them
 * all by clearing the store outright.
 */
import { cryptoUuid } from '../lib/crypto-uuid';

const EMAIL_STORAGE_KEY = 'retivo.auth.email';
export const DEVICE_ID_STORAGE_KEY = 'retivo.auth.deviceId';
const ACTIVITY_STORAGE_KEY = 'retivo.auth.lastActivityAt';
// Cross-reload "blocked reset" marker. When a cross-user IDB drop fails
// closed AND the best-effort revoke of the new user's session also fails, the
// new user's refresh cookie may survive the reload — refresh would then mint the
// new user's token and expose their household over the previous user's stale
// IDB. We persist the new user's userId here BEFORE attempting the revoke (so it
// survives even if the revoke throws). On the next boot refresh, a matching
// userId forces a retry of the IDB drop before the claims are ever adopted: the
// drop must succeed (or the blocking modal is shown) before `updateFromToken`
// runs. localStorage (not sessionStorage) so it survives a full page reload; not
// IDB because IDB is exactly what is blocked. This is a session guard flag, not
// persisted user data — the wholesale local-data nuke clears it by name prefix.
const BLOCKED_RESET_STORAGE_KEY = 'retivo:blocked-reset:pending';
// Key prefix of the retired per-user signup-profile handoff. Only the start-up
// sweep refers to it; nothing writes or reads these keys any more.
const LEGACY_PROFILE_HANDOFF_PREFIX = 'retivo:signup-profile:';

export function readOrInitDeviceId(): string {
  if (typeof localStorage === 'undefined') return cryptoUuid();
  let id = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (!id) {
    id = cryptoUuid();
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
  }
  return id;
}

export function readStoredEmail(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(EMAIL_STORAGE_KEY) ?? '';
}

/** Best-effort last-known account email, for password-manager username
 *  association on pages with no session (ResetPasswordPage). */
export function readStoredAuthEmail(): string {
  return readStoredEmail();
}

export function storeEmail(email: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(EMAIL_STORAGE_KEY, email);
}

export function clearStoredEmail(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(EMAIL_STORAGE_KEY);
}

export function shouldSkipBootRefreshForIdle(idleMs: number): boolean {
  if (typeof localStorage === 'undefined') return false;
  const raw = localStorage.getItem(ACTIVITY_STORAGE_KEY);
  if (!raw) return false;
  const last = Number.parseInt(raw, 10);
  if (!Number.isFinite(last)) return false;
  return Date.now() - last > idleMs;
}

export function clearActivityTimestamp(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(ACTIVITY_STORAGE_KEY);
}

/** Persist the blocked-reset marker (the userId whose IDB drop is pending). */
export function writeBlockedResetMarker(userId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(BLOCKED_RESET_STORAGE_KEY, userId);
}

/** Read the pending blocked-reset userId, or null when none is set. */
export function readBlockedResetMarker(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(BLOCKED_RESET_STORAGE_KEY);
}

/** Clear the blocked-reset marker after a successful IDB drop. */
export function clearBlockedResetMarker(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(BLOCKED_RESET_STORAGE_KEY);
}

/**
 * Remove `retivo:signup-profile:<userId>` keys left behind by earlier builds,
 * which kept the signup name and birthdate in localStorage. Remove-only: keys
 * are matched by prefix and their values are never read. Matches are collected
 * before removal because removing while iterating by index skips keys. Must
 * not throw into boot (some private-browsing modes throw on storage access).
 */
export function sweepLegacySignupProfileKeys(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(LEGACY_PROFILE_HANDOFF_PREFIX)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    // Storage unavailable — nothing to sweep.
  }
}
