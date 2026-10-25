// DynamoDB row types, one interface per table; matches infrastructure/src/dynamo.ts. Tables are grouped by role in
// docs/architecture.md, "Data".

import type {
  KdfParams,
  PushedMutationApplied,
  PushedMutationRejected,
  SlotType,
  SyncOperation,
} from '@retirement/contracts';

// ---------- Sync tables ----------

export interface WorkspaceMetaRow {
  householdId: string;
  latestSnapshotId: string | null;
  latestSnapshotCursor: string | null;
  latestVersion: number;
  lastUpdatedAt: string;
  mutationLogCursorBase: string | null;
  /**
   * Client-owned monotonic counter, stored opaquely (the server holds no key to verify the MAC). Absent on rows that
   * never received a freshness head.
   */
  freshnessCounter?: number;
  /** Client-computed HMAC over the counter, persisted verbatim and never validated server-side. */
  cursorTag?: string;
  /**
   * UTC `YYYY-MM-DD` the daily counts belong to. All three are absent on a new row, read as nothing spent today, and
   * are carried across household sweeps, never reset.
   */
  quotaDay?: string;
  dailyMutationCount?: number;
  dailyByteCount?: number;
  /**
   * Monotonic restore epoch, bumped by every restore and clear and pinned by the compactor cursor-advance condition:
   * a cursor comparison alone cannot detect a same-cutoff restore. Absent on legacy rows and rows no restore has
   * touched.
   */
  restoreEpoch?: number;
}

export interface MutationLogRow {
  householdId: string;
  sequenceId: string; // KSUID — sortable, time-ordered
  deviceId: string;
  aggregateId: string;
  aggregateType: string;
  operation: SyncOperation;
  payload: string; // JSON-stringified to avoid attribute-size friction
  version: number;
  timestamp: number;
  schemaVersion: number;
}

export interface AggregateVersionRow {
  householdId: string;
  aggregateId: string;
  aggregateType: string;
  version: number;
  updatedAt: string;
  deletedAt: string | null;
}

export interface IdempotencyKeyRow {
  /** `${householdId}#${deviceId}#${mutationId}` */
  key: string;
  response: PushedMutationApplied | PushedMutationRejected;
  createdAt: string;
  expiresAt: number; // 7-day TTL
  /**
   * Server-internal: the mutation version when a rejection was cached, compared on replay. Absent on applied rows and
   * legacy rejections, which re-evaluate.
   */
  expectedVersion?: number;
}

export interface DeviceRegistryRow {
  householdId: string;
  deviceId: string;
  displayName: string;
  userProvidedName: boolean;
  lastSeenAt: string;
  syncCursor: string | null;
  osType: string | null;
  userAgent: string | null;
}

// ---------- Auth tables ----------

