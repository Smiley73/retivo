/**
 * Client-side auth state for the auth flows: signup → email verify
 * → login → refresh → logout, plus full WebAuthn passkey enroll/assert
 * and password change.
 *
 * Token storage:
 *   - access token: in-memory (useRef). Lost on reload.
 *   - refresh token: HTTP-only cookie set by the API.
 *   - on reload: bootstrapper calls /auth/refresh; if the cookie is
 *     missing/expired we end up unauthenticated.
 *
 * The user's display profile (name, email, household) lives in
 * IndexedDB after bootstrap; the auth context only carries the JWT
 * claims and the email captured at signup/login. Domain pages should
 * read from the IndexedDB stores via the db helpers.
 *
 * SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):
 * this file is over the 800-line limit. Why it cannot be split: it is the
 * security-boundary auth orchestrator — token lifecycle (in-memory access
 * + cookie refresh dedupe), the cross-user IndexedDB reset guard with its
 * fail-closed blocking-modal + boot-refresh retry, idle-timeout wiring,
 * password/passkey login, MFA challenge state machine (verifyMfa /
 * verifyMfaWithPasskey / sendEmailOtp / clearMfaChallenge / useMfaManagement
 * surface — the passkey-second-factor path is tightly coupled to the same
 * `mfaChallenge` / `mfaPasswordRef` / `resetThenCompleteLogin` machinery as
 * `verifyMfa`, so it lives beside it rather than in a hook that would
 * re-take the same 6+ injected deps), and the zero-knowledge unlock +
 * post-reset re-wrap threading. The cohesive sub-systems that COULD move
 * already have (useZeroKnowledgeKey, useDerivedRewrap, usePasswordResetClient,
 * user-transition, plus the public types in `./types`, the localStorage
 * session helpers in `./session-storage` and `decodeJwt` in `./token-utils`).
 * What remains — the blocked-reset guard (`guardBlockedReset` /
 * `resetThenCompleteLogin` / `completeLoginAfterReset` + the localStorage
 * marker helpers) — is tightly coupled to the in-context token machinery: it
 * calls `updateFromToken` (which itself depends on `clearUnlockState` +
 * `initializeUnlockState` from the sibling key hook), `setBlockedReset`,
 * `refreshAccessTokenRef`, and the retain/consume post-reset marker, and is
 * re-entered by both `login`/`loginWithPasskey` and the boot
 * `refreshAccessToken`. Extracting it would force a hook taking 6+ injected
 * deps and re-exporting functions the login paths still call — trading one
 * over-cap file for two with a worse, near-circular boundary. The unlock
 * flags (`needsKeySetup`, `isUnlocked`, `unlockResolved`,
 * `lockedEnvelopeSetEmpty`) are read-only fields threaded straight through
 * from `useZeroKnowledgeKey` at the same destructure → context-value →
 * deps-array chokepoint, not separate sub-systems. Trigger: a change adding
 * 5 or more lines here must either refactor the file back under the limit or
 * re-justify this exception in this note.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { apiRequest, ApiRequestError, configureApi } from '../api/client';
import {
  clearLastUserId,
  maybeResetForNewUser as maybeResetForNewUserCore,
  productionDeps as transitionDeps,
} from './user-transition';
import {
  IdleTimer,
  resolveIdleConfig,
  setSignoutReason,
  consumeSignoutReason,
  writeLastActivityAt,
  SIGNOUT_REASON_IDLE,
} from './IdleTimer';
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { clearCachedHdk } from '../crypto/key-cache';
import { addPrfEvalToOptions, extractPrfResult } from '../crypto/passkey-prf';
import { useZeroKnowledgeKey } from './useZeroKnowledgeKey';
import { useDerivedRewrap } from './useDerivedRewrap';
import {
  usePasswordResetClient,
  type RequestPasswordResetResponse,
} from './usePasswordResetClient';
import { useMfaManagement, type MfaManagement } from './useMfaManagement';
import { stepUpProofFields, type StepUpProof } from '../components/useStepUp';
import { LocalResetRequiredModal } from '../components/LocalResetRequiredModal';
import { PasswordRewrapPrompt } from '../components/PasswordRewrapPrompt';
import { decodeJwt, type JwtClaims } from './token-utils';
import {
  readOrInitDeviceId,
  readStoredEmail,
  storeEmail,
  clearStoredEmail,
  shouldSkipBootRefreshForIdle,
  clearActivityTimestamp,
  writeBlockedResetMarker,
  readBlockedResetMarker,
  clearBlockedResetMarker,
  persistSignupProfile,
} from './session-storage';
import type {
  Role,
  Me,
  LoginResponse,
  MfaChallengeState,
  VerifyMfaResult,
  AccountRecord,
  UpdateAccountRecordRequest,
  ChangeEmailRequestResult,
  ChangeEmailStepUpResult,
  StepUpPurpose,
  PasskeyInfo,
  DeviceClearAttempt,
} from './types';
import { PasswordChangeCommittedError, PasswordChangeNotSentError } from './types';

// Re-export the public auth types + storage/signup helpers from their new
// homes so the ~53 `useAuth()` consumer files keep their existing import
// paths.
export type {
  Role,
  MfaChallengeState,
  VerifyMfaResult,
  AccountRecord,
  PasskeyInfo,
  DeviceClearAttempt,
} from './types';
export {
  DEVICE_ID_STORAGE_KEY,
  readStoredAuthEmail,
  clearSignupProfile,
  updateSignupProfile,
} from './session-storage';

/**
 * Two-step login challenge (enforced MFA). When the device is
 * untrusted, password login returns this instead of a session: a 5-min
 * challenge token plus the routine `methods` (strongest-first: `passkey` when
 * ≥1 passkey is enrolled, then `totp`, else `email_otp`) and the
 * `recoveryMethods` fallback set (`email_otp`). No claims are adopted — the SPA
 * holds the token and completes
 * `POST /auth/mfa/verify`. See "The second factor" in docs/security.md.
 */
interface MfaLoginResponse {
  mfaRequired: true;
  challengeToken: string;
  methods: string[];
  recoveryMethods: string[];
}

/** Password login resolves to either an established session or an MFA challenge. */
type LoginApiResponse = LoginResponse | MfaLoginResponse;

interface SignupResponse {
  userId: string;
  email: string;
  verificationRequired: boolean;
  /** Returned in dev/test only so the developer can click the link. */
  verificationToken?: string;
}

interface ResendVerificationResponse {
  accepted: true;
  /** Returned in dev/test only so the developer can click the link. */
  verificationToken?: string;
}

// Transient-refresh cooldown. `/auth/refresh` is non-idempotent
// (rotate + revoke), so it is never client-retried. After a *transient*
// refresh failure (network/abort/5xx/429/non-401-4xx — session preserved),
// any further `refreshAccessToken` call within this window short-circuits to
// `null` WITHOUT POSTing again. This bounds the app to one `/auth/refresh`
// attempt per window so the second leg of a two-leg sync sequence
// (syncRoundTrip flush→pull, or a poll tick pull→flush) cannot immediately
// replay a possibly-rotated cookie. The window is well under the ~30s active
// poll cadence so recovery still happens on the next tick. A successful
// refresh clears the cooldown; a definitive 401 tears down the session and
// does not arm it (nothing to protect).
const TRANSIENT_REFRESH_COOLDOWN_MS = 5_000;

/**
 * Outcome of one `/auth/refresh` attempt, produced by `performRefresh` below.
 * `definitive` is true only for the
 * endpoint's session-over signals (`INVALID_REFRESH_TOKEN` /
 * `REFRESH_TOKEN_REUSED`, both 401) — the one verdict that proves the server
 * session is gone. Everything else — network/abort, 5xx, 429, any other
 * non-401 4xx, or the cooldown short-circuit — is NOT definitive: the
 * session is preserved and `token` is null. The public `refreshAccessToken`
 * (below) narrows this to its long-standing `Promise<string | null>` shape;
 * `signOutForDeviceClear` is the one caller that needs the `definitive`
 * verdict too, scoped to its own attempt (the shared in-flight/cooldown
 * dedupe means a concurrent, unrelated refresh resolves to the SAME promise,
 * never a stale one read later).
 */
interface RefreshOutcome {
  token: string | null;
  definitive: boolean;
}

