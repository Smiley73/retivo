/**
 * DynamoDB row types. One TypeScript interface per table column-set.
 * Matches infrastructure/src/dynamo.ts exactly. The "Data" section of
 * docs/architecture.md groups the tables by role.
 */

// ---------- Sync tables ----------

export interface WorkspaceMetaRow {
  householdId: string;
  latestSnapshotId: string | null;
  latestSnapshotCursor: string | null;
  latestVersion: number;
  lastUpdatedAt: string;
  mutationLogCursorBase: string | null;
  /**
   * Client-owned monotonic freshness counter. Stored opaquely — the server never computes or
   * verifies the accompanying MAC (it holds no household data key). Optional: rows created before
   * this feature, and brand-new rows that haven't yet received a `freshnessHead` push, won't have
   * it.
   */
  freshnessCounter?: number;
  /**
   * Client-computed `HMAC(HKDF(HDK,"cursor-auth"), canonical(freshnessCounter))`.
   * Persisted verbatim alongside `freshnessCounter` and echoed back
   * to the client; never validated server-side.
   */
  cursorTag?: string;
  /**
   * Daily push-quota state. `quotaDay` is a UTC `YYYY-MM-DD` stamp naming the day
   * `dailyMutationCount` / `dailyByteCount` were accumulated for — see
   * `WorkspaceMetaRepository.chargeDailyQuota`, the single conditional
   * read-modify-write that both rolls the day over and charges a batch. All
   * three are absent on a brand-new row and on any row from before this
   * budget shipped, which reads as "nothing spent today". Deliberately
   * carried forward (never reset) across every household-triggerable sweep
   * (restore / workspace clear / encrypted-workspace reset): the sweep's own
   * WorkspaceMeta delete captures the trio (`deleteReturningPrior`), the row
   * is recreated without it (`reinitializeForRestore` / `createIfMissing`),
   * and `carryQuotaForward` merges it back with an atomic `ADD` so a charge
   * from a push in flight during the sweep survives too.
   */
  quotaDay?: string;
  dailyMutationCount?: number;
  dailyByteCount?: number;
  /**
   * Monotonic restore epoch (compactor-restore race guard). Bumped by
   * `RestoreService.restore` / `clearToEmpty` BEFORE their sweep deletes the
   * row, and pinned by the compactor's cursor-advance condition alongside
   * `latestSnapshotCursor` — a cursor comparison alone can't detect a
   * same-cutoff restore (the ordinary case for restoring the MOST RECENT
   * snapshot), only a value that changes on every restore can. Absent is a
   * distinct pinned state (legacy rows, and rows a restore/clear has not yet
   * touched) — treated the same way the existing cursor condition treats an
   * absent `latestSnapshotCursor`.
   */
  restoreEpoch?: number;
}

export interface MutationLogRow {
  householdId: string;
  sequenceId: string; // KSUID — sortable, time-ordered
  deviceId: string;
  aggregateId: string;
  aggregateType: string;
  operation: 'create' | 'update' | 'delete';
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
  response: AppliedMutationResult | RejectedMutationResult;
  createdAt: string;
  expiresAt: number; // 7-day TTL
  /**
   * Server-internal only — NEVER surfaced on the
   * client-facing `RejectedMutationResult`. The mutation's `version` (its
   * expected-previous-version) at the moment a REJECTED outcome was cached.
   * Read only for the version-aware rejection-replay comparison: a later
   * replay of the same `(householdId, deviceId, mutationId)` whose incoming
   * `version` differs means the client re-based and retried with a
   * corrected version, so the stale cached rejection must not be replayed
   * as-is. Absent on APPLIED rows and on any row cached before this field
   * existed (a legacy rejection) — treated as "re-evaluate" (bypass on any
   * incoming version) rather than a trustworthy match.
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

export interface AppliedMutationResult {
  status: 'applied';
  mutationId: string;
  aggregateId: string;
  newVersion: number;
  newUpdatedAt: string;
  /**
   * KSUID of the MutationLog row written by this push. Present on real
   * commits (the first time this `(householdId, deviceId, mutationId)`
   * triple lands); absent when the response is a transparent replay
   * served from the IdempotencyKey cache, because the replay request
   * wrote no MutationLog row of its own and the cache row never stored
   * a sequenceId. Clients use the field for cursor advancement; they
   * already treat an absent value as "no new cursor".
   */
  sequenceId?: string;
  /**
   * Set `true` only when this `create` revived a tombstoned aggregate —
   * the aggregate id previously existed and was
   * soft-deleted, and this push continued its version lineage rather than
   * starting a fresh one. Absent on every ordinary create/update/delete.
   * The client logs a diagnostics breadcrumb on it.
   */
  recreatedOverTombstone?: boolean;
}

