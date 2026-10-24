// Public auth types shared by AuthContext and its consumers; AuthContext.tsx re-exports them.

// Roles are gone in v1; `hasRole` is a stub that returns false, so admin-only UI stays hidden.
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
 * `GET /auth/me`: the account-registration record, corrected via `PATCH /auth/me`; `email` stays on its own verified
 * change flow. Fields are omitted for accounts that predate profile capture.
 */
export interface AccountRecord {
  email: string;
  firstName?: string;
  lastName?: string;
  birthdate?: string;
}

/** Body for `PATCH /auth/me`; all three fields are required (the correction form, not signup's partial capture). */
export interface UpdateAccountRecordRequest {
  firstName: string;
  lastName: string;
  birthdate: string;
}

/**
 * Result of `POST /auth/change-email/request`. When `stepUpRequired`, a fresh MFA factor must complete before the link
 * is mailed; dev/test builds may echo the raw token.
 */
export interface ChangeEmailRequestResult {
  stepUpRequired: boolean;
  methods?: string[];
  recoveryMethods?: string[];
  /** Returned in dev/test only so the developer can click the link. */
  changeEmailToken?: string;
}

/**
 * Result of `change-email/verify-step-up`; unlike {@link ChangeEmailRequestResult} it carries no `stepUpRequired` or
 * `methods`.
 */
export interface ChangeEmailStepUpResult {
  /** Present in dev/test only so the developer can click the link. */
  changeEmailToken?: string;
}

/** The sensitive operations a step-up can gate; mirrors the server's `STEP_UP_PURPOSES`. */
export type StepUpPurpose =
  | 'change_email'
  | 'delete_account'
  | 'encrypted_workspace_reset'
  | 'change_password'
  | 'mfa_totp_disable'
  | 'passkey_remove'
  | 'workspace_clear'
  // A key-envelope write that displaces existing key material (a PUT replacing any slot but an owed password re-wrap,
  // or a DELETE) demands a fresh step-up.
  | 'key_envelope_replace'
  | 'key_envelope_delete'
  // Factor-enrollment gate; also the purpose for the matching confirm-restriction lift.
  | 'passkey_enroll'
  | 'mfa_totp_enroll';

/** Enrolled passkey metadata from `listPasskeys` / `registerPasskey`. */
export interface PasskeyInfo {
  id: string;
  credentialId: string;
  deviceType: string;
  backedUp: boolean;
  transports: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  /**
   * True while restricted post-reset: needs a confirm-restriction lift (or removal) before it can sign in or approve
   * changes.
   */
  restrictedPostReset?: boolean;
}

/**
 * Outcome of {@link AuthContextValue.signOutForDeviceClear}. `proven` is true only when the server session is provably
 * gone as a result of that attempt (2xx from `/auth/logout`, or a definitive refresh-cookie rejection); an ambiguous
 * outcome reports `proven: false` with a `reason` and never tears down local state.
 */
export interface DeviceClearAttempt {
  proven: boolean;
  /** Present when `proven` is false: a short, safe-to-show description. */
  reason?: string;
}

/**
 * Thrown by {@link AuthContextValue.changePassword} when it was refused, or preparation failed, before `POST
 * /auth/change-password` was sent. Distinguishes "nothing was sent, safe to retry" from a lost response, so the UI
 * never tells the user to sign in with a password that was never set (burning a login-backoff attempt).
 */
export class PasswordChangeNotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordChangeNotSentError';
  }
}

/**
 * Thrown by {@link AuthContextValue.changePassword} when the server confirmed the commit (200) but this device could
 * not durably advance its envelope-set rollback pin. A known post-commit state, not an unknown outcome: the workspace
 * is locked on this device (fail closed), because a stale pin would accept a replay of the old envelope set and restore
 * the old password slot. Unlocking re-pins.
 */
export class PasswordChangeCommittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordChangeCommittedError';
  }
}
