/**
 * localStorage-backed auth session helpers (device id, last-known email, idle
 * marker, blocked-reset marker, signup-profile handoff).
 *
 * Extracted from `AuthContext.tsx`.
 * Pure module helpers — no React. Every key here is a session guard flag or a
 * write-once handoff, NOT persisted user data; the wholesale local-data nuke
 * (`clearStoragePreserving(localStorage, …)` in `lib/local-data.ts`) clears them
 * all by clearing the store outright.
 */
import { cryptoUuid } from '../lib/crypto-uuid';
import { decodeJwt } from './token-utils';
import type { LoginResponse, SignupProfile } from './types';

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
// Per-user signup-profile handoff. After a successful login + cross-user
// IDB reset, the name + birthdate captured at signup are written here keyed by
// userId. App.tsx's first-run effect reads it to seed the primary
// HouseholdMember, then removes it (write-once-use-once). Holds birthdate
// (PII) so it is cleared by the wholesale local-data nuke (localStorage.clear).
const SIGNUP_PROFILE_KEY_PREFIX = 'retivo:signup-profile:';

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
 * Persist the signup profile for the first-run HouseholdMember seeding.
 * Writes `{ firstName, lastName, birthdate }` to localStorage keyed by the
 * userId parsed from the just-issued access token (NOT `me.id`, which is not
 * yet settled in the login callback closure). No-op unless all three fields
 * are present and the token decodes — old accounts simply fall through to the
 * existing first-run demo modal.
 */
export function persistSignupProfile(res: LoginResponse): void {
  if (typeof localStorage === 'undefined') return;
  const { firstName, lastName, birthdate } = res;
  if (!firstName || !lastName || !birthdate) return;
  const userId = decodeJwt(res.accessToken)?.userId;
  if (!userId) return;
  localStorage.setItem(
    `${SIGNUP_PROFILE_KEY_PREFIX}${userId}`,
    JSON.stringify({ firstName, lastName, birthdate }),
  );
}

/**
 * Parse the per-user signup profile, or null when absent / malformed. Read once
 * by App.tsx's first-run seeding effect (single source of truth for the
 * `SIGNUP_PROFILE_KEY_PREFIX` handoff).
 */
export function readSignupProfile(userId: string): SignupProfile | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(`${SIGNUP_PROFILE_KEY_PREFIX}${userId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SignupProfile>;
    if (
      typeof parsed.firstName === 'string' &&
      typeof parsed.lastName === 'string' &&
      typeof parsed.birthdate === 'string'
    ) {
      return { firstName: parsed.firstName, lastName: parsed.lastName, birthdate: parsed.birthdate };
    }
    return null;
  } catch {
    return null;
  }
}

/** Remove the one-shot signup profile after a successful seed (write-once-use-once). */
export function clearSignupProfile(userId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(`${SIGNUP_PROFILE_KEY_PREFIX}${userId}`);
}

/**
 * Rewrite the per-user signup-profile handoff with freshly corrected values.
 * This module is the single source of
 * truth for the `SIGNUP_PROFILE_KEY_PREFIX` handoff; the Account card
 * calls this after a successful `PATCH /auth/me` save so a first-run seed
 * that hasn't run yet picks up the correction instead of stale signup-time
 * values. **Update-if-present only** — when no handoff exists for this user
 * (already consumed by the first-run seed, or the account predates signup
 * capture) this writes nothing. Clearing the key instead was rejected: it
 * would drop a brand-new account back to the first-run demo modal and
 * silently lose the seeding feature for exactly the person most likely to be
 * fixing a typo the same day they signed up.
 */
export function updateSignupProfile(userId: string, profile: SignupProfile): void {
  if (typeof localStorage === 'undefined') return;
  const key = `${SIGNUP_PROFILE_KEY_PREFIX}${userId}`;
  if (localStorage.getItem(key) === null) return;
  localStorage.setItem(key, JSON.stringify(profile));
}