interface AuthContextValue {
  me: Me | null;
  isAuthenticated: boolean;
  isBooting: boolean;
  /** ID is needed by SyncProvider to scope IndexedDB. Null until logged in. */
  householdId: string | null;
  deviceId: string;
  /**
   * Zero-knowledge encryption unlock state. `true` once the
   * household data key (HDK) is in memory — either loaded from the device
   * cache after login or recovered via {@link AuthContextValue.unlockWithPassword}.
   * `false` while the household has no key envelope (encryption not set up
   * yet); {@link AuthContextValue.getHdk} then returns null.
   */
  isUnlocked: boolean;
  /**
   * `true` when the user is authenticated but no key envelope exists yet —
   * the encrypted-workspace setup flow keys the household.
   */
  needsKeySetup: boolean;
  /**
   * `true` once {@link initializeUnlockState} has settled after login (cached-HDK
   * lookup + envelope fetch done, or failed). Gates the LoginPage unlock prompt:
   * before this resolves all the unlock flags are transiently false, so the
   * prompt must not flash. Reset to `false` on every logout / new sign-in.
   */
  unlockResolved: boolean;
  /**
   * `true` once the post-login envelope fetch found a `passkey_prf` slot (one
   * per household). Drives the LoginPage "Unlock with passkey" button — only
   * shown when there is an enrolled PRF slot to target. False until resolved /
   * after logout.
   */
  hasPasskeyPrfSlot: boolean;
  /**
   * `true` when the post-login envelope fetch was served an EMPTY key-
   * envelope slot set on a device that already has evidence of a real key
   * here — a cached HDK, or a non-zero rollback pin.
   * Read-only context for WHY the LoginPage locked screen is showing rather
   * than the first-time setup form; a genuinely unkeyed household never sets
   * this. False until resolved / after logout.
   */
  lockedEnvelopeSetEmpty: boolean;
  /** Stable accessor for the in-memory HDK, threaded to SyncProvider. */
  getHdk(): CryptoKey | null;
  /**
   * Recover the HDK from the password key-envelope slot, verify the
   * envelope-set tag, hold it in memory, and cache it on the device. Throws on
   * a wrong password, a missing/invalid slot, or a tamper-detected slot set.
   */
  unlockWithPassword(password: string): Promise<void>;
  /**
   * Recover the HDK from the recovery key-envelope slot using the grouped
   * recovery-key display string the user saved at setup, verify the envelope-set
   * tag, hold it in memory, and cache it on the device. Throws on a wrong/
   * malformed recovery key, a missing slot, or a tamper-detected slot set.
   */
  unlockWithRecovery(recoveryKey: string): Promise<void>;
  /**
   * User-initiated passkey-PRF unlock from the post-login "Unlock your data"
   * prompt. Runs a targeted WebAuthn assertion against the
   * enrolled `passkey_prf` slot's bound credential + salt, unwraps the slot,
   * verifies the envelope-set tag, holds + caches the HDK. Throws on no PRF
   * slot, an authenticator without a PRF result, or a tamper-detected slot set
   * so the button surfaces a clear error.
   */
  unlockWithPasskey(): Promise<void>;
  /**
   * First-time encryption setup (activation). Generates the
   * household data key (HDK), wraps it in a password slot + a recovery slot,
   * and activates both atomically via the key-envelope endpoint, then holds +
   * caches the HDK and flips `isUnlocked`. Returns the grouped recovery-key
   * display string so the caller (LoginPage) can show it once in
   * {@link RecoveryKeyModal}. Idempotent — a retry after a partial failure
   * (the repair path) re-completes the missing slot safely. Throws on any
   * failure so the caller can surface it and let the user retry; throws
   * `SetupStepUpRequiredError` when the
   * repair path needs a fresh factor and `proof` was omitted.
   */
  setupEncryption(password: string, proof?: StepUpProof): Promise<string>;
  signup(
    email: string,
    password: string,
    firstName?: string,
    lastName?: string,
    birthdate?: string,
  ): Promise<SignupResponse>;
  verifyEmail(
    token: string,
  ): Promise<{ verified: boolean; userId: string; approvalToken?: string }>;
  resendVerification(email: string): Promise<ResendVerificationResponse>;
  /** Request a password-reset link (opaque 202 — never reveals whether the
   * email exists; dev/test builds may echo the raw token). See
   * "Password change, password reset" in docs/security.md. */
  requestPasswordReset(email: string): Promise<RequestPasswordResetResponse>;
  /**
   * Consume a password-reset token: set a new password (204). Sets a
   * non-secret post-reset marker (never the password) so the next successful
   * sign-in retains the password the user logs in with, for the recovery-key /
   * passkey re-wrap of the `password` key-envelope slot; reset does NOT
   * unlock encrypted data on its own. See "Password change, password reset" in docs/security.md.
   */
  resetPassword(token: string, newPassword: string): Promise<void>;
  login(email: string, password: string): Promise<void>;
  /**
   * The pending two-step MFA challenge (enforced MFA), or null when
   * no challenge is in flight. Non-null after a password login on an untrusted
   * device: the LoginPage renders {@link MfaChallengeForm} until the second
   * factor is verified (or the user backs out via {@link clearMfaChallenge}).
   */
  mfaChallenge: MfaChallengeState | null;
  /**
   * Complete the pending MFA challenge with the chosen factor.
   * On success the session is adopted (the post-reset ZK unlock still fires on
   * the password retained from the password step) and the challenge clears.
   * `rememberDevice` is honored only for a routine factor. Throws an
   * ApiRequestError (e.g. `MFA_CODE_INVALID`) on a wrong/expired code.
   */
  verifyMfa(
    method: string,
    code: string,
    rememberDevice: boolean,
  ): Promise<VerifyMfaResult>;
  /**
   * Complete the pending MFA challenge with a passkey (passkey as second factor).
   * Fetches the scoped start options (`allowCredentials` for the
   * challenge user), runs a WebAuthn assertion, POSTs it to `mfa/verify`, and
   * adopts the session through the same retained-password ZK-unlock path the
   * code factors use (no second password prompt). `rememberDevice` mints ~30-day
   * device trust (passkey is a routine factor). Throws an ApiRequestError on a
   * server rejection and rethrows a WebAuthn rejection (cancel/timeout) so the
   * form can show non-alarming retry copy. The retained challenge password
   * is cleared on every exit.
   */
  verifyMfaWithPasskey(rememberDevice: boolean): Promise<VerifyMfaResult>;
  /** Send a 6-digit Email-OTP for the pending challenge. */
  sendEmailOtp(): Promise<void>;
  /** Abandon the pending MFA challenge and return to the sign-in form. */
  clearMfaChallenge(): void;
  /** Read the current authenticator status for the Security 2FA card. */
  getMfaStatus: MfaManagement['getMfaStatus'];
  /** Begin TOTP enrollment (secret + otpauth URL for the QR). */
  enrollTotpStart: MfaManagement['enrollTotpStart'];
  /** Confirm TOTP enrollment with a live code. */
  enrollTotpConfirm: MfaManagement['enrollTotpConfirm'];
  /** Disable TOTP behind a server-side password step-up. */
  disableTotp: MfaManagement['disableTotp'];
  /** Lift the TOTP factor's post-reset restriction. */
  confirmTotpRestriction: MfaManagement['confirmTotpRestriction'];
  /** List the caller's trusted devices. */
  listTrustedDevices: MfaManagement['listTrustedDevices'];
  /** Forget devices by id, or all when omitted. */
  forgetDevices: MfaManagement['forgetDevices'];
  logout(): Promise<void>;
  /**
   * Sign-out entry point for "Clear data on this device".
   * Unlike {@link logout}, which is
   * best-effort and always tears local state down, this reports whether the
   * server session is PROVABLY gone as a result of THIS attempt — either
   * `/auth/logout` answered 2xx, or this browser's refresh cookie was
   * definitively rejected by `/auth/refresh` while the attempt was running —
   * and only clears local auth state on that proof. A bare 401 alone does not
   * prove the session is gone (a transient refresh failure or the cooldown
   * short-circuit can both surface a 401 with a still-live session behind
   * it); those report `proven: false` and leave session state exactly as the
   * refresh path left it.
   */
  signOutForDeviceClear(): Promise<DeviceClearAttempt>;
  /** WebAuthn passkey flows. `loginWithPasskey` is username-less —
   * the browser's passkey picker identifies the user. */
  loginWithPasskey(): Promise<void>;
  /** Register a new passkey. The write is gated:
   * the account password is always re-verified, and a fresh second factor
   * `proof` is required on top when `AUTH_MFA_ENFORCED` is on. `noticeSent`:
   * whether the server's factor-change notice mail
   * actually went out — the card only claims "we emailed you" when it did. */
  registerPasskey(
    currentPassword: string,
    proof?: StepUpProof,
  ): Promise<PasskeyInfo & { noticeSent: boolean }>;
  listPasskeys(): Promise<PasskeyInfo[]>;
  /** Remove a passkey behind a password re-verify baseline (+ a step-up factor
   * when `AUTH_MFA_ENFORCED` is on). Body-bearing POST.
   * Resolves `noticeSent` — see `registerPasskey`. */
  removePasskey(
    id: string,
    currentPassword: string,
    proof?: StepUpProof,
  ): Promise<{ noticeSent: boolean }>;
  /** Lift a passkey's post-reset restriction —
   * the proof must come from a different, already-enrolled, non-restricted
   * factor that predates the reset (`totp` or `passkey` only). */
  confirmPasskeyRestriction(id: string, proof: StepUpProof): Promise<void>;
  isPasskeySupported(): boolean;
  /**
   * Enroll a passkey as a zero-knowledge encryption-unlock method.
   * Requires an unlocked session; triggers a targeted WebAuthn
   * assertion to obtain a PRF secret, wraps the HDK into a `passkey_prf` slot
   * bound to the credential, and PUTs it (replacing any prior PRF slot — one per
   * household). Throws on a locked session, an authenticator without PRF
   * support, or a server rejection (e.g. credential not enrolled for this user).
   * `currentPassword`: the password floor
   * this write ALWAYS carries — first-ever enrollment as much as a replace —
   * in either `AUTH_MFA_ENFORCED` state. `proof`: the OPTIONAL fresh factor,
   * required only when `AUTH_MFA_ENFORCED` is on.
   */
  enrollPasskeyForEncryption(
    credentialId: string,
    currentPassword: string,
    proof?: StepUpProof,
  ): Promise<void>;
  /**
   * Prepare a recovery-key regeneration, two-phase so
   * nothing changes server-side until the user confirms they saved the new key.
   * The user proves the current account password (re-auth); a fresh `recovery`
   * slot is minted to wrap the same HDK but is NOT persisted yet. Returns the new
   * grouped recovery-key display string (to show once in {@link RecoveryKeyModal})
   * plus an `activate` thunk. Until `activate()` runs the existing recovery key
   * keeps working; calling it replaces the old slot and the previous key stops
   * working. Cancelling (never calling `activate`) leaves the old key intact. The
   * original key can never be re-displayed (raw bytes never persisted), so
   * rotating is the only path back. Prepare throws on a wrong password / tampered
   * set; `activate()` throws on a write failure. See "The three unlock slots" in
   * docs/security.md.
   */
  regenerateRecoveryKey(
    password: string,
  ): Promise<{ recoveryKey: string; activate: (proof?: StepUpProof) => Promise<void> }>;
  /**
   * Re-cache the in-memory HDK after an operation that wipes the device
   * `keyCache` while leaving the unlocked session intact (snapshot restore or
   * Settings → Workspace → Reload from server). Without re-caching, a subsequent page
   * refresh misses the cache and shows the unlock prompt. Best-effort: no-ops
   * when the session is locked and swallows an IDB write failure, so it never
   * gates the reseed success path.
   */
  recacheHdk(): Promise<void>;
  /** Stubbed; v1 has no roles (always false). Kept for legacy callers. */
  hasRole(...roles: Role[]): boolean;
  /** Stubbed; legacy callers expect this. Re-add when /auth/me ships. */
  changePassword(
    currentPassword: string,
    newPassword: string,
    proof?: StepUpProof,
  ): Promise<void>;
  /** Side-effect-free password re-auth.
   * Throws ApiRequestError with code
   * `INVALID_CREDENTIALS` on mismatch. Pass `{ purpose: 'data_export' }`
   * to route the audit event to `data_export` / `data_export_failed`
   * (the data-export gate); `{ purpose: 'change_password' }` keeps the
   * generic audit event but is required by `changePassword`'s leading
   * session-authority-repair call so `LegalAcceptanceGuard`'s body-purpose
   * exemption recognizes it while legally blocked;
   * `{ purpose: 'password_slot_rewrap' }` is the
   * same shape for the derived post-reset re-wrap prompt's answer
   * (see useDerivedRewrap.ts) — every
   * purpose also updates the CURRENT session's recorded write authority
   * in place, which is what lets a verified prompt answer
   * complete the write. Omitted by import/demo re-auth. */
  verifyPassword(
    currentPassword: string,
    opts?: { purpose?: 'data_export' | 'change_password' | 'password_slot_rewrap' },
  ): Promise<void>;
  /** Permanently delete the user's account.
   * When `AUTH_MFA_ENFORCED` is on the caller also supplies
   * a fresh step-up factor proof; it is omitted on
   * the flag-off password-only floor. On success, the caller is responsible for
   * the client-side cleanup (`dropLocalDatabase` + redirect). */
  deleteAccount(currentPassword: string, proof?: StepUpProof): Promise<void>;
  /** Fetch the account record (`GET /auth/me`) for the Security-page account
   * card and the shell's first-run primary-member seed. `raiseWaitNotice:
   * false` keeps a throttled background check from raising the shared "Please
   * wait" toast about a request the person never made. */
  fetchAccountRecord(opts?: { raiseWaitNotice?: boolean }): Promise<AccountRecord>;
  /** Correct the account-record `firstName`/`lastName`/`birthdate`
   * (`PATCH /auth/me`). Session-only
   * — no password re-entry or MFA step-up. Returns the server's typed
   * projection (the same shape `fetchAccountRecord` returns), built from the
   * values just written. */
  updateAccountRecord(profile: UpdateAccountRecordRequest): Promise<AccountRecord>;
  /** Start a verified email change (`POST /auth/change-email/request`):
   * re-auth with the current password + the new address. Returns whether a
   * fresh MFA factor is still required. */
  changeEmail(
    newEmail: string,
    currentPassword: string,
  ): Promise<ChangeEmailRequestResult>;
  /** Send a fresh Email-OTP for the pending change-email step-up. */
  sendEmailChangeOtp(): Promise<void>;
  /** Verify a fresh MFA factor for the pending change-email intent; on success
   * the verification link is mailed to the new address. Passkey
   * rides in `response`; the two code factors carry `code`. */
  verifyEmailChangeStepUp(
    method: string,
    code: string,
    response?: AuthenticationResponseJSON,
  ): Promise<ChangeEmailStepUpResult>;
  /** Fetch purpose-scoped WebAuthn step-up options (`POST /auth/step-up/passkey/options`),
   * used by the passkey factor of the reusable step-up flow. */
  stepUpPasskeyOptions(
    purpose: StepUpPurpose,
  ): Promise<PublicKeyCredentialRequestOptionsJSON>;
  /** Email a purpose-bound step-up code (`POST /auth/step-up/email-otp/send`),
   * the generic Email-OTP prep for destructive / factor-management ops.
   * Change-email keeps its own `sendEmailChangeOtp`. */
  stepUpSendEmailOtp(purpose: StepUpPurpose): Promise<void>;
  /** Consume the change-email verification token (the new-address link).
   * Public — no session needed. Returns the new email on success. */
  confirmEmailChange(token: string): Promise<{ email: string }>;
  /** Force-refresh the access token. Returns the new token, or null
   * when the refresh cookie is missing/expired (auth state cleared as
   * a side-effect). Exposed so the SyncProvider transport can mirror
   * the 401-refresh-retry that `apiRequest` performs. */
  refreshAccessToken(): Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const accessTokenRef = useRef<string | null>(null);
  const claimsRef = useRef<JwtClaims | null>(null);
  // Timestamp of the last *transient* refresh failure. Arms the cooldown
  // that short-circuits a near-immediate second refresh attempt; cleared on any
  // adopted valid token (`updateFromToken`). Declared here (above
  // `updateFromToken`) so the clear there is in scope. `inflightRefreshRef`
  // handles *concurrent* callers; this handles *sequential* ones (the two sync
  // legs).
  const transientRefreshFailedAtRef = useRef<number | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [isBooting, setIsBooting] = useState(true);
  const [deviceId] = useState<string>(() => readOrInitDeviceId());
  // Cross-user IDB reset failed closed: another tab held
  // the IDB open so the previous user's working store could not be dropped.
  // Non-null = the LocalResetRequiredModal is shown; `retry` re-attempts the
  // drop + login continuation once the user has closed the other tabs.
  const [blockedReset, setBlockedReset] = useState<{ retry: () => Promise<void> } | null>(null);
  // Pending two-step MFA challenge (enforced MFA). Non-null between a
  // password login on an untrusted device and a successful `verifyMfa` — holds
  // the 5-min challenge token + the offered factor sets. No claims are adopted
  // while this is set; the LoginPage renders the challenge form. Cleared on
  // verify success, an explicit back-out, and logout.
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallengeState | null>(null);
  // The password typed at the MFA-challenged login, held in memory (never
  // persisted) until `verifyMfa` adopts the session — it threads into
  // `resetThenCompleteLogin` so the post-login zero-knowledge unlock
  // runs on the same password the user just signed in with. Cleared on verify
  // success, an explicit back-out, and logout.
  const mfaPasswordRef = useRef<string | null>(null);

