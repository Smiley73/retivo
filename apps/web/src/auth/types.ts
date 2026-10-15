/**
 * Public auth types shared by {@link AuthContext} and its consumers.
 *
 * Extracted from `AuthContext.tsx` so the
 * ~53 `useAuth()` consumer files can keep importing them unchanged —
 * `AuthContext.tsx` re-exports the previously-public names from here.
 */

// Roles are gone in v1, but legacy pages still check `hasRole(...)`. The
// stub returns false so admin-only UI is uniformly hidden.
export type Role = 'admin' | 'operator' | 'member' | 'viewer';

export interface Me {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
}

/** Transient pre-session MFA challenge state, surfaced to the LoginPage. */
export interface MfaChallengeState {
  challengeToken: string;
  /** Routine second factors the user may complete (e.g. `['totp']`). */
  methods: string[];
  /** Recovery/fallback factors (currently `['email_otp']`). */
  recoveryMethods: string[];
}

/** Result of completing the MFA challenge — whether the device was remembered. */
export interface VerifyMfaResult {
  /** True when a routine factor pass minted ~30-day device trust. */
  deviceRemembered: boolean;
}

/**
 * The account-registration record served by `GET /auth/me`
 * Editable on the Security page account
 * card — `PATCH /auth/me` corrects
 * `firstName` / `lastName` / `birthdate`; `email` stays on its own verified
 * change flow. The two unset fields are omitted for accounts that predate
 * profile capture at signup, until a correction fills them in.
 */
export interface AccountRecord {
  email: string;
  firstName?: string;
  lastName?: string;
  birthdate?: string;
}

/**
 * Body for `PATCH /auth/me`. All three
 * fields are required — this is the correction form, not signup's partial
 * capture.
 */
export interface UpdateAccountRecordRequest {
  firstName: string;
  lastName: string;
  birthdate: string;
}

/**
 * Result of starting an email change (`POST /auth/change-email/request`). When
 * `stepUpRequired` the SPA must complete a fresh MFA factor before the
 * verification link is mailed; the `methods` / `recoveryMethods` mirror the
 * login MFA factor sets. When not required (password-only path / MFA off) the
 * link is already on its way; dev/test builds may echo the raw token.
 */
export interface ChangeEmailRequestResult {
  stepUpRequired: boolean;
  methods?: string[];
  recoveryMethods?: string[];
  /** Returned in dev/test only so the developer can click the link. */
  changeEmailToken?: string;
}

/**
 * Shape returned by the `change-email/verify-step-up` endpoint.
 * Distinct from {@link ChangeEmailRequestResult} — the step-up endpoint
 * does not return `stepUpRequired` / `methods`.
 */
export interface ChangeEmailStepUpResult {
  /** Present in dev/test only so the developer can click the link. */
  changeEmailToken?: string;
}

/**
 * The sensitive operations a step-up can gate. Mirrors
 * the server's `STEP_UP_PURPOSES`. Used to scope the generic prep endpoints.
 */
export type StepUpPurpose =
  | 'change_email'
  | 'delete_account'
  | 'encrypted_workspace_reset'
  | 'change_password'
  | 'mfa_totp_disable'
  | 'passkey_remove'
  | 'workspace_clear'
  // A key-envelope write that displaces existing
  // key material (a PUT replacing any slot other than an owed password
  // re-wrap, or a DELETE) demands a fresh step-up proof.
  | 'key_envelope_replace'
  | 'key_envelope_delete'
  // Factor-enrollment gate — also reused,
  // unchanged, as the purpose for the matching confirm-restriction lift.
  | 'passkey_enroll'
  | 'mfa_totp_enroll';

/**
 * Metadata for an enrolled passkey, as returned by `listPasskeys` /
 * `registerPasskey`.
 */
export interface PasskeyInfo {
  id: string;
  credentialId: string;
  deviceType: string;
  backedUp: boolean;
  transports: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** True while this passkey is restricted post-reset — needs a confirm-restriction lift (or removal) before it can sign
   * in or approve changes. */
  restrictedPostReset?: boolean;
}

/**
 * Outcome of {@link AuthContextValue.signOutForDeviceClear} — "Clear data on
 * this device". `proven` is `true` only
 * when the server session is provably gone as a result of THAT attempt
 * (a 2xx from `/auth/logout`, or a definitive refresh-cookie rejection while
 * the attempt was running); an ambiguous outcome (network failure, timeout,
 * 5xx, throttle, or a transiently-failed/cooldown-short-circuited refresh)
 * reports `proven: false` with a `reason` for the caller to show, and never
 * tears down local state.
 */
export interface DeviceClearAttempt {
  proven: boolean;
  /** Present when `proven` is false — a short, safe-to-show description of
   * what went wrong. */
  reason?: string;
}

/**
 * Thrown by {@link AuthContextValue.changePassword} when the change was
 * refused, or preparation failed, BEFORE the `POST /auth/change-password`
 * request was ever sent: the locked-
 * workspace / needs-key-setup guards, or `prepareRewrappedPasswordSlot`
 * throwing on a stale session, a failed envelope fetch, or a tampered/rolled-
 * back slot set. Distinguishes "nothing was sent — definitely unchanged, safe
 * to retry from this form" from a genuinely lost response after the request
 * left the client, so the UI never tells the user to sign in with a new
 * password that was never set server-side (which would burn an attempt
 * against the shared per-account login backoff on the wrong password).
 */
export class PasswordChangeNotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordChangeNotSentError';
  }
}

/**
 * Thrown by {@link AuthContextValue.changePassword} when the server CONFIRMED
 * the commit (a 200 — the password and the key slot both changed) but this
 * device could not durably advance its envelope-set rollback pin afterwards.
 * This is a known post-commit state, never an
 * unknown server outcome: the UI must not show the "may or may not have gone
 * through, sign in again" wording, and the workspace has been locked on this
 * device (fail closed) — a pin still trusting the predecessor version would
 * otherwise accept a replay of the old envelope set, silently restoring the
 * old password slot. Unlocking re-verifies and re-pins the served set.
 */
export class PasswordChangeCommittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordChangeCommittedError';
  }
}