export interface UserRow {
  userId: string;
  email: string;
  emailLowercase: string;
  householdId: string;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Applicant given name from signup; optional, and never in sign-in responses. */
  firstName?: string;
  /** Applicant's family name, captured at signup (optional). */
  lastName?: string;
  /** Applicant birthdate as `YYYY-MM-DD`; PII, never in the approval email or any auth-event log. */
  birthdate?: string;
  // Unverified-signup state, removed once `emailVerifiedAt` is set.
  /**
   * Epoch seconds after which the unverified signup is abandoned and lazily cleaned up on the next signup with the
   * same email.
   */
  signupExpiresAt?: number | null;
  /**
   * SHA-256 hash of the active EmailVerification token (never the raw token); lets a resend invalidate the prior link
   * without a GSI.
   */
  currentVerificationToken?: string | null;
  /** Last verification mail dispatch; powers the resend cooldown. */
  lastVerificationSentAt?: string | null;
  /** UTC day key (`floor(epochSec / 86400)`) for the resend daily counter. */
  verificationsSentDayKey?: number | null;
  /** Verification mails sent on `verificationsSentDayKey`. Resets on day rollover. */
  verificationsSentToday?: number | null;
  // Password-reset request state, on the User row so the cooldown and daily cap need no GSI.
  /**
   * SHA-256 hash of the active PasswordReset token (never the raw token); the consume requires it to match, so at
   * most one link is valid.
   */
  currentResetToken?: string | null;
  /**
   * When a reset was last requested. Unlike `lastResetSentAt` it survives the consume, so the post-reset
   * factor-restriction window (`factor-restriction.ts`) can compare against the request instant.
   */
  passwordResetRequestOpenedAt?: string | null;
  /**
   * When the latest reset completed, stamped by `resetConsumeUpdate`: the durable trace the restriction window needs
   * once the PasswordReset row is deleted.
   */
  lastPasswordResetCompletedAt?: string | null;
  /**
   * Creation time of the request the completed reset belongs to. A later abandoned request never overwrites it, so it
   * cannot cancel a still-open restriction window.
   */
  lastPasswordResetCompletedRequestedAt?: string | null;
  /** Last reset mail dispatch; powers the reset cooldown. */
  lastResetSentAt?: string | null;
  /** UTC day key (`floor(epochSec / 86400)`) for the reset daily counter. */
  resetsSentDayKey?: number | null;
  /** Reset mails sent on `resetsSentDayKey`. Resets on day rollover. */
  resetsSentToday?: number | null;
  // Email-OTP daily-cap state, on the User row because the MfaEmailOtp table ~10-minute TTL would wipe the counter
  // and defeat the cap.
  /** UTC day key (`floor(epochSec / 86400)`) for the Email-OTP daily counter. */
  mfaEmailOtpSentDayKey?: number | null;
  /** Email-OTP codes sent on `mfaEmailOtpSentDayKey`. Resets on day rollover. */
  mfaEmailOtpSentToday?: number | null;
  /** Last Email-OTP dispatch; powers the cooldown. */
  mfaEmailOtpLastSentAt?: string | null;
  // Step-up Email-OTP daily-cap state, a separate budget from the login triplet above so login sends never exhaust a
  // step-up allowance.
  /** UTC day key (`floor(epochSec / 86400)`) for the step-up Email-OTP counter. */
  stepUpEmailOtpSentDayKey?: number | null;
  /** Step-up Email-OTP codes sent on `stepUpEmailOtpSentDayKey`. Resets on day rollover. */
  stepUpEmailOtpSentToday?: number | null;
  /** Last step-up Email-OTP dispatch; powers the cooldown. */
  stepUpEmailOtpLastSentAt?: string | null;
  // Pending email change: the new address is held here until the confirm-time swap moves `email` and
  // `emailLowercase`.
  /** The new address, case-preserved, pending confirmation. */
  pendingEmail?: string | null;
  /**
   * Lowercased pending address, for the request-time uniqueness check and the confirm-time EmailReservation move.
   */
  pendingEmailLowercase?: string | null;
  /**
   * SHA-256 hash of the active change-email EmailVerification token; the confirm swap pins it, so at most one link is
   * valid.
   */
  currentPendingEmailToken?: string | null;
  /**
   * Epoch seconds when the pending change lapses; checked in code, not a DynamoDB TTL, since the User row is not
   * TTL-ed.
   */
  pendingEmailExpiresAt?: number | null;
  /** Last change-email mail dispatch; powers the send cooldown. */
  lastPendingEmailSentAt?: string | null;
  /** UTC day key (`floor(epochSec / 86400)`) for the change-email daily counter. */
  pendingEmailSentDayKey?: number | null;
  /** Change-email mails sent on `pendingEmailSentDayKey`; resets on day rollover. */
  pendingEmailSentToday?: number | null;
  /**
   * Owner-approval gate. Absent means a pre-existing user, treated as approved by the login guard. `pending` blocks
   * login until the owner approves; a `declined` row is reaped by the cascade Lambda.
   */
  approvalStatus?: 'auto_approved' | 'pending' | 'approved' | 'declined';
  // ---------- Factor-change undo ----------
  // Single-use "undo my last factor change" token: only its SHA-256 hash is stored, and one undo is outstanding per
  // account (a newer factor change overwrites it).
  /** SHA-256 hash of the active undo token (never the raw token); cleared by a successful consume. */
  pendingFactorUndoTokenHash?: string | null;
  /** Epoch seconds the undo token lapses; checked in code, not a DynamoDB TTL. */
  pendingFactorUndoExpiresAt?: number | null;
  /**
   * Which factor change the token undoes: an `_add` consume removes the factor first, a `_remove` consume only
   * revokes every session.
   */
  pendingFactorUndoKind?:
    | 'passkey_add'
    | 'passkey_remove'
    | 'totp_add'
    | 'totp_remove'
    | null;
  /**
   * The credential a `passkey_add` consume deletes; informational for `passkey_remove`; absent for the TOTP kinds.
   */
  pendingFactorUndoCredentialId?: string | null;
  /**
   * Account-wide session-revocation generation, bumped atomically with the retired value tombstone
   * (`SessionRevocationService.revokeAll`). Absent means generation 0. Never client-supplied.
   */
  sessionGeneration?: number;
}