  // Authenticated MFA-management surface (status/enroll/disable/regenerate/
  // trusted-devices), split into a focused hook so this file stays inside its
  // recorded shape-limit exception. Re-exported through context for the Security
  // 2FA card; these are stateless `apiRequest` wrappers (no auth state of their
  // own — the token + CSRF cookie ride through the shared client).
  const mfa = useMfaManagement();

  // Zero-knowledge unlock state lives in a focused hook
  // (useZeroKnowledgeKey) — one of the cohesive sub-systems already split out of
  // this file (see the header's recorded shape-limit exception). The hook
  // owns the in-memory HDK + the reactive unlock flags and exposes the key
  // lifecycle operations; AuthContext threads them through context. The hook
  // needs `verifyPassword` (to gate setup on the current account password) and
  // `claimsRef` (to drop a stale household's result on a mid-flight switch).
  const verifyPassword = useCallback(
    async (
      currentPassword: string,
      opts?: { purpose?: 'data_export' | 'change_password' | 'password_slot_rewrap' },
    ): Promise<void> => {
      await apiRequest('/api/v1/auth/verify-password', {
        method: 'POST',
        // Only attach `purpose` when supplied so import/demo callers keep
        // sending the bare body and recording the generic verify event.
        body: opts?.purpose
          ? { currentPassword, purpose: opts.purpose }
          : { currentPassword },
      });
    },
    [],
  );
  const {
    isUnlocked,
    needsKeySetup,
    unlockResolved,
    hasPasskeyPrfSlot,
    lockedEnvelopeSetEmpty,
    getHdk,
    clearUnlockState,
    initializeUnlockState,
    unlockWithPassword,
    unlockWithRecovery,
    unlockWithPasskey,
    setupEncryption,
    rotatePasswordSlot,
    prepareRewrappedPasswordSlot,
    regenerateRecoveryKey,
    recacheHdk,
    enrollPasskeyForEncryption,
    tryUnlockWithPrf,
    takeLastUnlockEnvelopes,
  } = useZeroKnowledgeKey({ claimsRef, verifyPassword });

  // Derived post-reset re-wrap, in a focused hook
  // (another extracted sub-system — see the header's
  // recorded shape-limit exception). It retains the plaintext THIS session's
  // sign-in accepted for the unlock window, and — on every unlock-state
  // transition (below) — derives whether the `password` slot still needs
  // re-wrapping and either does it silently (plaintext in hand) or shows the
  // prompt (none in hand). Unlike the retired `usePostResetRewrap`, it is
  // NOT wired into any specific unlock branch: the `isUnlocked` effect below
  // covers the cached-key auto-unlock, the PRF unlock, and all three
  // explicit branches uniformly, so none can be forgotten.
  const {
    retainPassword,
    clearRetainedPassword,
    runDerive,
    prompt: rewrapPrompt,
    answerPrompt: answerRewrapPrompt,
    dismissPrompt: dismissRewrapPrompt,
  } = useDerivedRewrap({ getHdk, rotatePasswordSlot, verifyPassword, takeLastUnlockEnvelopes });

  // Run the derive on every unlock-state transition (rising edge of
  // `isUnlocked`) — the cached-key auto-unlock, the PRF unlock, and all three
  // explicit unlock branches all flip this flag the same way, so one effect
  // covers every trigger.
  const wasUnlockedRef = useRef(false);
  useEffect(() => {
    if (isUnlocked && !wasUnlockedRef.current) runDerive();
    wasUnlockedRef.current = isUnlocked;
  }, [isUnlocked, runDerive]);

  // Password-reset client surface (the bare request + consume API calls), in
  // a focused hook (a third extracted sub-system — see the header's recorded
  // shape-limit exception). The one-shot sessionStorage marker it used to own
  // is gone — whether a re-wrap is owed is now derived server-side
  // rather than remembered client-side.
  const { requestPasswordReset, resetPassword } = usePasswordResetClient();