export interface RejectedMutationResult {
  status: 'rejected';
  mutationId: string;
  aggregateId: string;
  reason: 'CONFLICT' | 'NOT_FOUND' | 'SCHEMA_MISMATCH';
  currentVersion: number;
  currentUpdatedAt: string;
  /**
   * The current server row's soft-delete timestamp (its `AggregateVersion`
   * `deletedAt`), additive read-only field.
   * Non-null when the row is a tombstone, `null` when it is a live row or does
   * not exist. Lets the client's auto-repair tell a recreate-over-own-tombstone
   * (safe to convert to an update) from a collision with another device's live
   * create at the same id (a real choice) without a second server round-trip.
   */
  currentDeletedAt: string | null;
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
  /** Applicant's given name, captured at signup (optional — old clients /
   * API-direct signups omit it). Surfaced in the owner approval email and
   * the login response so the SPA can seed the primary HouseholdMember. */
  firstName?: string;
  /** Applicant's family name, captured at signup (optional). */
  lastName?: string;
  /** Applicant's birthdate as `YYYY-MM-DD`, captured at signup (optional).
   * Returned in the login response for HouseholdMember seeding; never
   * included in the approval email or any auth-event log (PII). */
  birthdate?: string;
  // Unverified-signup state. All fields are removed once
  // `emailVerifiedAt` is set.
  /** Epoch seconds at which the unverified signup is considered abandoned
   * and the row is eligible for lazy cleanup on the next signup with the
   * same email. Distinct from the per-token TTL on EmailVerification. */
  signupExpiresAt?: number | null;
  /** SHA-256 hash of the currently-active EmailVerification token, if any
   * (never the raw token). Lets a resend invalidate the prior link
   * without a GSI on userId; the stored hash is the PK of the matching
   * EmailVerification row. */
  currentVerificationToken?: string | null;
  /** ISO timestamp of the last verification mail dispatch. Powers the
   * per-email resend cooldown (silent backoff). */
  lastVerificationSentAt?: string | null;
  /** UTC day key (`floor(epochSec / 86400)`) for the resend daily counter. */
  verificationsSentDayKey?: number | null;
  /** Verification mails sent on `verificationsSentDayKey`. Resets on day rollover. */
  verificationsSentToday?: number | null;
  // Password-reset request state. Parallels the verification
  // counters above. These live on the User row so the reset cooldown +
  // daily cap need no GSI, and so a re-request can invalidate the prior
  // PasswordReset row (and account deletion can sweep it) via
  // `currentResetToken` without a Scan.
  /** SHA-256 hash of the currently-active PasswordReset token, if any
   * (never the raw token; it is also the PK of the matching
   * PasswordReset row). The reset consume requires
   * `sha256(presentedRawToken) == currentResetToken`, so at most one reset
   * link is ever valid even if an older row has not yet TTL'd. */
  currentResetToken?: string | null;
  /**
   * ISO timestamp a reset was last REQUESTED —
   * the same instant as `lastResetSentAt` below, but never cleared by the
   * consume transaction (`resetConsumeUpdate` removes `lastResetSentAt`;
   * this field survives). Durable so the post-reset factor-restriction window
   * (`factor-restriction.ts`) can compare a candidate proving factor's own
   * enrollment against the REQUEST instant, not just the completion instant,
   * even after the request that opened the window has long since completed.
   * Overwritten (not appended) by the next request.
   */
  passwordResetRequestOpenedAt?: string | null;
  /**
   * ISO timestamp the most recent reset last COMPLETED — stamped by `resetConsumeUpdate`. Nothing
   * else records that a reset happened at all once `commitConsume` deletes the `PasswordReset` row
   * and clears `currentResetToken`; this is the durable trace the post-reset factor-restriction
   * window needs to detect "a reset completed recently" without a live token. See
   * `factor-restriction.ts`.
   */
  lastPasswordResetCompletedAt?: string | null;
  /**
   * ISO timestamp of the REQUEST that the completed reset above belongs to —
   * stamped by `resetConsumeUpdate` from the
   * consumed `PasswordReset` row's own `createdAt`, alongside
   * `lastPasswordResetCompletedAt`. Durable and paired: unlike
   * `passwordResetRequestOpenedAt` (which a later, never-consumed reset
   * request overwrites), this field is never touched by `resetSendUpdate`,
   * so a later abandoned request cannot cancel a still-open post-completion
   * window by making it look like the completion predates its own request.
   * See `factor-restriction.ts`.
   */
  lastPasswordResetCompletedRequestedAt?: string | null;
  /** ISO timestamp of the last reset mail dispatch. Powers the per-email
   * reset cooldown (silent backoff). */
  lastResetSentAt?: string | null;
  /** UTC day key (`floor(epochSec / 86400)`) for the reset daily counter. */
  resetsSentDayKey?: number | null;
  /** Reset mails sent on `resetsSentDayKey`. Resets on day rollover. */
  resetsSentToday?: number | null;
  // Email-OTP MFA daily-cap state. Parallels the
  // verification + reset counters above and lives on the User row for the
  // same reason: the cap must survive the `MfaEmailOtp` table's ~10-min
  // `expiresAt` TTL (which would otherwise wipe the counter and defeat the
  // daily cap). The TTL'd table holds only the live code hash; the cap
  // counters live here.
  /** UTC day key (`floor(epochSec / 86400)`) for the Email-OTP daily counter. */
  mfaEmailOtpSentDayKey?: number | null;
  /** Email-OTP codes sent on `mfaEmailOtpSentDayKey`. Resets on day rollover. */
  mfaEmailOtpSentToday?: number | null;
  /** ISO timestamp of the last Email-OTP dispatch. Powers the per-email
   * Email-OTP cooldown (silent backoff), mirroring `lastResetSentAt`. */
  mfaEmailOtpLastSentAt?: string | null;
  // Step-up Email-OTP daily-cap state. A
  // SEPARATE budget from the login/change-email `mfaEmailOtp*` triplet above so
  // login sends never exhaust a step-up user's code allowance (and vice versa).
  // Lives on the `User` row for the same reason as the login triplet: the
  // namespaced `<userId>#stepup` `MfaEmailOtp` code row is ~10-min-TTL'd and
  // would wipe the counter. Backs the destructive-op step-up email-OTP factor.
  /** UTC day key (`floor(epochSec / 86400)`) for the step-up Email-OTP counter. */
  stepUpEmailOtpSentDayKey?: number | null;
  /** Step-up Email-OTP codes sent on `stepUpEmailOtpSentDayKey`. Resets on day rollover. */
  stepUpEmailOtpSentToday?: number | null;
  /** ISO timestamp of the last step-up Email-OTP dispatch. Powers the step-up
   * Email-OTP cooldown (silent backoff), mirroring `mfaEmailOtpLastSentAt`. */
  stepUpEmailOtpLastSentAt?: string | null;
  // Self-service email-change pending state.
  // Mirrors the verify-email / password-reset request-tracking pattern: the
  // pending fields are written by the change-email request/step-up flow and
  // cleared by the confirm-time atomic swap. The new address is held PENDING
  // here while a verification link is mailed to it; the live `email` /
  // `emailLowercase` only move on confirm.
  /** The new address the user is changing to, held pending until the
   * confirmation link is clicked. The case-preserved form (mirrors `email`). */
  pendingEmail?: string | null;
  /** Lowercased pending address — used for the request-time uniqueness
   * pre-check and the confirm-time `EmailReservation` move. */
  pendingEmailLowercase?: string | null;
  /** SHA-256 hash of the active change-email `EmailVerification` token (never the raw token; it is
   * also the PK of the matching `EmailVerification` row, `purpose: 'change_email'`). The
   * confirm-time swap pins `currentPendingEmailToken == sha256(presentedRawToken)` so at most one
   * change-email link is ever valid even if an older row has not yet TTL'd (single-valid-link
   * invariant). */
  currentPendingEmailToken?: string | null;
  /** Logical intent-expiry for the pending email change as epoch seconds
   * (~15 min). Checked in code (NOT a DynamoDB TTL — the `User` row is not
   * TTL'd; mirrors `signupExpiresAt`). Bounds the request → step-up window so
   * a stale password proof can't complete a change; `send-otp` /
   * `verify-step-up` reject a request whose intent has elapsed. */
  pendingEmailExpiresAt?: number | null;
  /** ISO timestamp of the last change-email verification mail dispatch.
   * Powers the per-user change-email send cooldown (silent backoff),
   * mirroring `lastVerificationSentAt`. */
  lastPendingEmailSentAt?: string | null;
  /** UTC day key (`floor(epochSec / 86400)`) for the change-email daily counter. */
  pendingEmailSentDayKey?: number | null;
  /** Change-email verification mails sent on `pendingEmailSentDayKey`.
   * Resets on day rollover. */
  pendingEmailSentToday?: number | null;
  /**
   * Owner-approval gate. Set on every signup; absent means
   * "pre-existing user" (treated as approved by the login guard so
   * existing accounts aren't locked out by this rollout).
   *   - `auto_approved`: signup email matched APPROVER_EMAIL — owner
   *     signed up themselves, no approval mail sent.
   *   - `pending`: signup email is foreign; approval mail dispatched
   *     once the user verifies their email. Login is blocked.
   *   - `approved`: owner clicked the approval link.
   *   - `declined`: owner clicked the decline link. Cascade Lambda
   *     reaps the row when the SignupApproval TTL fires (or
   *     immediately on owner-initiated decline).
   */
  approvalStatus?: 'auto_approved' | 'pending' | 'approved' | 'declined';
  // ---------- Factor-change undo ----------
  // A single-use "undo my last factor change" token, minted whenever a
  // passkey or TOTP factor is added or removed and emailed to the account's
  // address. Mirrors the `currentResetToken` shape: only the SHA-256 hash is
  // stored, the consume endpoint conditions its write on the presented
  // token's hash matching this value, and there is deliberately no dedicated
  // table. ONE outstanding
  // undo per account by design — a newer factor change overwrites the
  // pending token for an older one; the landing page treats a superseded
  // token identically to an expired one.
  /** SHA-256 hash of the currently-active factor-undo token, if any (never the raw token). Cleared
   * by a successful consume. */
  pendingFactorUndoTokenHash?: string | null;
  /** Epoch seconds after which the pending undo token is no longer honored
   * (checked in code — NOT a DynamoDB TTL, the `User` row is not TTL'd). */
  pendingFactorUndoExpiresAt?: number | null;
  /** Which factor change the pending token undoes. An `_add` kind's consume
   * removes the named credential / disables TOTP before revoking every
   * session; a `_remove` kind's consume only revokes every session — the
   * removed factor can never be restored. */
  pendingFactorUndoKind?:
    | 'passkey_add'
    | 'passkey_remove'
    | 'totp_add'
    | 'totp_remove'
    | null;
  /** The passkey `credentialId` the pending undo acts on. Present only for
   * `passkey_add` (the credential the consume deletes) and `passkey_remove`
   * (informational only — the removal is never reversed). Absent for the
   * TOTP kinds, which have no credential id. */
  pendingFactorUndoCredentialId?: string | null;
  /**
   * Monotonic account-wide session-revocation generation. Every session access token is stamped
   * with the value this row carried at issuance/rotation time; account-wide revocation
   * (`SessionRevocationService.revokeAll`) atomically bumps this field AND tombstones the retired
   * value in the same transaction — see `UsersRepository.bumpSessionGenerationTransactItem` and
   * `RevokedTokensRepository.tombstoneGenerationTransactItem`. Absent means generation 0 (no
   * revocation has ever happened for this account); see {@link resolveSessionGeneration}. Never a
   * client-supplied value.
   */
  sessionGeneration?: number;
}