/** The stored session generation, or 0 for a row that predates the field. */
export function resolveSessionGeneration(
  row: Pick<UserRow, 'sessionGeneration'> | null | undefined,
): number {
  return row?.sessionGeneration ?? 0;
}

export interface EmailReservationRow {
  emailLowercase: string;
  userId: string;
  reservedAt: string;
}

export interface EmailVerificationRow {
  /** PK. SHA-256 hash of the verification token; the raw token is only in the email link. */
  verificationToken: string;
  userId: string;
  email: string;
  createdAt: string;
  expiresAt: number; // epoch seconds for DynamoDB TTL
  /**
   * What the token authorizes, so a signup-verify and a change-email token cannot cross-consume. Absent on legacy
   * rows means `verify_email`.
   */
  purpose?: 'verify_email' | 'change_email';
}

/**
 * One pending password-reset link, single-use: the consume conditionally deletes the row inside one
 * TransactWriteItems. A 15-minute TTL bounds exposure.
 */
export interface PasswordResetRow {
  /** PK. SHA-256 hash of the reset token; the raw token is only in the email link. */
  resetToken: string;
  userId: string;
  email: string;
  createdAt: string;
  expiresAt: number; // epoch seconds for DynamoDB TTL
}

export interface SignupApprovalRow {
  /** PK. base64url(randomBytes(32)). Owner's mail link carries this. */
  approvalToken: string;
  userId: string;
  /** Applicant's email, surfaced to the owner on the approval page. */
  email: string;
  createdAt: string;
  /**
   * Epoch seconds, DynamoDB TTL. On expiry the stream REMOVE event drives the cascade Lambda to delete the
   * still-pending user (7-day window).
   */
  expiresAt: number;
}

export interface CredentialRow {
  userId: string;
  argon2Hash: string;
  updatedAt: string;
  /**
   * Opaque revision minted on every credential write (signup, reset consume, change-password, local seed); a password
   * key-envelope slot records the revision it was wrapped under. Absent on rows from before the field, which
   * resolveCredentialRevision maps to a value no slot carries. Never client-supplied.
   */
  credentialRevision?: string;
}

/**
 * Stands in for a credential row written before the revision field; no slot carries it, so a legacy credential always
 * reads owed a re-wrap.
 */
export const LEGACY_CREDENTIAL_REVISION = '__legacy_no_revision__';

/** The stored revision, or LEGACY_CREDENTIAL_REVISION, so equality checks never special-case undefined. */
export function resolveCredentialRevision(
  row: Pick<CredentialRow, 'credentialRevision'> | null | undefined,
): string {
  return row?.credentialRevision ?? LEGACY_CREDENTIAL_REVISION;
}

/**
 * Equals no real revision. The expected value when the session records none, so the write-authority condition always
 * fails.
 */
export const NO_SESSION_REVISION_SENTINEL = '__no_session_revision__';

/**
 * The canonical slot id of every password key-envelope row; a password slot at any other id is refused, never
 * migrated.
 */
export const PASSWORD_SLOT_ID = 'password';

