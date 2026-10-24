// Client-side auth state: signup, email verify, login (password, passkey, MFA), refresh, logout and password change.
// The access token lives in memory and the refresh token is an HTTP-only cookie, so a reload runs the boot refresh.
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
} from './session-storage';

// Two-step login challenge (enforced MFA), returned instead of a session on an untrusted device: a 5-min challenge
// token plus `methods` (strongest first) and the `recoveryMethods` fallback. No claims are adopted until `POST
// /auth/mfa/verify`. See docs/security.md "The second factor".
interface MfaLoginResponse {
  mfaRequired: true;
  challengeToken: string;
  methods: string[];
  recoveryMethods: string[];
}

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

// Transient-refresh cooldown. `/auth/refresh` is non-idempotent (rotate + revoke) and never client-retried. After a
// transient failure (network, abort, 5xx, 429, non-401 4xx; session kept) any refresh within this window returns `null`
// without POSTing, so the second leg of a flush/pull sequence cannot replay a possibly-rotated cookie. Well under the
// ~30s poll cadence. A success clears it; a definitive 401 tears down the session and does not arm it.
const TRANSIENT_REFRESH_COOLDOWN_MS = 5_000;

// One `/auth/refresh` attempt. `definitive` is true only for the session-over 401s (`INVALID_REFRESH_TOKEN`,
// `REFRESH_TOKEN_REUSED`); everything else (network, 5xx, 429, other 4xx, cooldown) keeps the session with `token`
// null. `signOutForDeviceClear` needs the verdict from its own attempt; the shared in-flight dedupe makes a concurrent
// refresh resolve to the same promise.
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
   * True once the household data key (HDK) is in memory, from the device cache or an unlock; {@link
   * AuthContextValue.getHdk} returns null otherwise.
   */
  isUnlocked: boolean;
  /** True when authenticated but no key envelope exists yet: the encrypted-workspace setup flow keys the household. */
  needsKeySetup: boolean;
  /**
   * True once {@link initializeUnlockState} settled after login; gates the LoginPage unlock prompt so it does not flash
   * while the unlock flags are transiently false. Reset on logout and new sign-in.
   */
  unlockResolved: boolean;
  /**
   * True once the post-login envelope fetch found a `passkey_prf` slot (one per household); drives the LoginPage
   * "Unlock with passkey" button.
   */
  hasPasskeyPrfSlot: boolean;
  /**
   * True when the post-login fetch was served an empty slot set on a device with evidence of a real key (cached HDK or
   * non-zero pin): why the locked screen shows instead of first-time setup.
   */
  lockedEnvelopeSetEmpty: boolean;
  /** Stable accessor for the in-memory HDK, threaded to SyncProvider. */
  getHdk(): CryptoKey | null;
  /**
   * Recovers the HDK from the password slot, verifies the envelope-set tag, holds it in memory and caches it. Throws on
   * a wrong password, a missing or invalid slot, or a tamper-detected set.
   */
  unlockWithPassword(password: string): Promise<void>;
  /** As {@link unlockWithPassword}, from the recovery slot and the grouped recovery-key display string. */
  unlockWithRecovery(recoveryKey: string): Promise<void>;
  /**
   * User-initiated passkey-PRF unlock: a targeted assertion against the `passkey_prf` slot, then as {@link
   * unlockWithPassword}. Throws on no PRF slot, no PRF result, or a tamper-detected set.
   */
  unlockWithPasskey(): Promise<void>;
  /**
   * First-time encryption setup: wraps a new HDK in a password and a recovery slot, activates both atomically, holds
   * and caches the HDK, and returns the grouped recovery-key display string to show once in {@link RecoveryKeyModal}. A
   * retry after a partial failure repairs the missing slot; throws `SetupStepUpRequiredError` when the repair needs a
   * fresh factor and `proof` is omitted.
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
  /**
   * Requests a reset link (opaque 202, never reveals whether the email exists). See docs/security.md "Password change,
   * password reset".
   */
  requestPasswordReset(email: string): Promise<RequestPasswordResetResponse>;
  /**
   * Consumes a reset token to set a new password (204). Reset does not unlock encrypted data; whether a re-wrap is owed
   * is derived at the next unlock.
   */
  resetPassword(token: string, newPassword: string): Promise<void>;
  login(email: string, password: string): Promise<void>;
  /**
   * The pending two-step MFA challenge, non-null after a password login on an untrusted device; the LoginPage renders
   * {@link MfaChallengeForm} until it is verified or cleared via {@link clearMfaChallenge}.
   */
  mfaChallenge: MfaChallengeState | null;
  /**
   * Completes the pending challenge with the chosen factor and adopts the session (the post-reset ZK unlock still fires
   * on the password retained from the password step). `rememberDevice` applies to a routine factor only. Throws
   * ApiRequestError (e.g. `MFA_CODE_INVALID`) on a wrong or expired code.
   */
  verifyMfa(
    method: string,
    code: string,
    rememberDevice: boolean,
  ): Promise<VerifyMfaResult>;
  /**
   * Completes the challenge with a passkey as second factor: scoped start options, WebAuthn assertion, POST to
   * `mfa/verify`, then the same retained-password ZK-unlock path. `rememberDevice` mints ~30-day device trust. Throws
   * ApiRequestError on rejection and rethrows a WebAuthn cancel or timeout so the form shows non-alarming retry copy.
   * The retained password is cleared on every exit.
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
   * Sign-out for "Clear data on this device". Unlike {@link logout} (best-effort, always tears down) it reports whether
   * the server session is provably gone as a result of this attempt (`/auth/logout` 2xx, or a definitive refresh-cookie
   * rejection while it ran) and clears local auth state only on that proof: a bare 401 can come from a transient
   * refresh failure or the cooldown with a live session behind it, so those report `proven: false`.
   */
  signOutForDeviceClear(): Promise<DeviceClearAttempt>;
  /** Passkey flows; `loginWithPasskey` is username-less (the browser's picker identifies the user). */
  loginWithPasskey(): Promise<void>;
  /**
   * Registers a passkey. The account password is always re-verified, plus a fresh `proof` when `AUTH_MFA_ENFORCED` is
   * on. `noticeSent`: whether the factor-change notice mail went out (the card claims "we emailed you" only then).
   */
  registerPasskey(
    currentPassword: string,
    proof?: StepUpProof,
  ): Promise<PasskeyInfo & { noticeSent: boolean }>;
  listPasskeys(): Promise<PasskeyInfo[]>;
  /**
   * Removes a passkey behind a password re-verify (+ `proof` when `AUTH_MFA_ENFORCED` is on); body-bearing POST.
   * `noticeSent` as in `registerPasskey`.
   */
  removePasskey(
    id: string,
    currentPassword: string,
    proof?: StepUpProof,
  ): Promise<{ noticeSent: boolean }>;
  /**
   * Lifts a passkey's post-reset restriction; the proof must come from a different, already-enrolled, non-restricted
   * factor that predates the reset (`totp` or `passkey`).
   */
  confirmPasskeyRestriction(id: string, proof: StepUpProof): Promise<void>;
  isPasskeySupported(): boolean;
  /**
   * Enrolls a passkey as an encryption-unlock method (see useZeroKnowledgeKey.enrollPasskeyForEncryption). Needs an
   * unlocked session; `currentPassword` is the password floor every enrollment carries, `proof` the fresh factor
   * required only when `AUTH_MFA_ENFORCED` is on.
   */
  enrollPasskeyForEncryption(
    credentialId: string,
    currentPassword: string,
    proof?: StepUpProof,
  ): Promise<void>;
  /**
   * Prepares a two-phase recovery-key regeneration: re-auth with the account password, mint a fresh `recovery` slot
   * without persisting it, return the display string (shown once in {@link RecoveryKeyModal}) and an `activate` thunk.
   * The old key keeps working until `activate()`; never calling it leaves it intact. Prepare throws on a wrong password
   * or tampered set, `activate()` on a write failure. See docs/security.md "The three unlock slots".
   */
  regenerateRecoveryKey(
    password: string,
  ): Promise<{ recoveryKey: string; activate: (proof?: StepUpProof) => Promise<void> }>;
  /**
   * Re-caches the in-memory HDK after an operation that wipes `keyCache` but keeps the session (snapshot restore,
   * "Reload from server"). Best-effort: no-ops when locked and swallows an IDB write failure.
   */
  recacheHdk(): Promise<void>;
  /** Stubbed; v1 has no roles (always false). Kept for legacy callers. */
  hasRole(...roles: Role[]): boolean;
  changePassword(
    currentPassword: string,
    newPassword: string,
    proof?: StepUpProof,
  ): Promise<void>;
  /**
   * Side-effect-free password re-auth; throws ApiRequestError `INVALID_CREDENTIALS` on a mismatch. `purpose` routes the
   * audit event (`data_export` for the export gate) or marks the call for `LegalAcceptanceGuard`'s body-purpose
   * exemption (`change_password`, `password_slot_rewrap`); every purpose also repairs the current session's recorded
   * write authority in place. Omitted by import/demo re-auth.
   */
  verifyPassword(
    currentPassword: string,
    opts?: { purpose?: 'data_export' | 'change_password' | 'password_slot_rewrap' },
  ): Promise<void>;
  /**
   * Permanently deletes the account, with a fresh step-up `proof` when `AUTH_MFA_ENFORCED` is on. The caller does the
   * client-side cleanup (`dropLocalDatabase` + redirect).
   */
  deleteAccount(currentPassword: string, proof?: StepUpProof): Promise<void>;
  /**
   * `GET /auth/me`. `raiseWaitNotice: false` keeps a throttled background check from raising the shared "Please wait"
   * toast for a request the person never made.
   */
  fetchAccountRecord(opts?: { raiseWaitNotice?: boolean }): Promise<AccountRecord>;
  /**
   * Corrects `firstName`/`lastName`/`birthdate` (`PATCH /auth/me`); session-only, no password re-entry or step-up.
   * Returns the server's projection.
   */
  updateAccountRecord(profile: UpdateAccountRecordRequest): Promise<AccountRecord>;
  /**
   * Starts a verified email change (`POST /auth/change-email/request`) after re-auth with the current password; returns
   * whether a fresh MFA factor is still required.
   */
  changeEmail(
    newEmail: string,
    currentPassword: string,
  ): Promise<ChangeEmailRequestResult>;
  /** Send a fresh Email-OTP for the pending change-email step-up. */
  sendEmailChangeOtp(): Promise<void>;
  /**
   * Verifies a fresh MFA factor for the pending change; on success the verification link is mailed to the new address.
   * A passkey rides in `response`, code factors in `code`.
   */
  verifyEmailChangeStepUp(
    method: string,
    code: string,
    response?: AuthenticationResponseJSON,
  ): Promise<ChangeEmailStepUpResult>;
  /**
   * Purpose-scoped WebAuthn step-up options (`POST /auth/step-up/passkey/options`) for the reusable step-up flow's
   * passkey factor.
   */
  stepUpPasskeyOptions(
    purpose: StepUpPurpose,
  ): Promise<PublicKeyCredentialRequestOptionsJSON>;
  /**
   * Emails a purpose-bound step-up code (`POST /auth/step-up/email-otp/send`); change-email keeps its own
   * `sendEmailChangeOtp`.
   */
  stepUpSendEmailOtp(purpose: StepUpPurpose): Promise<void>;
  /** Consumes the change-email verification token (public, no session) and returns the new email. */
  confirmEmailChange(token: string): Promise<{ email: string }>;
  /**
   * Force-refreshes the access token; null when the refresh cookie is missing or expired (auth state is cleared). Lets
   * the SyncProvider transport mirror `apiRequest`'s 401-refresh-retry.
   */
  refreshAccessToken(): Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const accessTokenRef = useRef<string | null>(null);
  const claimsRef = useRef<JwtClaims | null>(null);
  // Arms the transient-refresh cooldown for sequential callers (`inflightRefreshRef` handles concurrent ones); cleared
  // in `updateFromToken`, so declared above it.
  const transientRefreshFailedAtRef = useRef<number | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [isBooting, setIsBooting] = useState(true);
  const [deviceId] = useState<string>(() => readOrInitDeviceId());
  // Set when a cross-user IDB reset failed closed (another tab held the IDB open): shows LocalResetRequiredModal, whose
  // `retry` re-attempts the drop and login once the other tabs are closed.
  const [blockedReset, setBlockedReset] = useState<{ retry: () => Promise<void> } | null>(null);
  // Pending two-step MFA challenge (5-min token and offered factors), non-null between an untrusted-device password
  // login and a successful `verifyMfa`; no claims are adopted meanwhile. Cleared on verify success, back-out and
  // logout.
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallengeState | null>(null);
  // The password typed at the MFA-challenged login, in memory only until `verifyMfa` adopts the session, so the
  // post-login ZK unlock uses the password the user just signed in with. Cleared on verify success, back-out and
  // logout.
  const mfaPasswordRef = useRef<string | null>(null);

  const mfa = useMfaManagement();

  // Zero-knowledge unlock state lives in useZeroKnowledgeKey. It needs `verifyPassword` (to gate setup on the current
  // password) and `claimsRef` (to drop a stale household's result on a mid-flight switch).
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

  // Derived post-reset re-wrap (useDerivedRewrap): retains the plaintext this session's sign-in accepted for the unlock
  // window and, on every unlock transition (the effect below), derives whether the `password` slot needs re-wrapping,
  // then re-wraps silently or prompts.
  const {
    retainPassword,
    clearRetainedPassword,
    runDerive,
    prompt: rewrapPrompt,
    answerPrompt: answerRewrapPrompt,
    dismissPrompt: dismissRewrapPrompt,
  } = useDerivedRewrap({ getHdk, rotatePasswordSlot, verifyPassword, takeLastUnlockEnvelopes });

  // Run the derive on the rising edge of `isUnlocked`: every unlock path (cached key, PRF, explicit) flips it the same
  // way.
  const wasUnlockedRef = useRef(false);
  useEffect(() => {
    if (isUnlocked && !wasUnlockedRef.current) runDerive();
    wasUnlockedRef.current = isUnlocked;
  }, [isUnlocked, runDerive]);

  const { requestPasswordReset, resetPassword } = usePasswordResetClient();

  const updateFromToken = useCallback((token: string) => {
    accessTokenRef.current = token;
    // Any valid token (login, passkey, refresh) means the session is live: disarm the transient-refresh cooldown so a
    // fresh login is not throttled by an earlier blip.
    transientRefreshFailedAtRef.current = null;
    const claims = decodeJwt(token);
    // Only a genuine new session or user switch resets unlock state. A silent refresh for the same user and household
    // keeps the in-memory HDK and flags: clearing would drop the HDK, and a failed re-init fetch (network blip) would
    // strand an authenticated user with getHdk() === null.
    const prev = claimsRef.current;
    const sameSession =
      !!prev &&
      !!claims &&
      prev.userId === claims.userId &&
      prev.householdId === claims.householdId;
    claimsRef.current = claims;
    if (!sameSession) {
      // Drop the previous session's HDK before adopting the new claims; initializeUnlockState loads the new user's
      // cached key.
      clearUnlockState();
    }
    if (claims) {
      setHouseholdId(claims.householdId);
      const email = claims.email ?? readStoredEmail();
      setMe({
        id: claims.userId,
        email,
        displayName: email,
        roles: [],
      });
      if (!sameSession) void initializeUnlockState(claims);
    }
  }, [clearUnlockState, initializeUnlockState]);

  // Boot-refresh guard for a blocked cross-user reset: the previous login showed the blocking modal because the old
  // user's IDB drop (and maybe the new user's session revoke) failed, so the new user's refresh cookie can survive into
  // this reload. When the refreshed token's userId matches the persisted marker, retry the drop before claims are
  // adopted; on a repeat failure re-show the modal (Retry re-runs the boot refresh) and withhold the claims. Returns
  // true when the caller may adopt the token.
  const guardBlockedReset = useCallback(
    async (accessToken: string): Promise<boolean> => {
      const pending = readBlockedResetMarker();
      if (!pending) return true;
      const tokenUserId = decodeJwt(accessToken)?.userId;
      // A different user (or an undecodable token) is unrelated to the pending block: clear the stale marker.
      if (tokenUserId !== pending) {
        clearBlockedResetMarker();
        return true;
      }
      try {
        await maybeResetForNewUser(accessToken);
      } catch {
        // Still blocked: keep the marker, withhold the claims, re-show the modal; Retry re-enters this guard via the
        // boot refresh.
        setBlockedReset({ retry: () => refreshAccessTokenRef.current().then(() => undefined) });
        return false;
      }
      clearBlockedResetMarker();
      setBlockedReset(null);
      return true;
    },
    [],
  );

  // Late-bound ref: refreshAccessToken calls guardBlockedReset, whose failure path needs refreshAccessToken back
  // (mutual recursion), so one side must read through a ref.
  const refreshAccessTokenRef = useRef<() => Promise<string | null>>(
    () => Promise.resolve(null),
  );

  // Concurrent refreshes would each rotate the same refresh token and the second trips the server's reuse detection;
  // dedupe to one in-flight promise (React dev double-mount, parallel 401 retries).
  const inflightRefreshRef = useRef<Promise<RefreshOutcome> | null>(null);
  const performRefresh = useCallback(async (): Promise<RefreshOutcome> => {
    if (inflightRefreshRef.current) return inflightRefreshRef.current;
    // Cooldown: a refresh that transient-failed within the window returns null without POSTing, so a second sync leg
    // cannot replay a possibly-rotated cookie. Session state stays as the earlier failure left it.
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
          // No wait notice at the shared seam for /auth/refresh: it keeps its own single-attempt cooldown.
          raiseWaitNotice: false,
        });
        // Honor a pending blocked-reset marker before adopting the token: a surviving refresh cookie must not expose
        // the new user's household over the previous user's stale IDB.
        if (!(await guardBlockedReset(res.accessToken))) return { token: null, definitive: false };
        updateFromToken(res.accessToken);
        transientRefreshFailedAtRef.current = null;
        return { token: res.accessToken, definitive: false };
      } catch (err) {
        // Definitive sign-out iff a 401 from /auth/refresh (INVALID_REFRESH_TOKEN / REFRESH_TOKEN_REUSED). Anything
        // else (network, abort, 5xx, 429, other 4xx) is transient: the session is kept and the caller treats the
        // original 401 as retryable. The non-idempotent refresh is never client-retried.
        const definitive = err instanceof ApiRequestError && err.status === 401;
        if (!definitive) {
          // Transient: arm the cooldown and leave session and unlock state untouched.
          transientRefreshFailedAtRef.current = Date.now();
          return { token: null, definitive: false };
        }
        accessTokenRef.current = null;
        claimsRef.current = null;
        setMe(null);
        setHouseholdId(null);
        clearUnlockState();
        // No cooldown: there is no session left to protect.
        transientRefreshFailedAtRef.current = null;
        // The unlock window is over: drop the retained plaintext, close the rewrap prompt, invalidate any in-flight
        // derive.
        clearRetainedPassword();
        return { token: null, definitive: true };
      } finally {
        inflightRefreshRef.current = null;
      }
    })();
    inflightRefreshRef.current = promise;
    return promise;
  }, [updateFromToken, guardBlockedReset, clearUnlockState, clearRetainedPassword]);

  // Public refresher shape (`Promise<string | null>`); `signOutForDeviceClear` reads the `definitive` verdict from
  // `performRefresh` directly.
  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    const { token } = await performRefresh();
    return token;
  }, [performRefresh]);

  refreshAccessTokenRef.current = refreshAccessToken;

  // Bounded lifetime for the retained challenge password (CWE-316): explicit exits clear `mfaPasswordRef` inline; this
  // closes the window for a challenge that clears any other way. Not cleared in the cleanup, which would wipe the
  // password `login` sets in the same render that flips `mfaChallenge` non-null.
  useEffect(() => {
    if (mfaChallenge === null) mfaPasswordRef.current = null;
  }, [mfaChallenge]);

  // Mount-only: clear the retained challenge password if the provider unmounts.
  useEffect(() => {
    return () => {
      mfaPasswordRef.current = null;
    };
  }, []);

  const idleConfig = useMemo(() => resolveIdleConfig(), []);

  useEffect(() => {
    let active = true;
    configureApi({ getAccessToken: () => accessTokenRef.current, refreshAccessToken });

    // Boot-after-idle: skip the refresh round-trip (it would fail anyway) so the login page does not flash "signed in"
    // first.
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
        // Only supplied profile fields ride along; the server rejects unknown fields.
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

  // Finishes a login once the cross-user IDB drop succeeded; shared by the password and passkey paths and the
  // blocked-reset Retry so the post-drop steps stay identical.
  const completeLoginAfterReset = useCallback(
    (accessToken: string, password: string | null): void => {
      // Seed activity before updateFromToken sets `me` (which enables IdleTimer), or its enable-effect could read a
      // stale timestamp and fire the idle timeout at once.
      writeLastActivityAt(Date.now());
      // Clear a lingering idle-signout reason from the previous session.
      consumeSignoutReason();
      // Retain the plaintext this sign-in accepted on every password sign-in (owed-ness is derived server-side, not
      // remembered), before updateFromToken so it is in place when the `isUnlocked` effect fires the derive. Passkey
      // login and a passkey-factor MFA verify pass null.
      if (password !== null) retainPassword(password);
      updateFromToken(accessToken);
    },
    [updateFromToken, retainPassword],
  );

  // Runs the cross-user IDB reset, then finishes the login. If the reset fails closed (another tab holds the IDB past
  // the blocked-delete timeout) the new claims are not adopted: a blocking modal's Retry re-authenticates via `reauth`
  // (the just-issued session was revoked) once the other tabs are closed. Returns true when claims were adopted; false
  // on a blocked reset, in which case callers must not merge the new user's PII into the previous user's still-active
  // session.
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
        // Fail closed: never adopt the new user B's claims, but the login already set B's refresh cookie. Persist the
        // blocked-reset marker (B's userId) before the revoke attempt so it survives even if the revoke throws:
        // otherwise a reload would refresh with B's cookie and expose B's household over A's stale IDB rows.
        const newUserId = decodeJwt(accessToken)?.userId;
        if (newUserId) writeBlockedResetMarker(newUserId);
        // Best-effort logout as B (swap the access-token ref so bearer and cookie name the same session) to revoke B's
        // refresh cookie and denylist B's access token.
        const prevToken = accessTokenRef.current;
        accessTokenRef.current = accessToken;
        try {
          await apiRequest('/api/v1/auth/logout', { method: 'POST' });
        } catch {
          // Best-effort: the modal still shows, and the blocked-reset marker covers a reload if the cookie survived.
        } finally {
          accessTokenRef.current = prevToken;
        }
        // Retry re-authenticates from scratch via `reauth` (the revoke killed the captured session); without one it
        // replays this continuation.
        setBlockedReset({
          retry: reauth ?? (() => resetThenCompleteLogin(accessToken, password, onComplete).then(() => undefined)),
        });
        return false;
      }
      clearBlockedResetMarker();
      setBlockedReset(null);
      completeLoginAfterReset(accessToken, password);
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
    // An untrusted device gets an MFA challenge, not a session: hold the typed password in memory so the post-verify
    // adoption can drive the ZK unlock on it. No claims are adopted until `verifyMfa`.
    if ('mfaRequired' in res) {
      mfaPasswordRef.current = password;
      setMfaChallenge({
        challengeToken: res.challengeToken,
        methods: res.methods,
        recoveryMethods: res.recoveryMethods,
      });
      return;
    }
    // Drop the IDB working store before exposing the new claims when the device's last user differs: it is not keyed by
    // householdId, so `listAggregates` would return the previous user's data. Same-user re-login keeps the cache; Retry
    // re-runs the full login to re-mint the session the blocked-drop revoke killed.
    await resetThenCompleteLogin(res.accessToken, password, undefined, () =>
      login(email, password),
    );
  }, [deviceId, resetThenCompleteLogin]);

  // Shared tail of both MFA verify paths: adopt the session through the same cross-user-reset and ZK-unlock path as
  // direct login, using the password retained from the password step. The retained password is cleared on every exit; a
  // blocked reset clears the overlay and challenge so the user lands on the sign-in form.
  const adoptMfaSession = useCallback(
    async (
      res: LoginResponse & { deviceRemembered: boolean },
    ): Promise<VerifyMfaResult> => {
      const retained = mfaPasswordRef.current;
      const didAdopt = await resetThenCompleteLogin(res.accessToken, retained, undefined, async () => {
        setBlockedReset(null);
        mfaPasswordRef.current = null;
        setMfaChallenge(null);
      });
      mfaPasswordRef.current = null;
      setMfaChallenge(null);
      return { deviceRemembered: didAdopt && res.deviceRemembered };
    },
    [resetThenCompleteLogin],
  );

  // Verifies the chosen factor server-side and, on success, adopts the returned session via adoptMfaSession. Returns
  // whether the device was remembered, for the LoginPage's "trusted" note.
  const verifyMfa = useCallback(
    async (
      method: string,
      code: string,
      rememberDevice: boolean,
    ): Promise<VerifyMfaResult> => {
      const challenge = mfaChallenge;
      if (!challenge) {
        // Defensive: a double-submit after success.
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
      return adoptMfaSession(res);
    },
    [mfaChallenge, deviceId, adoptMfaSession],
  );

  // Passkey as second factor: fetch the user-scoped start options, run the assertion, POST it to mfa/verify and adopt
  // via adoptMfaSession. The retained password is cleared on every exit so the long async passkey window can't strand
  // it (CWE-316).
  const verifyMfaWithPasskey = useCallback(
    async (rememberDevice: boolean): Promise<VerifyMfaResult> => {
      const challenge = mfaChallenge;
      if (!challenge) {
        // Defensive: a double-submit after success.
        throw new Error('No MFA challenge is pending.');
      }
      let response: AuthenticationResponseJSON;
      try {
        const options = await apiRequest<PublicKeyCredentialRequestOptionsJSON>(
          '/api/v1/auth/mfa/passkey/start',
          { method: 'POST', body: { challengeToken: challenge.challengeToken }, auth: false },
        );
        // No PRF eval: post-login unlock rides the retained password, like the code factors.
        response = await startAuthentication({ optionsJSON: options });
      } catch (err) {
        // A WebAuthn rejection (cancel, timeout, NotAllowedError, SecurityError) or a failed start: clear the password
        // and rethrow so the form shows non-alarming retry copy.
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
        // Server rejected the assertion (bad or expired challenge, UV/counter anomaly): clear the password and rethrow
        // for the form to map.
        mfaPasswordRef.current = null;
        throw err;
      }

      return adoptMfaSession(res);
    },
    [mfaChallenge, deviceId, adoptMfaSession],
  );

  // The server names the user from the challenge token; the SPA only forwards it.
  const sendEmailOtp = useCallback(async (): Promise<void> => {
    const challenge = mfaChallenge;
    if (!challenge) throw new Error('No MFA challenge is pending.');
    await apiRequest('/api/v1/auth/mfa/email/send', {
      method: 'POST',
      body: { challengeToken: challenge.challengeToken },
      auth: false,
    });
  }, [mfaChallenge]);

  // No session was ever issued, so there is nothing to revoke: drop the local state and the retained password.
  const clearMfaChallenge = useCallback((): void => {
    mfaPasswordRef.current = null;
    setMfaChallenge(null);
  }, []);

  // The local teardown `logout()` runs unconditionally, factored out so signOutForDeviceClear can run it only once the
  // server session is provably gone. Every step is an idempotent clear, so it is safe after `performRefresh` already
  // tore part of it down.
  const clearSessionState = useCallback((): void => {
    accessTokenRef.current = null;
    claimsRef.current = null;
    setMe(null);
    setHouseholdId(null);
    clearStoredEmail();
    clearActivityTimestamp();
    clearUnlockState();
    mfaPasswordRef.current = null;
    setMfaChallenge(null);
    clearRetainedPassword();
    // The cached HDK in IDB is deliberately not cleared on a bare same-user logout: it persists for fast re-login like
    // the plaintext aggregates it decrypts, so clearing only the key would be theater. The authoritative teardown is
    // the centralized IDB drop (cross-user guard, "Clear data on this device", account deletion); the in-memory HDK is
    // always dropped here.
  }, [clearUnlockState, clearRetainedPassword]);

  const logout = useCallback(async () => {
    try {
      await apiRequest('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // Best-effort; we always clear local state.
    }
    clearSessionState();
  }, [clearSessionState]);

  // A bare 401 from /auth/logout does not prove the session is gone, so the shared client's retry-on-401 is bypassed
  // (`retryOn401: false`) and the verdict is classified here: only `performRefresh`'s `definitive` result, or a
  // fresh-token retry of the sign-out, counts as proof.
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
        // The refresh cookie was definitively rejected during this attempt; performRefresh already tore down token and
        // unlock state, so finish the logout teardown.
        clearSessionState();
        return { proven: true };
      }
      if (!token) {
        // Transient failure or cooldown: the session is preserved and this attempt cannot prove it is gone.
        return {
          proven: false,
          reason: "We couldn't confirm your session was signed out.",
        };
      }
      // Refresh succeeded, so the session is alive: retry the sign-out once.
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

  // "Stay signed in" slides the server window by forcing a refresh round-trip.
  const handleIdleWarn = useCallback(async () => {
    await refreshAccessToken();
  }, [refreshAccessToken]);

  const hasRole = useCallback(() => false, []) as (...roles: Role[]) => boolean;

  const loginWithPasskey = useCallback(async () => {
    // Discoverable username-less flow: the browser's passkey picker identifies the user; the server reads the
    // userHandle from the assertion.
    const options = await apiRequest<PublicKeyCredentialRequestOptionsJSON>(
      '/api/v1/auth/passkey/authenticate/start',
      { method: 'POST', auth: false },
    );
    // If the start options carry a `passkey_prf` salt, forward the PRF eval so the assertion returns a result to unwrap
    // below; without a salt `extractPrfResult` returns null and the password path takes over.
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
    // Same user-transition guard as the password login (blocking modal + Retry on a blocked drop). The PRF unlock is
    // the post-completion step so a Retry replays it, and Retry re-runs the full passkey login to re-mint the revoked
    // session.
    await resetThenCompleteLogin(
      result.accessToken,
      null,
      () => {
        // Fire-and-forget PRF unlock once the session is established; failure falls back to the password.
        const prfResult = extractPrfResult(response);
        const claims = claimsRef.current;
        // Pass the asserted credential id so the slot bound to this passkey is selected, not the first PRF slot.
        if (prfResult && claims) void tryUnlockWithPrf(claims, prfResult, response.id);
      },
      () => loginWithPasskey(),
    );
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
      // The finish write is gated: the fresh proof rides with the attestation.
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
      // Body-bearing POST: the password re-verify is always required, with the step-up proof alongside when
      // `AUTH_MFA_ENFORCED` is on.
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
      // Every throw in this preparation phase (these guards and `prepareRewrappedPasswordSlot`'s) happens before the
      // change-password POST is sent, so it is wrapped as PasswordChangeNotSentError: the change definitely did not
      // happen, unlike a lost response after the request left the client, which would otherwise read as "sign in with
      // the new password". `PasswordChangeCard` already hides the trigger when locked or unkeyed; these guards cover
      // any other caller.
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
        // Verify the current password into the session first: `verify-password` stamps the session's recorded write
        // authority in place, repairing a stale or missing one (passkey sign-in, a refresh chain that never carried
        // one, a session superseded by a reset) before the commit instead of looping on UPGRADE_REQUIRED, which renders
        // a reload prompt a reload cannot satisfy. A wrong password throws here, nothing sent. `purpose:
        // 'change_password'` is required: a bare verify-password is not exempt from `LegalAcceptanceGuard` while
        // `/auth/change-password` is, so a legally-stale user would be blocked before reaching it.
        await verifyPassword(currentPassword, { purpose: 'change_password' });
        // The re-wrapped `password` slot travels in the change-password body so the server commits credential and key
        // together; null for a recovery-only household.
        prepared = await prepareRewrappedPasswordSlot(newPassword);
      } catch (err) {
        throw new PasswordChangeNotSentError(
          err instanceof Error ? err.message : 'Could not prepare the password change.',
        );
      }
      const res = await apiRequest<LoginResponse>('/api/v1/auth/change-password', {
        method: 'POST',
        // The step-up proof rides alongside the passwords when `AUTH_MFA_ENFORCED` is on.
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
      // The server rotated the refresh and CSRF cookies and minted a new access token.
      updateFromToken(res.accessToken);
      // Advance the rollback pin only after the server confirms the commit, never on a rejection. This is post-commit:
      // retry once, and if the pin still cannot be durably advanced fail closed, since a pin left at the predecessor
      // would accept a replay of the old envelope set and silently restore the old password slot. Lock the workspace
      // (the next unlock re-pins) and throw PasswordChangeCommittedError so the UI never shows "may or may not have
      // gone through" for a confirmed 200.
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

  const deleteAccount = useCallback(
    async (currentPassword: string, proof?: StepUpProof): Promise<void> => {
      await apiRequest('/api/v1/auth/account', {
        method: 'DELETE',
        // The server DTO's XOR rejects a `code` next to a passkey `response`: send only the field the chosen factor
        // uses.
        body: {
          currentPassword,
          ...(proof
            ? proof.method === 'passkey'
              ? { method: proof.method, response: proof.response }
              : { method: proof.method, code: proof.code }
            : {}),
        },
      });
      // The server already cleared the cookies; mirror that in memory. The caller drops the IndexedDB and redirects.
      accessTokenRef.current = null;
      claimsRef.current = null;
      setMe(null);
      setHouseholdId(null);
      clearStoredEmail();
      clearUnlockState();
      clearRetainedPassword();
      // The caller's local-data nuke drops the IDB keyCache; clear the cached HDK too so the deleted account's key
      // never lingers if the nuke is interrupted.
      void clearCachedHdk();
      // Forget the user-transition baseline: the deleted account never signs in again, and keeping its userId would
      // force a redundant drop for an unrelated next user.
      clearLastUserId();
    },
    [clearUnlockState, clearRetainedPassword],
  );

  const fetchAccountRecord = useCallback(
    (opts?: { raiseWaitNotice?: boolean }): Promise<AccountRecord> =>
      opts
        ? apiRequest<AccountRecord>('/api/v1/auth/me', opts)
        : apiRequest<AccountRecord>('/api/v1/auth/me'),
    [],
  );

  const updateAccountRecord = useCallback(
    async (profile: UpdateAccountRecordRequest): Promise<AccountRecord> => {
      return apiRequest<AccountRecord>('/api/v1/auth/me', {
        method: 'PATCH',
        body: profile,
      });
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
        // The server DTO's XOR rejects a code alongside a passkey: a passkey carries `response`, code factors `code`.
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
      // Public route (clicked from the new inbox, possibly another browser): no bearer or CSRF cookie; the change-email
      // token is the identity proof.
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
      {/* Fail-closed cross-user reset: shown when another tab holds the previous account's IDB open; Retry re-attempts
          the drop and login. */}
      <LocalResetRequiredModal
        open={blockedReset !== null}
        onRetry={() => blockedReset?.retry() ?? Promise.resolve()}
      />
      {/* App-level, not inside LoginPage's unlock form: the cached-key auto-unlock that most often triggers it never
          renders that form. */}
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

async function maybeResetForNewUser(accessToken: string): Promise<void> {
  await maybeResetForNewUserCore(decodeJwt(accessToken), transitionDeps);
}