  /**
   * Decode a JWT body (no signature verification — that's the server's
   * job). We just need the claims for the SyncProvider's householdId.
   */
  const updateFromToken = useCallback((token: string) => {
    accessTokenRef.current = token;
    // Adopting any valid token (login, passkey, or a successful refresh) means
    // the session is live again, so disarm the transient-refresh cooldown
    // — a fresh login must not be throttled by an earlier transient
    // blip (e.g. the boot refresh that found no cookie).
    transientRefreshFailedAtRef.current = null;
    const claims = decodeJwt(token);
    // Distinguish a genuine new session/user switch from a silent token refresh
    // for the SAME user+household (boot refresh, idle "stay signed in", 401
    // retry, change-password). On a same-session refresh the existing unlock
    // state — the in-memory HDK, `isUnlocked`, the resolved gate — is still
    // valid; clearing + re-initializing it would needlessly drop the HDK, and if
    // the re-init's envelope fetch then failed (network blip) it would strand an
    // authenticated user with getHdk() === null. So we only
    // reset + re-derive unlock state when the user or household actually changes.
    const prev = claimsRef.current;
    const sameSession =
      !!prev &&
      !!claims &&
      prev.userId === claims.userId &&
      prev.householdId === claims.householdId;
    claimsRef.current = claims;
    if (!sameSession) {
      // New user / user switch: drop the previous session's in-memory key before
      // adopting the new claims — the old user's HDK must never carry into a new
      // session. The new user's cached key (if any) is loaded by
      // initializeUnlockState below.
      clearUnlockState();
    }
    if (claims) {
      setHouseholdId(claims.householdId);
      const email = claims.email ?? readStoredEmail();
      // A same-user/household refresh (boot refresh, idle "stay signed in",
      // 401 retry, change-password) must not lose the firstName/lastName/
      // birthdate a prior `updateAccountRecord` merged in — reconstructing
      // `me` from bare claims would otherwise revert them to the login-time
      // (absent) values. An actual user switch gets a fresh `me` with none
      // of the previous user's profile fields carried over.
      setMe((prevMe) => ({
        id: claims.userId,
        email,
        displayName: email,
        roles: [],
        ...(sameSession && prevMe
          ? {
              firstName: prevMe.firstName,
              lastName: prevMe.lastName,
              birthdate: prevMe.birthdate,
            }
          : {}),
      }));
      // Only (re-)derive unlock state on a genuine new session; a same-session
      // refresh keeps the still-valid cached HDK and unlock flags untouched.
      if (!sameSession) void initializeUnlockState(claims);
    }
  }, [clearUnlockState, initializeUnlockState]);

  /**
   * Boot-refresh guard for a blocked cross-user reset. A prior login
   * surfaced the blocking modal because the previous user's IDB drop failed AND
   * the new user's session-revoke may have failed too — so the new user's
   * refresh cookie can survive into this reload. When the just-refreshed token's
   * userId matches the persisted blocked-reset marker, retry the IDB drop BEFORE
   * the caller adopts the claims. On success the marker is cleared and the caller
   * proceeds to `updateFromToken`; on a repeat failure we re-show the blocking
   * modal (whose Retry re-runs the boot refresh) and the claims are NOT adopted —
   * the new user's household never renders over the previous user's stale rows.
   *
   * Returns `true` when the caller may proceed to adopt the token, `false` when
   * the drop is still blocked (claims withheld, modal shown).
   */
  const guardBlockedReset = useCallback(
    async (accessToken: string): Promise<boolean> => {
      const pending = readBlockedResetMarker();
      if (!pending) return true;
      const tokenUserId = decodeJwt(accessToken)?.userId;
      // A different user (or an undecodable token) is unrelated to the pending
      // block; clear the stale marker and let the caller proceed normally.
      if (tokenUserId !== pending) {
        clearBlockedResetMarker();
        return true;
      }
      try {
        await maybeResetForNewUser(accessToken);
      } catch {
        // Still blocked (the other tab has not released the IDB handle): keep the
        // marker, withhold the claims, and re-show the modal. Retry re-runs the
        // boot refresh, which re-enters this guard.
        setBlockedReset({ retry: () => refreshAccessTokenRef.current().then(() => undefined) });
        return false;
      }
      clearBlockedResetMarker();
      setBlockedReset(null);
      return true;
    },
    [],
  );

  // Late-bound ref to refreshAccessToken so the blocked-reset modal's Retry can
  // re-run the boot refresh. The ref is irreducible, not a declaration-order
  // workaround: refreshAccessToken calls guardBlockedReset, and the guard's
  // failure path needs refreshAccessToken back (mutual recursion). Expressing
  // that with direct useCallback deps would be circular — neither callback
  // could ever stabilize — so one side must read through a ref.
  const refreshAccessTokenRef = useRef<() => Promise<string | null>>(
    () => Promise.resolve(null),
  );

  // Concurrent refresh calls would each try to rotate the same refresh
  // token — the second one sees the row already-rotated and trips the
  // server's reuse-detection path (ConditionalCheckFailed). Dedupe to
  // one in-flight promise so React's dev double-mount or two parallel
  // 401-retries collapse into a single round-trip.
  const inflightRefreshRef = useRef<Promise<RefreshOutcome> | null>(null);
  const performRefresh = useCallback(async (): Promise<RefreshOutcome> => {
    if (inflightRefreshRef.current) return inflightRefreshRef.current;
    // Transient-refresh cooldown: a refresh that transient-failed within
    // the window short-circuits to null WITHOUT POSTing again, so the second
    // sync leg / a near-simultaneous caller can't replay a possibly-rotated
    // cookie. Session state is left untouched here — the prior transient
    // failure already preserved it. Recovery happens on the next poll tick.
    if (
      transientRefreshFailedAtRef.current !== null &&
      Date.now() - transientRefreshFailedAtRef.current < TRANSIENT_REFRESH_COOLDOWN_MS
    ) {
      return { token: null, definitive: false };
    }
    const promise = (async (): Promise<RefreshOutcome> => {
      try {
        const res = await apiRequest<LoginResponse>('/api/v1/auth/refresh', {
          method: 'POST',
          auth: false,
          // No wait notice at the shared client seam
          // applies to /auth/refresh — it keeps its own single-attempt,
          // non-retried cooldown, untouched.
          raiseWaitNotice: false,
        });
        // Before adopting a refreshed token, honor a pending blocked-reset
        // marker — retry the previous user's IDB drop and withhold the claims if
        // it is still blocked, so a survived refresh cookie can't expose the new
        // user's household over the previous user's stale IDB.
        if (!(await guardBlockedReset(res.accessToken))) return { token: null, definitive: false };
        updateFromToken(res.accessToken);
        // Successful refresh clears the transient cooldown.
        transientRefreshFailedAtRef.current = null;
        return { token: res.accessToken, definitive: false };
      } catch (err) {
        // Classify the failure. DEFINITIVE sign-out ⟺ a 401 from
        // `/auth/refresh` (the endpoint's only session-over signals are
        // INVALID_REFRESH_TOKEN / REFRESH_TOKEN_REUSED, both 401). Everything
        // else — a network/abort error (not an ApiRequestError), a 5xx, a 429,
        // or any other non-401 4xx — is TRANSIENT: the session is preserved
        // and the caller surfaces the original 401 as a retryable error. We
        // never client-retry the non-idempotent refresh; recovery is the
        // next poll tick / re-click, bounded by the cooldown.
        const definitive = err instanceof ApiRequestError && err.status === 401;
        if (!definitive) {
          // Transient: arm the cooldown, leave accessTokenRef/claimsRef/me/
          // householdId/unlock state untouched, and return null so the caller
          // treats the original 401 as retryable.
          transientRefreshFailedAtRef.current = Date.now();
          return { token: null, definitive: false };
        }
        // Definitive 401: tear down the session exactly as before.
        accessTokenRef.current = null;
        claimsRef.current = null;
        setMe(null);
        setHouseholdId(null);
        clearUnlockState();
        // A definitive sign-out does not arm the cooldown — there is no
        // session left to protect.
        transientRefreshFailedAtRef.current = null;
        // Session drop (refresh failed → signed out): the unlock window is
        // over — drop any retained sign-in plaintext, close the rewrap
        // prompt, and invalidate any in-flight derive.
        clearRetainedPassword();
        return { token: null, definitive: true };
      } finally {
        inflightRefreshRef.current = null;
      }
    })();
    inflightRefreshRef.current = promise;
    return promise;
  }, [updateFromToken, guardBlockedReset, clearUnlockState, clearRetainedPassword]);