export interface PasskeyRow {
  userId: string;
  credentialId: string;
  publicKey: string; // base64url-encoded CBOR bytes
  counter: number;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  transports: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  /**
   * True when the passkey was enrolled inside a password-reset restriction window (the reset-then-inbox-takeover
   * control). Sticky: set at write time, never derived at read time, until confirm-restriction lifts it. While true
   * it cannot satisfy a step-up or serve as a login or MFA factor. See `factor-restriction.ts`.
   */
  restrictedPostReset?: boolean;
  /** The reset request that opened the window; present only while `restrictedPostReset` is true. */
  restrictedByResetRequestedAt?: string;
}

/**
 * One in-flight WebAuthn ceremony. The key string is the security binding (`reg:`, `stepup:`, `mfa:`, `auth:`
 * namespaces), so a challenge minted under one key is never reachable under another. TTL is hygiene only (deletion
 * lags, DynamoDB Local never sweeps); PasskeyChallengeStore enforces the 5-minute window at read.
 */
export interface PasskeyChallengeRow {
  key: string;
  challenge: string;
  /** Present for every namespace except the discoverable-login `auth:` one. */
  userId?: string;
  /** Epoch seconds, a DynamoDB TTL value (hygiene only). */
  expiresAt: number;
}

export interface RefreshTokenRow {
  userId: string;
  tokenHash: string;
  tokenFamilyId: string;
  expiresAt: number; // TTL
  revokedAt: string | null;
  rotatedFrom: string | null; // previous tokenHash in family, or null for the first
  userAgent: string | null;
  ip: string | null;
  jti: string; // The access-token jti issued alongside this refresh token
  // Carried across rotations so the rotated access token deviceId claim still matches the SPA localStorage value.
  deviceId: string;
  // Persisted on every row so a rotated token carries the real householdId, not userId, should the 1:1 invariant ever
  // break.
  householdId: string;
  createdAt: string;
  /**
   * The credential revision this session authenticated against: the write authority a password-slot mutation is
   * conditioned on, resolved per request from this row because a signed claim cannot be amended mid-session. Copied
   * verbatim on rotation, never re-derived; a session carrying none (alive before the field, or a passkey sign-in)
   * has every password-slot write rejected.
   */
  credentialRevision?: string;
  /**
   * The account session generation stamped at issuance and carried verbatim across rotations.
   * RefreshTokenService.issue conditions its Put on the User row current generation still equalling it, so an
   * account-wide revoke that lands first prevents the commit. Absent on rows from before the field; the cutover
   * rejects such a row rather than treating it as generation 0.
   */
  sessionGeneration?: number;
}

export interface RevokedTokenRow {
  jti: string;
  userId: string;
  revokedAt: string;
  expiresAt: number; // TTL = original token's exp
  /**
   * Row discriminator; absent on the bare-UUID session and refresh revocation rows. Each kind uses a
   * namespace-disjoint jti (`mfa:<uuid>`, `gen:<userId>:<generation>`, `family:<tokenFamilyId>`) that cannot collide
   * with a bearer-token revocation. `mfa_challenge` is a single-use challenge ledger row, `generation_revoked`
   * tombstones a retired session generation, `family_barrier` is a token-family revocation barrier.
   */
  kind?: 'mfa_challenge' | 'generation_revoked' | 'family_barrier';
}

export interface FailedLoginAttemptRow {
  emailLowercase: string;
  /**
   * Miss count, advanced by atomic ADD so concurrent failures lose no increment. Absent on a row holding only a
   * notice stamp; read a missing value as zero.
   */
  consecutiveFailures?: number;
  /** Latest miss; the backoff window is derived from this and `consecutiveFailures` at check time, never stored. */
  lastFailedAt?: string;
  expiresAt: number; // epoch-seconds TTL — 24h after last failure
  /**
   * Last guessing-notice email. `clear()` preserves it across a successful sign-in so a second burst within 24h
   * cannot re-notify.
   */
  guessingNoticeSentAt?: string;
}