/**
 * Resolve a `User` row's comparable session generation: the stored value, or `0` when the row
 * predates the field or has never been revoked. Mirrors {@link resolveCredentialRevision}.
 */
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
  /** PK. SHA-256 hash of the raw verification token — the raw token
   * is sent only in the email link, never stored. */
  verificationToken: string;
  userId: string;
  email: string;
  createdAt: string;
  expiresAt: number; // epoch seconds for DynamoDB TTL
  /**
   * What this token is for. Enforced on
   * consume so a signup-verify token and a change-email token can never
   * cross-consume:
   *   - `verify_email` (or absent — legacy rows minted before this field):
   *     signup / resend verification. The verify-email consume accepts these.
   *   - `change_email`: a self-service email-change confirmation. The
   *     change-email confirm requires this; the verify-email consume rejects
   *     it. For a `change_email` row, `email` is the NEW (pending) address.
   */
  purpose?: 'verify_email' | 'change_email';
}

/**
 * One pending password-reset link. PK is the random `resetToken`;
 * a 15-min TTL on `expiresAt` bounds exposure. Single-use: the consume
 * conditionally deletes this row inside one `TransactWriteItems`,
 * so a reused token can never rotate the password twice. Mirrors
 * `EmailVerificationRow`.
 */
export interface PasswordResetRow {
  /** PK. SHA-256 hash of the raw reset token — the raw token is sent
   * only in the email link, never stored. */
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
   * Epoch seconds. DynamoDB TTL attribute. When the row times out the
   * stream emits a REMOVE event tagged with userIdentity.principalId =
   * "dynamodb.amazonaws.com" — the cascade Lambda observes that, looks
   * up the still-pending user, and deletes the user + credential +
   * email-reservation in one TransactWrite. 7-day window.
   */
  expiresAt: number;
}