  /**
   * Public token refresher — `AuthContextValue.refreshAccessToken`, the
   * `client.ts`-configured `TokenRefresher`, the idle "stay signed in" path,
   * etc. Thin wrapper over {@link performRefresh} that keeps the long-standing
   * `Promise<string | null>` shape every existing caller expects; the
   * `definitive` verdict `performRefresh` also produces is consumed
   * separately by {@link signOutForDeviceClear}.
   */
  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    const { token } = await performRefresh();
    return token;
  }, [performRefresh]);

  // Keep the late-bound ref pointing at the live refreshAccessToken so the
  // blocked-reset modal's Retry (wired in guardBlockedReset) re-runs the current
  // boot refresh.
  refreshAccessTokenRef.current = refreshAccessToken;

  // Bounded-lifetime guard for the retained challenge password (CWE-316).
  // The explicit exits (verify success, cancel/back-out, thrown/cancelled
  // assertion, logout) clear `mfaPasswordRef` inline; this body closes the
  // remaining window — a challenge that clears for any other reason — so the
  // password held across the long async passkey window is never stranded. (We
  // deliberately do NOT clear in this effect's cleanup: it would wipe the
  // password `login` sets in the same render that flips `mfaChallenge` non-null.
  // Provider-unmount clearing rides the mount-only effect below.)
  useEffect(() => {
    if (mfaChallenge === null) mfaPasswordRef.current = null;
  }, [mfaChallenge]);

  // Mount-only: clear the retained challenge password if the provider ever
  // unmounts (tab teardown / navigation away from the SPA root) — the final
  // exit in that list.
  useEffect(() => {
    return () => {
      mfaPasswordRef.current = null;
    };
  }, []);

  const idleConfig = useMemo(() => resolveIdleConfig(), []);

  useEffect(() => {
    let active = true;
    configureApi({ getAccessToken: () => accessTokenRef.current, refreshAccessToken });

    // Boot-after-idle: if `lastActivityAt` is older than the configured
    // window, skip the bootstrap refresh and treat the user as signed
    // out. The server-side rotate would also fail, but skipping the
    // round-trip keeps the login page from flashing "signed in" first.
    if (idleConfig.enabled && shouldSkipBootRefreshForIdle(idleConfig.idleMs)) {
      setSignoutReason(SIGNOUT_REASON_IDLE);
      clearActivityTimestamp();
      if (active) setIsBooting(false);
      return () => {
        active = false;
      };
    }

    refreshAccessToken().finally(() => {
      if (active) setIsBooting(false);
    });
    return () => {
      active = false;
    };
  }, [refreshAccessToken, idleConfig]);

  const signup = useCallback(
    async (
      email: string,
      password: string,
      firstName?: string,
      lastName?: string,
      birthdate?: string,
    ): Promise<SignupResponse> => {
      const res = await apiRequest<SignupResponse>('/api/v1/auth/signup', {
        method: 'POST',
        // Only the profile fields that were supplied ride along; the server
        // rejects any field it does not know.
        body: {
          email,
          password,
          ...(firstName ? { firstName } : {}),
          ...(lastName ? { lastName } : {}),
          ...(birthdate ? { birthdate } : {}),
        },
        auth: false,
      });
      return res;
    },
    [],
  );

  const verifyEmail = useCallback(async (token: string) => {
    return apiRequest<{ verified: boolean; userId: string; approvalToken?: string }>(
      '/api/v1/auth/verify-email',
      { method: 'POST', body: { token }, auth: false },
    );
  }, []);

  const resendVerification = useCallback(
    async (email: string): Promise<ResendVerificationResponse> => {
      return apiRequest<ResendVerificationResponse>(
        '/api/v1/auth/resend-verification',
        { method: 'POST', body: { email }, auth: false },
      );
    },
    [],
  );

  /**
   * Finish a login once the cross-user IDB drop has succeeded: seed activity,
   * clear the idle-signout flash, run the post-reset re-wrap retain, and adopt
   * the new claims. Shared by the password + passkey login paths and the
   * blocked-reset Retry continuation so the post-drop steps stay identical.
   */
  const completeLoginAfterReset = useCallback(
    (accessToken: string, password: string | null): void => {
      // Seed activity BEFORE updateFromToken sets `me` (which enables
      // IdleTimer). Without this, there's a race window where the timer's
      // enable-effect could read an absent/stale timestamp and immediately
      // fire the idle-timeout callback.
      writeLastActivityAt(Date.now());
      // Clear any lingering idle-signout reason left over from the
      // previous session so it doesn't flash on a subsequent redirect.
      consumeSignoutReason();
      // Derived post-reset re-wrap: retain the plaintext THIS sign-in
      // just accepted on EVERY password sign-in (not only a post-reset one —
      // owed-ness is derived server-side, not remembered client-side, so there
      // is no marker to gate this on). Retain BEFORE updateFromToken so the
      // plaintext is in place before initializeUnlockState resolves and the
      // `isUnlocked` effect fires the derive. Only the password path carries a
      // password to retain (passkey login and a passkey-factor MFA verify
      // carry `null`).
      if (password !== null) retainPassword(password);
      updateFromToken(accessToken);
    },
    [updateFromToken, retainPassword],
  );

  /**
   * Run the cross-user IDB reset, then finish the login. When the reset fails
   * closed (another tab holds the IDB open past the blocked-delete timeout —
   * DatabaseDropBlockedError), do NOT adopt the new claims; surface a blocking
   * modal whose Retry re-authenticates from scratch once the user has closed
   * the other tabs. The new
   * household is never exposed over the previous account's rows.
   *
   * `reauth` re-runs the full login round-trip (password or passkey) to mint a
   * fresh session. On a blocked drop we revoke the just-issued session before
   * surfacing the modal, so the captured `accessToken` is dead;
   * Retry must therefore re-authenticate rather than replay it.
   *
   * Returns `true` when the new claims were adopted (callers may then merge +
   * persist the signup profile), `false` on a blocked-reset (the modal is shown
   * and no claims were adopted — callers MUST NOT merge user B's PII into user
   * A's still-active session).
   */
  const resetThenCompleteLogin = useCallback(
    async (
      accessToken: string,
      password: string | null,
      onComplete?: () => void,
      reauth?: () => Promise<void>,
    ): Promise<boolean> => {
      try {
        await maybeResetForNewUser(accessToken);
      } catch {
        // Fail closed: the previous user's IDB could not be dropped. We never
        // adopt the new user B's claims here — but the login round-trip already
        // set B's refresh cookie in the browser. Without revoking it, a reload
        // would call /auth/refresh with B's cookie, adopt B's token, and expose
        // B's household over A's stale IDB rows.
        //
        // Persist the blocked-reset marker (B's userId) BEFORE the revoke attempt.
        // If the revoke below ALSO fails (network error), B's cookie can
        // survive the reload; the marker makes the next boot refresh retry the
        // IDB drop before adopting B's claims, instead of silently exposing B's
        // household over A's rows. Set it first so it persists even when the
        // revoke throws.
        const newUserId = decodeJwt(accessToken)?.userId;
        if (newUserId) writeBlockedResetMarker(newUserId);
        // Best-effort logout AS B (temporarily swap the access-token ref to B's
        // token so the bearer + the cookie identify the same session) to revoke
        // B's refresh cookie AND denylist B's access token, so a reload falls
        // back to the signed-out state.
        const prevToken = accessTokenRef.current;
        accessTokenRef.current = accessToken;
        try {
          await apiRequest('/api/v1/auth/logout', { method: 'POST' });
        } catch {
          // Best-effort: a failed revoke still surfaces the blocking modal; the
          // user closes the other tab and Retry re-runs the drop + login. The
          // blocked-reset marker above covers the reload window if the cookie
          // survived the failed revoke.
        } finally {
          accessTokenRef.current = prevToken;
        }
        // Surface the blocking modal. Its Retry re-authenticates from scratch
        // (the revoke above killed the captured session) when a `reauth` was
        // supplied; without one it replays this continuation defensively.
        setBlockedReset({
          retry: reauth ?? (() => resetThenCompleteLogin(accessToken, password, onComplete).then(() => undefined)),
        });
        return false;
      }
      // Drop succeeded: clear any stale blocked-reset marker (this or a prior
      // attempt) so the next boot refresh adopts the claims normally.
      clearBlockedResetMarker();
      setBlockedReset(null);
      completeLoginAfterReset(accessToken, password);
      // Passkey path runs a best-effort PRF unlock after the claims are adopted.
      onComplete?.();
      return true;
    },
    [completeLoginAfterReset],
  );

  const login = useCallback(async (email: string, password: string) => {
    const res = await apiRequest<LoginApiResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: { email, password, deviceId },
      auth: false,
    });
    storeEmail(email);
    // Two-step login (enforced MFA): an untrusted device gets an MFA
    // challenge, NOT a session. Hold the typed password in memory (mfaPasswordRef)
    // so the post-verify session adoption can drive the zero-knowledge unlock
    // on the same password, then surface the challenge state for the
    // LoginPage. No claims are adopted here — `verifyMfa` completes the flow.
    if ('mfaRequired' in res) {
      mfaPasswordRef.current = password;
      setMfaChallenge({
        challengeToken: res.challengeToken,
        methods: res.methods,
        recoveryMethods: res.recoveryMethods,
      });
      return;
    }
    // If the device's last-logged-in user differs from the one we just
    // authenticated, drop the IndexedDB working store before exposing
    // the new claims. Without this, `listAggregates` returns the
    // previous user's data because the working store isn't keyed by
    // householdId. Same-user re-login skips the drop and preserves the
    // local cache. A blocked drop fails closed (blocking modal + Retry).
    // Retry re-runs the full login so it re-mints the session the blocked-drop
    // revoke killed.
    const didAdopt = await resetThenCompleteLogin(res.accessToken, password, undefined, () =>
      login(email, password),
    );
    // Blocked cross-user reset (fail-closed): the new claims were NOT adopted —
    // the blocking modal is shown and user A's session is still active. Bail out
    // before merging/persisting user B's profile so B's PII never leaks into A's
    // session.
    if (!didAdopt) return;
    // After the cross-user reset has succeeded and the claims are adopted,
    // merge the signup profile into `me` and persist it for first-run
    // HouseholdMember seeding. No-op when the response omits the
    // fields (old account → existing first-run demo modal path).
    if (res.firstName || res.lastName || res.birthdate) {
      setMe((prev) =>
        prev
          ? { ...prev, firstName: res.firstName, lastName: res.lastName, birthdate: res.birthdate }
          : prev,
      );
    }
    persistSignupProfile(res);
  }, [deviceId, resetThenCompleteLogin]);

  // Shared session-adoption tail for both MFA verify paths. Given the
  // verify response, adopt the session through the SAME cross-user-reset +
  // ZK-unlock path the direct login uses — threading the password retained from
  // the password step so the post-login zero-knowledge unlock runs
  // without a second prompt. A blocked cross-user reset (fail-closed) clears the
  // overlay + challenge so the user lands on the sign-in form; the retained
  // challenge password (mfaPasswordRef) is cleared on EVERY exit. On a
  // successful adopt with profile fields present, merge + persist them.
  // Returns whether the device was remembered. The ONLY per-caller difference is
  // how `res` is obtained (code factor vs passkey assertion).
  const adoptMfaSession = useCallback(
    async (
      res: LoginResponse & { deviceRemembered: boolean },
    ): Promise<VerifyMfaResult> => {
      const retained = mfaPasswordRef.current;
      const didAdopt = await resetThenCompleteLogin(res.accessToken, retained, undefined, async () => {
        // A blocked cross-user reset on an MFA path: clear the blockedReset
        // overlay + the challenge so the user lands on the sign-in form to start
        // fresh.
        setBlockedReset(null);
        mfaPasswordRef.current = null;
        setMfaChallenge(null);
      });
      mfaPasswordRef.current = null;
      setMfaChallenge(null);
      if (didAdopt && (res.firstName || res.lastName || res.birthdate)) {
        setMe((prev) =>
          prev
            ? { ...prev, firstName: res.firstName, lastName: res.lastName, birthdate: res.birthdate }
            : prev,
        );
        persistSignupProfile(res);
      }
      return { deviceRemembered: didAdopt && res.deviceRemembered };
    },
    [resetThenCompleteLogin],
  );

  // Complete the pending MFA challenge (enforced MFA). Verifies the
  // chosen factor server-side; on success the API sets the session cookies and
  // returns a session access token, which we adopt through the SAME
  // cross-user-reset + ZK-unlock path the direct login uses — threading the
  // password retained from the password step so the post-login zero-knowledge
  // unlock runs. Returns whether the device was remembered so
  // the LoginPage can show the subtle "trusted" / "not remembered" note.
  const verifyMfa = useCallback(
    async (
      method: string,
      code: string,
      rememberDevice: boolean,
    ): Promise<VerifyMfaResult> => {
      const challenge = mfaChallenge;
      if (!challenge) {
        // Defensive: verifyMfa called with no pending challenge (e.g. a
        // double-submit after success). Surface a typed-ish failure the form
        // can show rather than firing a bad request.
        throw new Error('No MFA challenge is pending.');
      }
      const res = await apiRequest<
        LoginResponse & { deviceRemembered: boolean }
      >('/api/v1/auth/mfa/verify', {
        method: 'POST',
        body: {
          challengeToken: challenge.challengeToken,
          method,
          code,
          rememberDevice,
          deviceId,
        },
        auth: false,
      });
      // Adopt the session via the shared cross-user-reset + ZK-unlock tail. The
      // retained password drives the post-login unlock exactly as the direct
      // login does. A blocked cross-user reset (fail-closed) leaves the modal up
      // and the claims unadopted; the challenge state is cleared either way so
      // the user is not bounced back to the code field.
      return adoptMfaSession(res);
    },
    [mfaChallenge, deviceId, adoptMfaSession],
  );

  // Complete the pending MFA challenge with a passkey (passkey as second factor).
  // Fetch the user-scoped start options, run a WebAuthn assertion,
  // POST it to mfa/verify, and adopt the session through the SAME cross-user-
  // reset + ZK-unlock path the code factors use — threading the password
  // retained from the password step so the post-login zero-knowledge unlock
  // runs without a second password prompt. The retained password is
  // cleared on EVERY exit (success, server rejection, cancelled/thrown
  // assertion) so the long async passkey window can't strand it (CWE-316).
  const verifyMfaWithPasskey = useCallback(
    async (rememberDevice: boolean): Promise<VerifyMfaResult> => {
      const challenge = mfaChallenge;
      if (!challenge) {
        // Defensive: called with no pending challenge (e.g. a double-submit
        // after success). Mirror verifyMfa's typed-ish failure.
        throw new Error('No MFA challenge is pending.');
      }
      let response: AuthenticationResponseJSON;
      try {
        // Scoped start options: allowCredentials for the challenge user only.
        const options = await apiRequest<PublicKeyCredentialRequestOptionsJSON>(
          '/api/v1/auth/mfa/passkey/start',
          { method: 'POST', body: { challengeToken: challenge.challengeToken }, auth: false },
        );
        // Authentication-only assertion: no PRF eval — post-login unlock
        // rides the retained password, exactly like the code factors.
        response = await startAuthentication({ optionsJSON: options });
      } catch (err) {
        // A WebAuthn rejection (cancel/timeout/NotAllowedError/SecurityError) or
        // a failed start. Clear the retained password and rethrow so the
        // form shows non-alarming retry copy and keeps the recovery tabs
        // selectable — never a silent empty catch.
        mfaPasswordRef.current = null;
        throw err;
      }

      let res: LoginResponse & { deviceRemembered: boolean };
      try {
        res = await apiRequest<LoginResponse & { deviceRemembered: boolean }>(
          '/api/v1/auth/mfa/verify',
          {
            method: 'POST',
            body: {
              challengeToken: challenge.challengeToken,
              method: 'passkey',
              response,
              rememberDevice,
              deviceId,
            },
            auth: false,
          },
        );
      } catch (err) {
        // Server rejected the assertion (bad/expired challenge, UV/counter
        // anomaly). Clear the retained password and rethrow for the form /
        // LoginPage to map (an expired-after-assert token → back to sign-in).
        mfaPasswordRef.current = null;
        throw err;
      }

      // Adopt the session via the shared cross-user-reset + ZK-unlock tail
      // (identical to the code-factor path — only how `res` is obtained differs).
      return adoptMfaSession(res);
    },
    [mfaChallenge, deviceId, adoptMfaSession],
  );

  // Send a 6-digit Email-OTP for the pending challenge. The
  // server names the user from the challenge token; the SPA only forwards it.
  const sendEmailOtp = useCallback(async (): Promise<void> => {
    const challenge = mfaChallenge;
    if (!challenge) throw new Error('No MFA challenge is pending.');
    await apiRequest('/api/v1/auth/mfa/email/send', {
      method: 'POST',
      body: { challengeToken: challenge.challengeToken },
      auth: false,
    });
  }, [mfaChallenge]);

  // Abandon the pending challenge and return to the sign-in form (no session
  // was ever issued, so there is nothing to revoke — just drop the local state
  // and the retained password).
  const clearMfaChallenge = useCallback((): void => {
    mfaPasswordRef.current = null;
    setMfaChallenge(null);
  }, []);

  /**
   * The full local session teardown `logout()` runs unconditionally: drop the
   * in-memory access token/claims, `me`/household state, the stored email +
   * activity timestamp, the zero-knowledge unlock state, any in-flight MFA
   * challenge (+ its retained password), and the post-reset retained
   * password/marker. Factored out so {@link signOutForDeviceClear} can run the
   * exact same teardown but ONLY once the server session is provably gone
   * — `logout()` itself keeps running this
   * unconditionally for every other caller. Safe to call more than once in
   * one attempt (e.g. after `performRefresh` already tore down the token/me/
   * household/unlock state on a definitive verdict): every step here is an
   * idempotent clear.
   */
  const clearSessionState = useCallback((): void => {
    accessTokenRef.current = null;
    claimsRef.current = null;
    setMe(null);
    setHouseholdId(null);
    clearStoredEmail();
    clearActivityTimestamp();
    clearUnlockState();
    // Drop any in-flight MFA challenge + the retained challenge password
    // (signing out abandons any pending second factor).
    mfaPasswordRef.current = null;
    setMfaChallenge(null);
    // Session drop: the unlock window is over — drop any retained sign-in
    // plaintext, close the rewrap prompt, and invalidate any in-flight
    // derive.
    clearRetainedPassword();
    // The cached HDK in IDB is deliberately NOT cleared on a bare same-user
    // logout:
    // it persists for fast re-login, matching how the plaintext aggregates it
    // decrypts already persist — clearing only the key while the plaintext it
    // protects survives would be security theater. The authoritative teardown
    // is the centralized IDB drop (cross-user transition guard, "Clear data on
    // this device", account deletion). The in-memory HDK is always dropped here
    // (clearUnlockState) and at the start of every new sign-in, so one user's
    // key never carries into another's session.
  }, [clearUnlockState, clearRetainedPassword]);

  const logout = useCallback(async () => {
    try {
      await apiRequest('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // Best-effort; we always clear local state.
    }
    clearSessionState();
  }, [clearSessionState]);

  /**
   * See the {@link AuthContextValue.signOutForDeviceClear} docstring. A bare
   * 401 from `/auth/logout` does not by itself prove the session is gone
   * (`client.ts`'s `apiRequest` retry-on-401 is bypassed here on purpose, via
   * `retryOn401: false` on every logout call this function makes — this
   * function drives its own classification instead of relying on the shared
   * module's hidden retry, so the verdict distinguishing a transient failure
   * from a definitive one is never lost, and a definitive verdict this
   * function determines can never be overwritten or duplicated by client.ts's
   * own refresh-on-401): only `performRefresh`'s `definitive` verdict, or a
   * fresh-token retry of the sign-out itself, counts as proof.
   */
  const signOutForDeviceClear = useCallback(async (): Promise<DeviceClearAttempt> => {
    try {
      await apiRequest('/api/v1/auth/logout', { method: 'POST', retryOn401: false });
      clearSessionState();
      return { proven: true };
    } catch (err) {
      if (!(err instanceof ApiRequestError) || err.status !== 401) {
        return {
          proven: false,
          reason:
            err instanceof ApiRequestError
              ? err.error.message
              : "We couldn't reach the server.",
        };
      }
      const { token, definitive } = await performRefresh();
      if (definitive) {
        // The refresh cookie was definitively rejected while THIS attempt was
        // running — no server session survives to prove any further.
        // `performRefresh` already tore down the token/me/household/unlock
        // state; finish the rest of the unconditional-logout teardown too.
        clearSessionState();
        return { proven: true };
      }
      if (!token) {
        // Transient refresh failure, or the cooldown short-circuit: the
        // session is preserved and this attempt cannot prove it is gone.
        return {
          proven: false,
          reason: "We couldn't confirm your session was signed out.",
        };
      }
      // The refresh succeeded — the session is alive with a fresh token.
      // Retry the sign-out once rather than reporting a false ambiguous stop.
      try {
        await apiRequest('/api/v1/auth/logout', { method: 'POST', retryOn401: false });
        clearSessionState();
        return { proven: true };
      } catch (retryErr) {
        return {
          proven: false,
          reason:
            retryErr instanceof ApiRequestError
              ? retryErr.error.message
              : "We couldn't reach the server.",
        };
      }
    }
  }, [performRefresh, clearSessionState]);

  const handleIdleTimeout = useCallback(async () => {
    if (!accessTokenRef.current && !me) return;
    setSignoutReason(SIGNOUT_REASON_IDLE);
    await logout();
  }, [logout, me]);

  // The warn-modal "Stay signed in" path slides the server window by
  // forcing a refresh round-trip. Failure (e.g. cookie already expired
  // server-side) flushes through the existing refresh-error path.
  const handleIdleWarn = useCallback(async () => {
    await refreshAccessToken();
  }, [refreshAccessToken]);

  const hasRole = useCallback(() => false, []) as (...roles: Role[]) => boolean;

  const loginWithPasskey = useCallback(async () => {
    // Discoverable / username-less flow: the browser shows a passkey
    // picker, the user identifies themselves with the passkey itself,
    // and the server reads the userHandle from the assertion.
    const options = await apiRequest<PublicKeyCredentialRequestOptionsJSON>(
      '/api/v1/auth/passkey/authenticate/start',
      { method: 'POST', auth: false },
    );
    // Zero-knowledge PRF unlock: when the server's start options
    // already carry a `passkey_prf` salt, forward
    // the PRF eval to the authenticator so the assertion returns a PRF result
    // we can unwrap below. Absent a salt the options pass through untouched and
    // `extractPrfResult` returns null → silent password fallback.
    const prfSalt = (options.extensions as { prf?: { eval?: { first?: unknown } } } | undefined)
      ?.prf?.eval?.first;
    const assertionOptions =
      typeof prfSalt === 'string' ? addPrfEvalToOptions(options, prfSalt) : options;
    const response: AuthenticationResponseJSON = await startAuthentication({
      optionsJSON: assertionOptions,
    });
    const result = await apiRequest<LoginResponse>(
      '/api/v1/auth/passkey/authenticate/finish',
      {
        method: 'POST',
        body: { deviceId, response },
        auth: false,
      },
    );
    // Same user-transition guard as the password login path — fails closed via
    // the blocking modal + Retry when the previous user's IDB can't be dropped.
    // The PRF unlock runs as the post-completion step so a Retry replays it too.
    // Retry re-runs the full passkey login so it re-mints the session the
    // blocked-drop revoke killed.
    const didAdopt = await resetThenCompleteLogin(
      result.accessToken,
      null,
      () => {
        // After the session is established, attempt a PRF unlock if the assertion
        // returned a PRF result. Fire-and-forget; failure falls back to password.
        const prfResult = extractPrfResult(response);
        const claims = claimsRef.current;
        // Pass the asserted credential id so tryUnlockWithPrf selects the slot
        // bound to this passkey (credentialBinding match), not the first PRF slot.
        if (prfResult && claims) void tryUnlockWithPrf(claims, prfResult, response.id);
      },
      () => loginWithPasskey(),
    );
    // Blocked cross-user reset (fail-closed): claims not adopted, A's session
    // still active. Bail before merging/persisting B's profile.
    if (!didAdopt) return;
    // Merge + persist the signup profile after the reset/claims adoption,
    // mirroring the password path. No-op for old accounts.
    if (result.firstName || result.lastName || result.birthdate) {
      setMe((prev) =>
        prev
          ? { ...prev, firstName: result.firstName, lastName: result.lastName, birthdate: result.birthdate }
          : prev,
      );
    }
    persistSignupProfile(result);
  }, [deviceId, resetThenCompleteLogin, tryUnlockWithPrf]);

  const registerPasskey = useCallback(
    async (
      currentPassword: string,
      proof?: StepUpProof,
    ): Promise<PasskeyInfo & { noticeSent: boolean }> => {
      const options = await apiRequest<PublicKeyCredentialCreationOptionsJSON>(
        '/api/v1/auth/passkey/register/start',
        { method: 'POST' },
      );
      const response = await startRegistration({ optionsJSON: options });
      // The finish write is gated: the fresh proof
      // rides alongside the attestation in the same request.
      return apiRequest<PasskeyInfo & { noticeSent: boolean }>(
        '/api/v1/auth/passkey/register/finish',
        {
          method: 'POST',
          body: { response, stepUp: { currentPassword, ...stepUpProofFields(proof) } },
        },
      );
    },
    [],
  );

  const listPasskeys = useCallback(
    async (): Promise<PasskeyInfo[]> =>
      apiRequest<PasskeyInfo[]>('/api/v1/auth/passkey/list'),
    [],
  );

  const removePasskey = useCallback(
    async (
      id: string,
      currentPassword: string,
      proof?: StepUpProof,
    ): Promise<{ noticeSent: boolean }> =>
      // Body-bearing `POST … /remove`: the
      // password re-verify baseline is always required; the step-up factor proof
      // rides alongside when `AUTH_MFA_ENFORCED` is on. Mirrors how deleteAccount
      // threads its optional proof.
      apiRequest<{ noticeSent: boolean }>(
        `/api/v1/auth/passkey/${encodeURIComponent(id)}/remove`,
        {
          method: 'POST',
          body: { currentPassword, ...stepUpProofFields(proof) },
        },
      ),
    [],
  );

  const confirmPasskeyRestriction = useCallback(
    async (id: string, proof: StepUpProof): Promise<void> => {
      await apiRequest(
        `/api/v1/auth/passkey/${encodeURIComponent(id)}/confirm-restriction`,
        { method: 'POST', body: stepUpProofFields(proof) },
      );
    },
    [],
  );

  const isPasskeySupported = useCallback(() => browserSupportsWebAuthn(), []);

  const changePassword = useCallback(
    async (
      currentPassword: string,
      newPassword: string,
      proof?: StepUpProof,
    ): Promise<void> => {
      // Offered only on an unlocked workspace:
      // `PasswordChangeCard` already hides the trigger for both states below —
      // this is the belt-and-suspenders guard for any other caller. Every
      // throw in this preparation phase — these guards AND
      // `prepareRewrappedPasswordSlot`'s own throws (a failed envelope fetch,
      // a stale/tampered slot set, a stale session) — happens strictly BEFORE
      // the change-password POST is ever sent, so it is wrapped as
      // {@link PasswordChangeNotSentError}: the change definitely did not
      // happen, distinguishing it from a genuinely lost response after the
      // request left the client (sharing one untyped `Error` and one catch
      // branch on the UI side would tell the
      // user to sign in with a NEW password that was never set server-side).
      let prepared: Awaited<ReturnType<typeof prepareRewrappedPasswordSlot>>;
      try {
        if (needsKeySetup) {
          throw new Error(
            'This account has not finished setting up encryption yet. Set it up before changing your password.',
          );
        }
        if (!isUnlocked) {
          throw new Error('Unlock your data before changing your password.');
        }
        // Verify the current password INTO the session first: a successful
        // `POST /auth/verify-password` stamps the session row's recorded
        // write authority in place (the same in-place grant key setup uses),
        // so a session whose recorded revision is stale or missing — a
        // passwordless-passkey sign-in, a pre-rollout session whose refresh
        // chain never carried one (rotation copies the absence forward
        // unchanged), or one superseded by a password reset — is repaired
        // BEFORE the commit rather than looping on the server's
        // UPGRADE_REQUIRED answer, which the UI renders as a reload prompt
        // reload can never satisfy for these states. After this, an
        // UPGRADE_REQUIRED response genuinely means a stale-bundle request
        // shape, which reloading does fix. A wrong current password throws
        // here (401 INVALID_CREDENTIALS, backoff-counted the same way the
        // change endpoint's own gate would have counted it) — nothing sent.
        // `purpose: 'change_password'` is required:
        // a bare verify-password call is NOT exempt from `LegalAcceptanceGuard`
        // while `/auth/change-password` itself always is, so a legally-stale
        // user's correct-password change would otherwise be blocked here,
        // before ever reaching the endpoint that would have let it through.
        await verifyPassword(currentPassword, { purpose: 'change_password' });
        // Prepare the re-wrapped `password` slot BEFORE the request — it
        // travels IN the change-password body so the server commits the
        // credential and the key together, or `null` for a
        // recovery-only household (the server-confirmed no-slot exception).
        prepared = await prepareRewrappedPasswordSlot(newPassword);
      } catch (err) {
        throw new PasswordChangeNotSentError(
          err instanceof Error ? err.message : 'Could not prepare the password change.',
        );
      }
      const res = await apiRequest<LoginResponse>('/api/v1/auth/change-password', {
        method: 'POST',
        // The step-up factor proof rides alongside the passwords when the flag is
        // on; flag-off is password-only.
        body: {
          currentPassword,
          newPassword,
          ...stepUpProofFields(proof),
          ...(prepared
            ? {
                slot: prepared.slot,
                envelopeSetVersion: prepared.envelopeSetVersion,
                expectedEnvelopeSetVersion: prepared.expectedEnvelopeSetVersion,
                envelopeSetTag: prepared.envelopeSetTag,
              }
            : {}),
        },
      });
      // Server rotated the refresh + CSRF cookies and minted a fresh
      // access token; swap the in-memory token so subsequent requests
      // carry the new jti.
      updateFromToken(res.accessToken);
      // Advance the device rollback pin ONLY after the server confirms the
      // commit — never on a rejection, never off a bare server-served
      // version. This is a POST-COMMIT step: the server already committed
      // the credential, the slot, and the meta row, so a pin-write failure
      // here is never an unknown server outcome. Retry once, and if the pin
      // still cannot be durably advanced, fail CLOSED: a pin left at the
      // predecessor version would accept a later replay of the still-valid
      // old envelope set (it is not below the pin), silently restoring the
      // old password slot — the exact rollback the pin exists to stop. Lock
      // the workspace on this device (the next unlock re-verifies the served
      // set and cannot complete without re-pinning it) and surface the
      // known-committed outcome as its own error type so the UI never shows
      // the "may or may not have gone through" wording for a confirmed 200.
      if (prepared) {
        try {
          await prepared.confirmRewrap();
        } catch {
          try {
            await prepared.confirmRewrap();
          } catch {
            clearUnlockState();
            void clearCachedHdk();
            throw new PasswordChangeCommittedError(
              'Your password was changed, but this device could not finish updating. Unlock your data with your new password to continue.',
            );
          }
        }
      }
    },
    [
      updateFromToken,
      prepareRewrappedPasswordSlot,
      verifyPassword,
      clearUnlockState,
      needsKeySetup,
      isUnlocked,
    ],
  );

  // `verifyPassword` is defined above (the useZeroKnowledgeKey hook depends on
  // it to gate first-time setup on the current account password).

  const deleteAccount = useCallback(
    async (currentPassword: string, proof?: StepUpProof): Promise<void> => {
      await apiRequest('/api/v1/auth/account', {
        method: 'DELETE',
        // The step-up proof rides alongside the password when present. The
        // server DTO's XOR rejects a `code` next to a passkey `response`, so send
        // only the field the chosen factor uses.
        body: {
          currentPassword,
          ...(proof
            ? proof.method === 'passkey'
              ? { method: proof.method, response: proof.response }
              : { method: proof.method, code: proof.code }
            : {}),
        },
      });
      // Server already cleared the refresh + CSRF cookies; mirror that
      // server-side state in the in-memory auth so any UI that reads
      // `me` reacts immediately. The caller drops the IndexedDB and
      // redirects.
      accessTokenRef.current = null;
      claimsRef.current = null;
      setMe(null);
      setHouseholdId(null);
      clearStoredEmail();
      clearUnlockState();
      // Session drop (account deleted): drop any retained sign-in plaintext,
      // close the rewrap prompt, and invalidate any in-flight derive.
      clearRetainedPassword();
      // The caller runs the full local-data nuke (which drops the IDB
      // keyCache); clear the cached HDK here too so the deleted account's key
      // never lingers if the nuke is interrupted.
      void clearCachedHdk();
      // Forget the user-transition baseline too — the deleted account
      // will never sign in again, so retaining the userId would force
      // a redundant DB drop on the next login by an unrelated user.
      clearLastUserId();
    },
    [clearUnlockState, clearRetainedPassword],
  );

  // Self-service email change + account record. Thin `apiRequest` wrappers — all logic lives server-side in
  // ChangeEmailService; bulk client orchestration lives in the AccountCard.
  const fetchAccountRecord = useCallback(
    (opts?: { raiseWaitNotice?: boolean }): Promise<AccountRecord> =>
      opts
        ? apiRequest<AccountRecord>('/api/v1/auth/me', opts)
        : apiRequest<AccountRecord>('/api/v1/auth/me'),
    [],
  );

  const updateAccountRecord = useCallback(
    async (profile: UpdateAccountRecordRequest): Promise<AccountRecord> => {
      const res = await apiRequest<AccountRecord>('/api/v1/auth/me', {
        method: 'PATCH',
        body: profile,
      });
      // Merge the server-returned profile into the in-memory `me` so
      // useAuth().me.firstName/lastName/birthdate agree with the just-saved
      // values everywhere they're read.
      setMe((prev) =>
        prev
          ? {
              ...prev,
              firstName: res.firstName,
              lastName: res.lastName,
              birthdate: res.birthdate,
            }
          : prev,
      );
      return res;
    },
    [],
  );

  const changeEmail = useCallback(
    (newEmail: string, currentPassword: string): Promise<ChangeEmailRequestResult> =>
      apiRequest<ChangeEmailRequestResult>('/api/v1/auth/change-email/request', {
        method: 'POST',
        body: { newEmail, currentPassword },
      }),
    [],
  );

  const sendEmailChangeOtp = useCallback(async (): Promise<void> => {
    await apiRequest('/api/v1/auth/change-email/send-otp', { method: 'POST' });
  }, []);

  const verifyEmailChangeStepUp = useCallback(
    (
      method: string,
      code: string,
      response?: AuthenticationResponseJSON,
    ): Promise<ChangeEmailStepUpResult> =>
      apiRequest<ChangeEmailStepUpResult>('/api/v1/auth/change-email/verify-step-up', {
        method: 'POST',
        // Passkey carries `response` and no `code` (the server DTO's XOR rejects
        // a code alongside a passkey); code factors carry `code` only.
        body: method === 'passkey' ? { method, response } : { method, code },
      }),
    [],
  );

  const stepUpPasskeyOptions = useCallback(
    (purpose: StepUpPurpose): Promise<PublicKeyCredentialRequestOptionsJSON> =>
      apiRequest<PublicKeyCredentialRequestOptionsJSON>(
        '/api/v1/auth/step-up/passkey/options',
        { method: 'POST', body: { purpose } },
      ),
    [],
  );

  const stepUpSendEmailOtp = useCallback(
    async (purpose: StepUpPurpose): Promise<void> => {
      await apiRequest('/api/v1/auth/step-up/email-otp/send', {
        method: 'POST',
        body: { purpose },
      });
    },
    [],
  );

  const confirmEmailChange = useCallback(
    (token: string): Promise<{ email: string }> =>
      // Public route (clicked from the new inbox, possibly another browser): no
      // bearer, no CSRF cookie. The change-email token is the identity proof.
      apiRequest<{ changed: boolean; email: string }>(
        '/api/v1/auth/change-email/confirm',
        { method: 'POST', body: { token }, auth: false },
      ).then((res) => ({ email: res.email })),
    [],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      me,
      isAuthenticated: !!me,
      isBooting,
      householdId,
      deviceId,
      isUnlocked,
      needsKeySetup,
      unlockResolved,
      hasPasskeyPrfSlot,
      lockedEnvelopeSetEmpty,
      getHdk,
      unlockWithPassword,
      unlockWithRecovery,
      unlockWithPasskey,
      setupEncryption,
      signup,
      verifyEmail,
      resendVerification,
      requestPasswordReset,
      resetPassword,
      login,
      mfaChallenge,
      verifyMfa,
      verifyMfaWithPasskey,
      sendEmailOtp,
      clearMfaChallenge,
      getMfaStatus: mfa.getMfaStatus,
      enrollTotpStart: mfa.enrollTotpStart,
      enrollTotpConfirm: mfa.enrollTotpConfirm,
      disableTotp: mfa.disableTotp,
      confirmTotpRestriction: mfa.confirmTotpRestriction,
      listTrustedDevices: mfa.listTrustedDevices,
      forgetDevices: mfa.forgetDevices,
      logout,
      signOutForDeviceClear,
      loginWithPasskey,
      registerPasskey,
      listPasskeys,
      removePasskey,
      confirmPasskeyRestriction,
      isPasskeySupported,
      enrollPasskeyForEncryption,
      regenerateRecoveryKey,
      recacheHdk,
      hasRole,
      changePassword,
      verifyPassword,
      deleteAccount,
      fetchAccountRecord,
      updateAccountRecord,
      changeEmail,
      sendEmailChangeOtp,
      verifyEmailChangeStepUp,
      stepUpPasskeyOptions,
      stepUpSendEmailOtp,
      confirmEmailChange,
      refreshAccessToken,
    }),
    [
      me,
      isBooting,
      householdId,
      deviceId,
      isUnlocked,
      needsKeySetup,
      unlockResolved,
      hasPasskeyPrfSlot,
      lockedEnvelopeSetEmpty,
      getHdk,
      unlockWithPassword,
      unlockWithRecovery,
      unlockWithPasskey,
      setupEncryption,
      signup,
      verifyEmail,
      resendVerification,
      requestPasswordReset,
      resetPassword,
      login,
      mfaChallenge,
      verifyMfa,
      verifyMfaWithPasskey,
      sendEmailOtp,
      clearMfaChallenge,
      mfa,
      logout,
      signOutForDeviceClear,
      loginWithPasskey,
      registerPasskey,
      listPasskeys,
      removePasskey,
      confirmPasskeyRestriction,
      isPasskeySupported,
      enrollPasskeyForEncryption,
      regenerateRecoveryKey,
      recacheHdk,
      hasRole,
      changePassword,
      verifyPassword,
      deleteAccount,
      fetchAccountRecord,
      updateAccountRecord,
      changeEmail,
      sendEmailChangeOtp,
      verifyEmailChangeStepUp,
      stepUpPasskeyOptions,
      stepUpSendEmailOtp,
      confirmEmailChange,
      refreshAccessToken,
    ],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      <IdleTimer
        enabled={idleConfig.enabled && !!me}
        idleMs={idleConfig.idleMs}
        warnLeadMs={idleConfig.warnLeadMs}
        onWarn={handleIdleWarn}
        onTimeout={handleIdleTimeout}
      />
      {/* Fail-closed cross-user reset: blocking modal
          shown when the previous account's IDB could not be dropped because
          another tab holds it open. Retry re-attempts the drop + login. */}
      <LocalResetRequiredModal
        open={blockedReset !== null}
        onRetry={() => blockedReset?.retry() ?? Promise.resolve()}
      />
      {/* Derived post-reset re-wrap prompt:
          shown when the derive finds a re-wrap owed and no plaintext
          already in hand. Rendered app-level (never inside LoginPage's
          unlock form) because the cached-key auto-unlock that most often
          triggers it never renders that form at all. */}
      <PasswordRewrapPrompt
        state={rewrapPrompt}
        email={me?.email ?? ''}
        onSubmit={answerRewrapPrompt}
        onDismiss={dismissRewrapPrompt}
      />
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** AuthContext-level binding: parse the JWT, then dispatch to the testable core. */
async function maybeResetForNewUser(accessToken: string): Promise<void> {
  await maybeResetForNewUserCore(decodeJwt(accessToken), transitionDeps);
}