export type AuthEventType =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'refresh'
  | 'refresh_reuse_detected'
  | 'passkey_enroll'
  | 'passkey_assert'
  | 'passkey_remove'
  | 'email_verify'
  | 'email_resend'
  | 'signup_expired_cleanup'
  | 'password_change'
  | 'password_verify'
  | 'password_verify_failed'
  // `password_reset_requested` is appended only on a real mail send, never on a no-op branch, so the audit trail is
  // not a user-existence oracle.
  | 'password_reset_requested'
  | 'password_reset'
  // The pending and old email values are PII and are not logged in `metadata`.
  | 'email_change_requested'
  | 'email_change'
  // The old and new field values are PII and are not written into `metadata`.
  | 'account_record_correction'
  | 'data_export'
  | 'data_export_failed'
  | 'signup'
  | 'account_deletion_initiated'
  | 'account_deletion_completed'
  | 'signup_approval_requested'
  | 'signup_approved'
  | 'signup_declined'
  | 'signup_approval_expired'
  | 'key_envelope_created'
  | 'key_envelope_updated'
  | 'key_envelope_deleted'
  | 'key_envelope_rotated'
  | 'encrypted_workspace_reset_started'
  | 'encrypted_workspace_reset_completed'
  | 'encrypted_workspace_reset_failed'
  // `workspace_clear_failed` rows carry `metadata.reason`; `currentPassword` is never logged.
  | 'workspace_clear_started'
  | 'workspace_clear_completed'
  | 'workspace_clear_failed'
  // Codes and TOTP secrets are never logged in `metadata`.
  | 'mfa_challenge_issued'
  | 'mfa_totp_verified'
  | 'mfa_totp_failed'
  // Appended once per lock, on the miss that first crosses the grace threshold; mapped onto the MfaVerifyFailed
  // metric.
  | 'mfa_totp_locked'
  | 'mfa_email_otp_sent'
  | 'mfa_email_otp_verified'
  | 'mfa_email_otp_failed'
  // Historical-only values retained so pre-2026-08-24 audit rows remain typed
  // and exportable. Current code has no saved backup-code factor and emits none.
  | 'mfa_backup_code_used'
  | 'mfa_backup_code_failed'
  | 'mfa_totp_enrolled'
  | 'mfa_totp_disabled'
  | 'mfa_backup_codes_regenerated'
  | 'mfa_device_trusted'
  | 'mfa_device_forgotten'
  // Codes and assertions are never logged.
  | 'step_up_challenge'
  | 'step_up_passed'
  | 'step_up_failed'
  | 'factor_undo_consumed'
  | 'login_guessing_notice_sent'
  // `metadata` carries `purpose`, `credentialId` and `factorType` only, never a proof.
  | 'factor_enrollment_blocked'
  | 'factor_restriction_applied'
  | 'factor_restriction_lifted';

export interface AuthEventRow {
  userId: string; // PK; "anonymous-<sha256>" for unknown-email failures
  eventId: string; // KSUID
  eventType: AuthEventType;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  expiresAt: number; // TTL — 1 year
}

// ---------- Enforced second-factor (MFA) tables ----------

/**
 * One row per user holding their TOTP factor. The RFC-6238 `totpSecret` is protected at rest by DynamoDB SSE on the
 * dedicated table and a narrow api-role grant, and is never logged.
 */
export interface UserMfaRow {
  userId: string;
  /** Whether the TOTP factor is enrolled + confirmed (a live second factor). */
  totpEnabled: boolean;
  /** RFC-6238 base32 shared secret; present only once enrollment is confirmed. */
  totpSecret?: string;
  /** Secret minted by enroll/start, held until enroll/confirm promotes it to `totpSecret`. */
  pendingTotpSecret?: string;
  /** ISO timestamp the TOTP factor was confirmed/enrolled. */
  enrolledAt?: string;
  /** ISO timestamp of the last successful TOTP verification. */
  lastVerifiedAt?: string;
  /**
   * Latest RFC-6238 time step consumed by a step-up verify, committed by a conditional UpdateItem so a step cannot be
   * reused concurrently. Login MFA does not touch it.
   */
  lastUsedTotpStepStepUp?: number;
  /**
   * Per-account TOTP miss count shared by both live-factor verify paths, advanced only by
   * `UserMfaRepository.reserveTotpAttempt` (a compare-and-swap, so a refused attempt never moves it). The row has no
   * TTL, so the reservation resets the count when `totpLastFailureAt` predates the decay window; cleared on a
   * successful verification.
   */
  totpFailureCount?: number;
  /** Latest TOTP miss; the lock window is derived from this and `totpFailureCount` at check time. */
  totpLastFailureAt?: string;
  /**
   * True when the current TOTP factor was (re-)confirmed inside a password-reset restriction window. Sticky like
   * `PasskeyRow.restrictedPostReset`; `disable()` replaces the row, so a re-enrolled factor never inherits it.
   */
  totpRestrictedPostReset?: boolean;
  /** The reset request that opened the window; present only while `totpRestrictedPostReset` is true. */
  totpRestrictedByResetRequestedAt?: string;
  updatedAt: string;
}