export interface CredentialRow {
  userId: string;
  argon2Hash: string;
  updatedAt: string;
  /**
   * Opaque revision minted fresh on every credential write: signup, the reset consume, the
   * change-password commit, and the local-dev seed. A `password`-type key-envelope slot records the
   * revision it was wrapped under; comparing the two is how a re-wrap is known to be owed. Absent
   * on a row written before this field existed — {@link resolveCredentialRevision} resolves that to
   * {@link LEGACY_CREDENTIAL_REVISION}, a value no slot ever carries until a re-wrap stamps it, so
   * a legacy credential always reads owed. Never a client-supplied value on any DTO.
   */
  credentialRevision?: string;
}

/**
 * The single fixed value {@link resolveCredentialRevision} returns for a credential row written
 * before the revision field existed. No slot is ever stamped with this literal value, so a legacy
 * credential always reads "owed" until its first re-wrap mints a real revision.
 */
export const LEGACY_CREDENTIAL_REVISION = '__legacy_no_revision__';

/**
 * Resolve a credential row's comparable revision: the stored value, or {@link
 * LEGACY_CREDENTIAL_REVISION} when the row predates the field. Every degenerate case resolves to a
 * concrete string so the equality compares this function drives (the owed-ness check and the
 * write-authority `ConditionCheck`s) never has to special-case `undefined`.
 */
export function resolveCredentialRevision(
  row: Pick<CredentialRow, 'credentialRevision'> | null | undefined,
): string {
  return row?.credentialRevision ?? LEGACY_CREDENTIAL_REVISION;
}

/**
 * A value no credential row's `credentialRevision` (real or {@link LEGACY_CREDENTIAL_REVISION}) can
 * ever equal. Used as the expected value in a password-slot write-authority condition when the
 * caller's session carries no recorded revision at all (every session alive before this shipped,
 * and any session whose refresh cookie cannot be resolved) — the `ConditionCheck`/conditional `Put`
 * then always fails, rejecting the write as a condition of the same commit rather than a preceding
 * branch.
 */
export const NO_SESSION_REVISION_SENTINEL = '__no_session_revision__';

/** Canonical slot id every `password`-type key-envelope row lives at.
 * Setup writes it; rotation reuses the existing
 * slot's id, which is always this literal. A `password`-type slot found at
 * any other id is refused, never migrated. */
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
   * True when this passkey was enrolled inside a password-reset restriction
   * window (the compensating control for the
   * reset→inbox-takeover path). Durable/sticky — set once at write time by
   * `resolveOpenResetWindow` and NEVER derived at read time, so it stays
   * `true` after the window that set it has closed, until an explicit
   * `confirm-restriction` lifts it. While `true` the credential cannot
   * satisfy a step-up, cannot be offered or accepted as a login/MFA factor,
   * and cannot re-confirm another restricted factor. See
   * `factor-restriction.ts`.
   */
  restrictedPostReset?: boolean;
  /**
   * The ISO timestamp of the reset REQUEST that opened the window this
   * passkey was enrolled inside (never the completion time) — present only
   * while `restrictedPostReset` is true. The `confirm-restriction` lift
   * compares a candidate proving factor's own enrollment/creation timestamp
   * against this value server-side (the client never asserts which factor
   * predates what).
   */
  restrictedByResetRequestedAt?: string;
}

/**
 * One in-flight WebAuthn ceremony.
 * PK `key` — the caller's own namespaced string (`reg:<userId>`,
 * `stepup:<userId>:<purpose>:<challenge>`, `mfa:<userId>:<challenge>`,
 * `auth:<challenge>`; see `PasskeyChallengeStore`). The key string IS the
 * security binding — a challenge minted under one key is never reachable
 * under another. TTL on `expiresAt` is hygiene only (deletion lags up to
 * ~48h, and DynamoDB Local never sweeps at all): `PasskeyChallengeStore`
 * enforces the 5-minute window itself against this value at read time.
 */
export interface PasskeyChallengeRow {
  key: string;
  challenge: string;
  /** Present for every namespace except the discoverable-login `auth:` one. */
  userId?: string;
  /** Epoch-SECONDS — a numeric DynamoDB TTL value (hygiene only; see above). */
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
  // The deviceId the original login carried. Carried forward across all
  // rotations in the family so the rotated access token's `deviceId`
  // claim still matches the SPA's localStorage value (and therefore
  // the sync-controller's `dto.deviceId === me.deviceId` check passes).
  deviceId: string;
  // The householdId the original login carried. Persisted on every row in
  // the family so the rotated access token's `householdId` claim is the
  // real value rather than `userId` (1:1 in v1, but the right value is
  // free to add now and prevents a latent privilege-escalation bug if
  // the `userId === householdId` invariant is ever broken).
  householdId: string;
  createdAt: string;
  /**
   * The credential revision this session authenticated against —
   * the server-side write authority a
   * password-slot mutation is conditioned on, resolved per request from this
   * row rather than an access-token claim (a signed claim can't be amended
   * mid-session). Set at issuance: a password login records the just-verified
   * credential's revision; an MFA-verified login records the revision carried
   * on the login-minted challenge (never re-read at verify time); a
   * change-password re-issue records the revision its own commit just minted;
   * `POST /auth/verify-password` updates it on the CURRENT row in place
   * (no new session). A passwordless passkey sign-in records none. Rotation
   * (`RefreshTokenService.issue`) copies this field forward verbatim from the
   * predecessor row — never re-derived — so a chain that carries none (every
   * session alive before this field existed) keeps carrying none for its
   * whole life, and a write against such a session is rejected as a condition
   * of the same commit as the write.
   */
  credentialRevision?: string;
  /**
   * The account session generation this row
   * was stamped with at issuance — the value read from the `User` row's
   * `sessionGeneration` at fresh login, or carried forward VERBATIM across
   * every rotation in the family (never re-derived, mirroring
   * `credentialRevision` above). `RefreshTokenService.issue` conditions this
   * row's own Put, in the SAME transaction, on the `User` row's CURRENT
   * generation still equalling this value — an account-wide revoke that
   * lands first fails that condition and the row never commits. Absent only
   * on a row written before this field existed; the cutover rejects
   * such a row outright rather than treating it as generation 0.
   */
  sessionGeneration?: number;
}

