// localStorage-backed auth session helpers: device id, last-known email, idle marker, blocked-reset marker.
// Session guard flags, not user data; the local-data nuke clears them by clearing the store outright.
import { cryptoUuid } from '../lib/crypto-uuid';

const EMAIL_STORAGE_KEY = 'retivo.auth.email';
export const DEVICE_ID_STORAGE_KEY = 'retivo.auth.deviceId';
const ACTIVITY_STORAGE_KEY = 'retivo.auth.lastActivityAt';
// Cross-reload "blocked reset" marker, written before the revoke attempt when a cross-user IDB drop failed closed: a
// surviving refresh cookie would otherwise expose the new user's household over the previous user's stale IDB. A
// matching userId on the next boot forces the drop retry before claims are adopted. localStorage, not sessionStorage
// (must survive a reload) and not IDB (the thing that is blocked).
const BLOCKED_RESET_STORAGE_KEY = 'retivo:blocked-reset:pending';
// Prefix of the legacy per-user signup-profile keys; only the start-up sweep touches it.
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

/** Last-known email for password-manager association on pages with no session (ResetPasswordPage). */
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

export function readBlockedResetMarker(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(BLOCKED_RESET_STORAGE_KEY);
}

export function clearBlockedResetMarker(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(BLOCKED_RESET_STORAGE_KEY);
}

/**
 * Removes legacy `retivo:signup-profile:*` keys by prefix (values never read). Matches are collected first because
 * removing while iterating by index skips keys. Must not throw into boot: some private-browsing modes throw on storage
 * access.
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