/**
 * The live Email-OTP code hash for a user, TTL-ed (~10 min). The cap and cooldown counters live on the User row, not
 * here, since this TTL would wipe them. The raw 6-digit code is emailed and never stored; 5 wrong attempts invalidate
 * it.
 */
export interface MfaEmailOtpRow {
  /**
   * PK: the bare userId for a login or change-email code, `<userId>#stepup` for a step-up code so the two never
   * clobber each other.
   */
  userId: string;
  /** SHA-256 hash of the 6-digit code (never the raw code). */
  codeHash: string;
  /**
   * Epoch seconds the code lapses (~10 min), a DynamoDB TTL value; readers reject a nonnumeric legacy ISO string or
   * an elapsed value.
   */
  expiresAt: number;
  /** ISO timestamp the code was sent. */
  sentAt: string;
  /** Wrong-attempt counter; hard cap of 5 invalidates the code. */
  attempts: number;
  /**
   * The operation a step-up code authorizes, checked before consuming so a code for one operation cannot authorize
   * another. Absent on the login and change-email row.
   */
  purpose?: string;
}

/**
 * One trusted-device record (PK userId, SK deviceId, the stable localStorage value). A device-trust cookie whose
 * secret hashes to `tokenHash` skips the MFA challenge for ~30 days; keying on (userId, deviceId) means a different
 * user on the same browser is still challenged.
 */
export interface TrustedDeviceRow {
  userId: string;
  deviceId: string;
  /** SHA-256 hash of the opaque device-trust secret, never the raw secret. */
  tokenHash: string;
  createdAt: string;
  /**
   * Epoch seconds the trust lapses (~30 days), a DynamoDB TTL value; readers reject a nonnumeric legacy ISO string or
   * an elapsed value.
   */
  expiresAt: number;
  lastUsedAt: string;
  ip: string | null;
  userAgent: string | null;
  /**
   * Per-device consecutive-failure ceiling; a trusted device serves no backoff wait. Advanced by an
   * existence-conditioned atomic ADD so a raced increment cannot mint a row missing `tokenHash` or `expiresAt`.
   * Crossing the ceiling deletes the row, revoking trust for this device only. Absent on a device that never missed.
   */
  consecutiveFailures?: number;
  /** Latest miss; absent alongside `consecutiveFailures`. */
  lastFailedAt?: string;
}

// ---------- Zero-knowledge key-envelope table ----------

/**
 * One wrapped-key slot (PK householdId, SK slotId). The server stores the wrapped key and metadata opaquely and never
 * unwraps, validates or logs it.
 */
export interface HouseholdKeyEnvelopeRow {
  householdId: string;
  /** SK. Per-slot id. Never the `ENVELOPE_META` sentinel. */
  slotId: string;
  slotType: SlotType;
  /**
   * The WebAuthn credential ID a `passkey_prf` slot is bound to, verified against the caller by the controller; null
   * or absent for other slots.
   */
  credentialBinding?: string | null;
  /** Present for `password` slots; recovery/passkey-PRF/oidc slots omit it. */
  kdf?: KdfParams;
  /** base64url PRF salt; present for `passkey_prf` slots. */
  prfSalt?: string;
  /** base64url authenticated AES-256-GCM wrap of the HDK. */
  wrappedKey: string;
  encryptionVersion: number;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string;
  /**
   * The credential revision this password slot was wrapped under, written from the session recorded authority, never
   * the request body. A slot whose revision differs from the credential current one, or has none, is owed a re-wrap;
   * the change-password commit stamps it in the same transaction.
   */
  credentialRevision?: string;
}