export interface RevokedTokenRow {
  jti: string;
  userId: string;
  revokedAt: string;
  expiresAt: number; // TTL = original token's exp
  /**
   * Row discriminator. Absent on the
   * bare-UUID session/refresh revocation rows this table has always held.
   * `mfa_challenge` marks a single-use MFA-challenge consumption ledger row,
   * always keyed by the namespace-disjoint `mfa:<uuid>` jti so it can never
   * collide with a bare-UUID bearer-token revocation (and `isRevoked`, called
   * only with bare jtis, can never read one back).
   *
   * `generation_revoked` tombstones a
   * retired account session generation, keyed by the namespace-disjoint
   * `gen:<userId>:<generation>` jti — see
   * `RevokedTokensRepository.tombstoneGenerationTransactItem`.
   * `family_barrier` marks a token-family revocation barrier, keyed by the
   * namespace-disjoint `family:<tokenFamilyId>` jti — see
   * `RevokedTokensRepository.familyBarrierTransactItem`. Neither can ever
   * collide with a bare-UUID bearer-token revocation or an `mfa:`-prefixed
   * challenge row.
   */
  kind?: 'mfa_challenge' | 'generation_revoked' | 'family_barrier';
}

export interface FailedLoginAttemptRow {
  emailLowercase: string;
  /** Running miss count — advanced by an atomic `ADD` (never read/modify/write),
   *  so concurrent failures can't lose an increment.
   *  Absent on a row that holds only a guessing-notice stamp —
   *  readers must treat a missing value as zero, never NaN. */
  consecutiveFailures?: number;
  /** ISO timestamp of the latest miss. The effective backoff window is DERIVED
   *  from `consecutiveFailures` + this timestamp at check time — no separately
   *  stored/raced "next attempt after" value is trusted. Absent alongside
   *  a missing `consecutiveFailures`. */
  lastFailedAt?: string;
  expiresAt: number; // epoch-seconds TTL — 24h after last failure
  /**
   * ISO timestamp of the last guessing-notice email sent for this address.
   * `clear()` preserves this attribute across a
   * successful sign-in (an unconditional delete would let a second burst
   * within the same 24h re-notify) while still resetting the counter — a row
   * that then holds only this stamp reads as "not blocked" per the
   * `consecutiveFailures` guard above.
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
  // Self-service password reset. `password_reset_requested` is
  // appended only on a real reset-mail send (existing-verified user, past
  // cooldown, under cap) — never on a no-op branch — so the audit trail is
  // not a user-existence oracle. `password_reset` lands on a successful
  // consume. Both always carry the user's real `userId` (a real send / a
  // successful consume both imply a known user).
  | 'password_reset_requested'
  | 'password_reset'
  // Self-service account email change.
  // `email_change_requested` is appended when a re-authenticated user starts
  // a change (verification link mailed to the new address);
  // `email_change` lands on the successful confirm-time atomic swap. Both
  // carry the user's real `userId` (the requester is already
  // password-authenticated, so there is no enumeration oracle). The pending /
  // old email values are NOT logged in `metadata` (PII).
  | 'email_change_requested'
  | 'email_change'
  // Account-record correction: a
  // signed-in user corrects the `firstName`/`lastName`/`birthdate` on their
  // `User` row via `PATCH /auth/me`. Session-only — no password re-entry, no
  // MFA step-up. Carries the user's real `userId`. Which fields changed, by
  // name, is fine to log; the old and new values are PII and are NOT written
  // into `metadata` (mirrors the email_change pair above).
  | 'account_record_correction'
  // Data export re-auth. The
  // export gate calls verify-password with `purpose: 'data_export'`, routing
  // the audit event here instead of the generic password_verify pair.
  | 'data_export'
  | 'data_export_failed'
  | 'signup'
  | 'account_deletion_initiated'
  | 'account_deletion_completed'
  | 'signup_approval_requested'
  | 'signup_approved'
  | 'signup_declined'
  | 'signup_approval_expired'
  // Zero-knowledge key-envelope lifecycle. The server stores
  // wrapped key material opaquely; these audit the slot mutations.
  | 'key_envelope_created'
  | 'key_envelope_updated'
  | 'key_envelope_deleted'
  | 'key_envelope_rotated'
  // Account-preserving encrypted-workspace reset.
  | 'encrypted_workspace_reset_started'
  | 'encrypted_workspace_reset_completed'
  | 'encrypted_workspace_reset_failed'
  // Server-authoritative "Delete workspace data" clear. `workspace_clear_started` lands after a
  // successful password re-verify; `workspace_clear_completed` on a committed clear;
  // `workspace_clear_failed` on a rejected password / backoff lockout, when the optional
  // erase-history S3 purge fails (the clear itself still committed — a 2xx `historyErased:false`),
  // or on an unexpected server fault before/during the sweep (so a `_started` never dangles without
  // an ending). Every `_failed` row's `metadata.reason` says which: 'invalid_credentials' |
  // 'login_backoff' | 'history_purge_failed' | 'server_error'. `metadata` otherwise carries only
  // the household id; `currentPassword` is NEVER logged.
  | 'workspace_clear_started'
  | 'workspace_clear_completed'
  | 'workspace_clear_failed'
  // Enforced second-factor (MFA) lifecycle. Every
  // failure row carries the real `userId` — the user is already
  // password-authenticated at the MFA step, so there is no enumeration
  // oracle. Codes and TOTP secrets are NEVER logged in `metadata`.
  | 'mfa_challenge_issued'
  | 'mfa_totp_verified'
  | 'mfa_totp_failed'
  // Per-account TOTP lock threshold crossing: appended
  // exactly once per lock — on the miss that first carries the account's TOTP
  // failure count past the grace threshold. Not on a refusal while the window
  // is open (a refusal writes nothing), and not on a later miss that extends
  // an existing lock once its window has elapsed. Mapped onto the existing
  // `MfaVerifyFailed` metric (no new metric/alarm) by
  // `mapAuthEventToMetrics`.
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
  // Step-up re-auth for sensitive operations. The
  // shared `StepUpService.verify` emits `step_up_passed` / `step_up_failed`
  // with the operation `purpose` + factor `method` in `metadata`; the generic
  // prep endpoints emit `step_up_challenge` when a passkey challenge or an
  // Email-OTP code is minted for a purpose. Codes / assertions are NEVER logged.
  | 'step_up_challenge'
  | 'step_up_passed'
  | 'step_up_failed'
  // Factor-change notice + undo. Recorded when the
  // single-use undo link is successfully consumed — the notice send itself
  // is best-effort and unaudited (mirrors the reset/change-email security
  // notices, which also carry no dedicated "mail sent" event). `metadata`
  // carries the factor `kind` (see `UserRow.pendingFactorUndoKind`) and,
  // for a passkey kind, the `credentialId` acted on.
  | 'factor_undo_consumed'
  // Per-address guessing notice: appended when the
  // 10th consecutive per-address failure crosses the threshold AND the
  // once-per-24h stamp actually advances (never on an unknown email, never
  // more than once per day). Maps to no metric — `LoginFailed` already covers
  // the underlying failures.
  | 'login_guessing_notice_sent'
  // Gated factor enrollment. `factor_enrollment_blocked`
  // is a single queryable signal that the shared enrollment gate refused a
  // passkey/TOTP write (missing OR wrong password/factor), alongside the
  // specific `password_verify_failed` / `step_up_failed` row the underlying
  // check already wrote. `factor_restriction_applied` / `_lifted` mark a
  // factor entering/leaving the post-reset restricted state. `metadata`
  // carries `purpose` / `credentialId` / `factorType` only — never a proof.
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
 * One row per user holding their TOTP factor. PK `userId`.
 * The `totpSecret` is the RFC-6238 base32
 * shared secret, protected at rest by DynamoDB SSE on the dedicated
 * `user-mfa` table + a narrow api-role grant (the same isolation boundary
 * pattern as `HouseholdKeyEnvelope`) — no separate KMS CMK. The secret is
 * NEVER logged.
 */
export interface UserMfaRow {
  userId: string;
  /** Whether the TOTP factor is enrolled + confirmed (a live second factor). */
  totpEnabled: boolean;
  /** RFC-6238 base32 shared secret for the confirmed TOTP factor. Present
   * only once enrollment is confirmed; SSE-protected at rest. */
  totpSecret?: string;
  /** base32 secret minted by `enroll/start`, held until `enroll/confirm`
   * verifies a live code and promotes it to `totpSecret`. SSE-protected. */
  pendingTotpSecret?: string;
  /** ISO timestamp the TOTP factor was confirmed/enrolled. */
  enrolledAt?: string;
  /** ISO timestamp of the last successful TOTP verification. */
  lastVerifiedAt?: string;
  /**
   * The most recent RFC-6238 time step consumed by a **step-up** TOTP verify.
   * Additive attribute (no key/table change):
   * step-up TOTP is single-use per user — a verify passes `afterTimeStep` seeded
   * from this value so a reused step is rejected in-library, and commits the
   * matched step here via a conditional `UpdateItem`
   * (`attribute_not_exists(lastUsedTotpStepStepUp) OR lastUsedTotpStepStepUp < :step`)
   * to close the concurrent-double-use TOCTOU. The pure login-MFA path
   * (`verifyTotp`) does NOT touch this — only step-up consumes.
   */
  lastUsedTotpStepStepUp?: number;
  /**
   * Running per-account TOTP miss count — shared by
   * BOTH live-factor verify paths (`verifyTotp` login-MFA and
   * `verifyTotpForStepUp`), since a distributed-IP guesser can hit either.
   * Advanced only by `UserMfaRepository.reserveTotpAttempt` — a
   * compare-and-swap on the state an attempt observed, won only by an
   * attempt that is then actually compared — so a refused attempt never
   * moves it. This row carries **no TTL** (unlike `FailedLoginAttemptRow`),
   * so a stale count never expires on its own: the reservation resets rather
   * than continues the count when the observed `totpLastFailureAt` predates
   * the decay window. Cleared on a successful TOTP verification. Additive
   * attribute only — no key/table change.
   */
  totpFailureCount?: number;
  /** ISO timestamp of the latest TOTP miss; the lock window is derived from this +
   * `totpFailureCount` at check time (mirrors `FailedLoginAttemptRow`) — never a separately
   * stored/raced "next attempt after" value. */
  totpLastFailureAt?: string;
  /**
   * True when the CURRENT TOTP factor was (re-)confirmed inside a password-
   * reset restriction window. Same sticky
   * semantics as `PasskeyRow.restrictedPostReset` — set once at
   * `confirmTotpEnrollment` write time, never derived at read time, cleared
   * only by an explicit `confirm-restriction` lift. `disable()` replaces the
   * whole row (via `put`), so a disabled-then-re-enrolled factor never
   * inherits a stale flag.
   */
  totpRestrictedPostReset?: boolean;
  /**
   * The ISO timestamp of the reset REQUEST that opened the window this TOTP
   * factor was (re-)confirmed inside — present only while
   * `totpRestrictedPostReset` is true. Mirrors
   * `PasskeyRow.restrictedByResetRequestedAt`.
   */
  totpRestrictedByResetRequestedAt?: string;
  updatedAt: string;
}

/**
 * The live Email-OTP code hash for a user. PK `userId`,
 * TTL on `expiresAt` (~10 min) so an unused code self-purges. The daily-cap
 * + cooldown counters DELIBERATELY live on the `User` row
 * (`mfaEmailOtpSentDayKey` / `mfaEmailOtpSentToday` / `mfaEmailOtpLastSentAt`),
 * NOT here — this table's short TTL would wipe the counter and defeat the
 * cap. `codeHash` is the SHA-256 of the 6-digit code (hashed at the service
 * boundary, like the verification/reset tokens); the raw code is emailed and
 * never stored. `attempts` enforces a hard cap (5 wrong attempts invalidate
 * the code, forcing a resend).
 */
export interface MfaEmailOtpRow {
  /**
   * PK. For the login / change-email code this is the bare `userId`. For a
   * step-up code it is the namespaced value
   * `<userId>#stepup`, a distinct row from the login one so the two never
   * clobber each other. No key-schema change — same single-attribute PK, a
   * namespaced VALUE only.
   */
  userId: string;
  /** SHA-256 hash of the 6-digit code (never the raw code). */
  codeHash: string;
  /**
   * Epoch-SECONDS at which the code is no longer valid (~10 min) — a numeric
   * DynamoDB TTL value, so an abandoned code row
   * auto-purges. Readers reject a nonnumeric (legacy ISO-string) or elapsed
   * value; API responses convert it to an ISO string at the boundary.
   */
  expiresAt: number;
  /** ISO timestamp the code was sent. */
  sentAt: string;
  /** Wrong-attempt counter; hard cap of 5 invalidates the code. */
  attempts: number;
  /**
   * Operation purpose this step-up code authorizes — e.g. `delete_account`. Present ONLY on the
   * `<userId>#stepup` step-up row; verify checks `row.purpose === <op-purpose>` before consuming,
   * so a code minted for one op cannot authorize another. Absent on the login / change-email
   * `<userId>` row (that op is bound by its own challenge token / pending intent, not a purpose
   * stamp).
   */
  purpose?: string;
}

/**
 * One trusted-device record. PK `userId`, SK `deviceId`
 * (the stable localStorage value preserved across `dropLocalDatabase()` —
 * regenerated only on a full "clear data on this device" wipe, so a wiped
 * browser correctly becomes untrusted). A valid `device-trust` cookie whose
 * opaque secret SHA-256-hashes to `tokenHash` skips the MFA challenge for
 * ~30 days. Keyed on `(userId, deviceId)` so a different user on the same
 * browser misses user A's row and is correctly challenged (cross-user safety).
 * `tokenHash` mirrors the refresh-token at-rest pattern (store the hash,
 * never the raw secret).
 */
export interface TrustedDeviceRow {
  userId: string;
  deviceId: string;
  /** SHA-256 hash of the opaque device-trust secret (never the raw
   * secret, mirroring RefreshToken). */
  tokenHash: string;
  createdAt: string;
  /**
   * Epoch-SECONDS the trust expires (~30 days) — a numeric DynamoDB TTL value,
   * so an abandoned trust row auto-purges.
   * Readers reject a nonnumeric (legacy ISO-string) or elapsed value and
   * listings exclude expired rows; API responses convert it to an ISO string
   * at the boundary.
   */
  expiresAt: number;
  lastUsedAt: string;
  ip: string | null;
  userAgent: string | null;
  /**
   * Per-device consecutive-failure ceiling — a
   * trusted device serves NO backoff wait, only this ceiling. Advanced by an
   * atomic, existence-conditioned `ADD` (mirrors `FailedLoginAttemptsRepository
   * .increment`) so a raced increment can never mint a row missing `tokenHash`
   * / `expiresAt`. Crossing the ceiling deletes the row (revokes trust for
   * THIS device only); cleared on a successful password verification from
   * this device. Absent on a device that has never missed.
   */
  consecutiveFailures?: number;
  /** ISO timestamp of the latest miss counted above; monotonic like the
   *  `FailedLoginAttempt` row's `lastFailedAt`. Absent alongside a missing
   *  `consecutiveFailures`. */
  lastFailedAt?: string;
}

// ---------- Zero-knowledge key-envelope table ----------

/**
 * The kind of unlocker a key-envelope slot wraps the household data key
 * (HDK) for. `password` slots carry `kdf` metadata; `passkey_prf` carries
 * `prfSalt` + `credentialBinding`; `recovery` (HKDF over a high-entropy
 * random key), `passkey_prf` (PRF-derived), and `oidc` omit `kdf`. `oidc` is
 * inert OIDC-ready plumbing only — no OIDC login flow exists.
 */
type KeyEnvelopeSlotType =
  | 'password'
  | 'recovery'
  | 'passkey_prf'
  | 'oidc';

/**
 * KDF parameters for a password slot. Discriminated by `algorithm`: Argon2id
 * (`m`/`t`/`p`, the default for new slots) and the legacy
 * PBKDF2-HMAC-SHA-256 (`iterations`) retained read-only for pre-existing
 * slots. The server stores whichever shape the client sent verbatim and never
 * derives a key from it (it holds no password). Mirrors the web client's
 * `KdfParams` (apps/web/src/crypto/encryption-types.ts).
 */
export type KeyEnvelopeKdf = KeyEnvelopePbkdf2Kdf | KeyEnvelopeArgon2idKdf;

/** Legacy PBKDF2-HMAC-SHA-256 KDF parameters for a password slot. */
interface KeyEnvelopePbkdf2Kdf {
  algorithm: 'PBKDF2-HMAC-SHA-256';
  iterations: number;
  /** base64url per-slot random salt. */
  salt: string;
}

/** Argon2id KDF parameters for a new password slot. */
interface KeyEnvelopeArgon2idKdf {
  algorithm: 'Argon2id';
  /** memory cost (KiB). */
  m: number;
  /** time cost (passes). */
  t: number;
  /** parallelism (lanes). */
  p: number;
  /** base64url per-slot random salt. */
  salt: string;
}

/**
 * One wrapped-key slot for a household. PK `householdId`, SK `slotId`.
 * The server stores `wrappedKey` and all metadata opaquely: it never
 * unwraps, validates, decrypts, or logs the wrapped key material, and it
 * never recomputes the envelope-set HMAC (it holds no HDK).
 */
export interface HouseholdKeyEnvelopeRow {
  householdId: string;
  /** SK. Per-slot id. Never the `ENVELOPE_META` sentinel. */
  slotId: string;
  slotType: KeyEnvelopeSlotType;
  /**
   * Flat credential binding: the WebAuthn
   * credential ID a `passkey_prf` slot is bound to. `null`/absent for
   * password/recovery slots. Stored verbatim; for `passkey_prf` slots the
   * controller verifies it belongs to the caller. Retyped from the
   * former structured OIDC object — OIDC-slot binding is deferred until an
   * OAuth login flow lands.
   */
  credentialBinding?: string | null;
  /** Present for `password` slots; recovery/passkey-PRF/oidc slots omit it. */
  kdf?: KeyEnvelopeKdf;
  /** base64url PRF salt; present for `passkey_prf` slots. */
  prfSalt?: string;
  /** base64url authenticated AES-256-GCM wrap of the HDK. */
  wrappedKey: string;
  encryptionVersion: number;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string;
  /**
   * The credential revision this `password`-type slot was wrapped under —
   * server-written from the writing
   * session's recorded authority, NEVER taken from the request body. Absent
   * on every other slot type, and on a `password` slot written before this
   * field existed. A `password` slot whose revision does not equal the
   * credential's current revision — including one carrying no revision at
   * all — reads "owed" a re-wrap; the change-password
   * commit mints the new revision and stamps this field on the re-wrapped
   * slot in the same transaction, so a completed change is exactly not-owed.
   */
  credentialRevision?: string;
}

/** SK sentinel value distinguishing the per-household envelope-set meta row. */
export const ENVELOPE_META_SLOT_ID = 'ENVELOPE_META';

/**
 * SK prefix marking an ARCHIVED envelope row: a
 * displaced slot, or the displaced `ENVELOPE_META` row, from a version an
 * envelope write just superseded. Lives in the same `HouseholdKeyEnvelope`
 * partition (PK `householdId`) as live rows, namespaced under this prefix so
 * every partition-wide query (`listSlots`, `getStableEnvelopeSet`,
 * `deleteAllForHousehold`, account export) can exclude it centrally. Reserved
 * exactly like {@link ENVELOPE_META_SLOT_ID} — a client-chosen `:slotId` may
 * never start with it ({@link isArchiveSlotId}, `SlotIdValidationPipe`). Not
 * exported past this module — every other caller reaches it through
 * {@link isArchiveSlotId} / {@link archiveSlotId} / {@link archiveMetaSlotId}.
 */
const ARCHIVE_SLOT_ID_PREFIX = 'ARCHIVE#';

/** True when `slotId` names an archive row — never a live slot or the live
 *  `ENVELOPE_META` sentinel. */
export function isArchiveSlotId(slotId: string): boolean {
  return slotId.startsWith(ARCHIVE_SLOT_ID_PREFIX);
}

/**
 * Namespaced archive SK for a displaced slot row, keyed by the envelope-set
 * version it belonged to (so an archived id from an earlier displacement of
 * the same live `slotId` never collides with a later one).
 */
export function archiveSlotId(version: number, slotId: string): string {
  return `${ARCHIVE_SLOT_ID_PREFIX}${version}#${slotId}`;
}

/** Namespaced archive SK for a displaced `ENVELOPE_META` row. */
export function archiveMetaSlotId(version: number): string {
  return `${ARCHIVE_SLOT_ID_PREFIX}${version}#${ENVELOPE_META_SLOT_ID}`;
}

/**
 * Sort-key bounds of the archive namespace: a
 * `slotId` names an archive row iff
 * `ARCHIVE_SLOT_ID_LOWER_BOUND <= slotId < ARCHIVE_SLOT_ID_UPPER_BOUND`
 * (byte-wise, the order DynamoDB sorts string keys in). A live-set read can
 * therefore skip the whole archive range SERVER-SIDE with two key-condition
 * ranges — `slotId < lower` and `slotId >= upper` — instead of paging through
 * every archived version and dropping it in JS, so its cost never scales with
 * how many versions a household has archived inside the retention window.
 * The upper bound is the prefix with its last byte incremented (`ARCHIVE$`),
 * the smallest string that sorts after every `ARCHIVE#…` id.
 */
export const ARCHIVE_SLOT_ID_LOWER_BOUND = ARCHIVE_SLOT_ID_PREFIX;
export const ARCHIVE_SLOT_ID_UPPER_BOUND =
  ARCHIVE_SLOT_ID_PREFIX.slice(0, -1) +
  String.fromCharCode(ARCHIVE_SLOT_ID_PREFIX.charCodeAt(ARCHIVE_SLOT_ID_PREFIX.length - 1) + 1);

/**
 * An archived `ENVELOPE_META` row: the meta row
 * exactly as it stood at `envelopeSetVersion`, written at
 * {@link archiveMetaSlotId} inside the same transaction as the write that
 * superseded it. Beyond the live row's fields it carries:
 *
 * - `slotIds` — the id of EVERY slot that was live at that version. Archived slot rows only record what a later write DISPLACED,
 *   never what a version's membership WAS, so without this an operator
 *   cannot tell a slot added after the target version from one that was
 *   live then and never displaced since — and a restore that guesses wrong
 *   republishes a set whose `envelopeSetTag` cannot verify. The operator restore
 *   procedure (AGENTS.md, "Key-envelope archive recovery") keys off this list.
 * - `expiresAt` — the archive TTL ({@link archiveExpiresAt}). Never copied
 *   onto a live row: the table's TTL is keyed on the attribute alone.
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

/**
 * Retention window for archived envelope-set versions.
 * DynamoDB TTL deletes lazily (up to ~48h late) — this is a floor on
 * retention, not a ceiling, and must never back a deletion-scope guarantee.
 * Not exported — every caller reaches it through {@link archiveExpiresAt}.
 */
const ARCHIVE_RETENTION_DAYS = 30;

/** Epoch-seconds TTL stamp for an archive row written now. */
export function archiveExpiresAt(): number {
  return Math.floor(Date.now() / 1000) + ARCHIVE_RETENTION_DAYS * 24 * 60 * 60;
}

/**
 * Per-household envelope-set integrity row. Stored on the same table
 * as the slots with SK = `ENVELOPE_META`. The client computes the HMAC; the
 * server only enforces a monotonic `envelopeSetVersion` on write and echoes
 * the values back — it never recomputes or validates `envelopeSetTag`.
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
   * Set `true` at the START of the non-atomic `deleteAllForHousehold` sweep
   * (account deletion / encrypted-workspace reset) — before any slot row is
   * removed — and the sentinel row is deleted LAST, so the marker stays visible
   * for the whole sweep. A `getStableEnvelopeSet` bracket that observes
   * it treats the set as torn and fails closed (`503 ENVELOPE_READ_CONFLICT`)
   * rather than trusting a partially-swept slot set whose meta version/tag has
   * not yet changed. Absent on every ordinary row.
   */
  deletionInProgress?: boolean;
}