/** SK sentinel value distinguishing the per-household envelope-set meta row. */
export const ENVELOPE_META_SLOT_ID = 'ENVELOPE_META';

// SK prefix of archived (superseded) envelope rows, reserved like ENVELOPE_META_SLOT_ID so partition-wide queries can
// exclude it centrally.
const ARCHIVE_SLOT_ID_PREFIX = 'ARCHIVE#';

/** True when `slotId` names an archive row, never a live slot or the live ENVELOPE_META sentinel. */
export function isArchiveSlotId(slotId: string): boolean {
  return slotId.startsWith(ARCHIVE_SLOT_ID_PREFIX);
}

/**
 * Archive SK for a displaced slot row, keyed by envelope-set version so earlier displacements of the same slotId
 * never collide.
 */
export function archiveSlotId(version: number, slotId: string): string {
  return `${ARCHIVE_SLOT_ID_PREFIX}${version}#${slotId}`;
}

/** Namespaced archive SK for a displaced `ENVELOPE_META` row. */
export function archiveMetaSlotId(version: number): string {
  return `${ARCHIVE_SLOT_ID_PREFIX}${version}#${ENVELOPE_META_SLOT_ID}`;
}

/**
 * Sort-key bounds of the archive namespace (the upper bound is the prefix with its last byte incremented), so a
 * live-set read skips the whole range server-side instead of paging through every archived version.
 */
export const ARCHIVE_SLOT_ID_LOWER_BOUND = ARCHIVE_SLOT_ID_PREFIX;
export const ARCHIVE_SLOT_ID_UPPER_BOUND =
  ARCHIVE_SLOT_ID_PREFIX.slice(0, -1) +
  String.fromCharCode(ARCHIVE_SLOT_ID_PREFIX.charCodeAt(ARCHIVE_SLOT_ID_PREFIX.length - 1) + 1);

/**
 * An archived ENVELOPE_META row as it stood at `envelopeSetVersion`, written inside the transaction that superseded
 * it. `slotIds` lists every slot live at that version (archived slot rows only record what a later write displaced);
 * the operator restore procedure (AGENTS.md, "Key-envelope archive recovery") keys off it. `expiresAt` is the archive
 * TTL and is never copied onto a live row.
 */
export interface HouseholdEnvelopeMetaArchiveRow {
  householdId: string;
  /** SK — {@link archiveMetaSlotId}`(envelopeSetVersion)`. */
  slotId: string;
  envelopeSetVersion: number;
  envelopeSetTag: string;
  updatedAt: string;
  slotIds: string[];
  expiresAt: number;
}

// Archive retention floor: DynamoDB TTL deletes lazily (up to ~48h late), so this must never back a deletion-scope
// guarantee.
const ARCHIVE_RETENTION_DAYS = 30;

/** Epoch-seconds TTL stamp for an archive row written now. */
export function archiveExpiresAt(): number {
  return Math.floor(Date.now() / 1000) + ARCHIVE_RETENTION_DAYS * 24 * 60 * 60;
}

/**
 * Per-household envelope-set integrity row (SK ENVELOPE_META). The server enforces a monotonic `envelopeSetVersion`
 * and never recomputes or validates `envelopeSetTag`.
 */
export interface HouseholdEnvelopeMetaRow {
  householdId: string;
  slotId: typeof ENVELOPE_META_SLOT_ID;
  /** Monotonic counter, +1 on every slot add/rotate/remove. */
  envelopeSetVersion: number;
  /** `HMAC(HKDF(HDK,"envelope-auth"), canonical(slots) + envelopeSetVersion)`. */
  envelopeSetTag: string;
  updatedAt: string;
  /**
   * Set at the start of the non-atomic `deleteAllForHousehold` sweep, with the sentinel row deleted last. A
   * `getStableEnvelopeSet` bracket that sees it fails closed (503 ENVELOPE_READ_CONFLICT) instead of trusting a
   * partly-swept set.
   */
  deletionInProgress?: boolean;
}
