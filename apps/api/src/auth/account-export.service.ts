/**
 * Builds the ACCOUNT half of "Export my data":
 * every store the database holds with rows attributable to the signed-in
 * person, as field-level projections — never whole rows where a row carries
 * a secret. The workspace half (the encrypted aggregates) is unchanged and
 * lives entirely client-side (apps/web/src/lib/server-data-export.ts); this
 * service is reached only through `GET /auth/account-export`
 * (account-export.controller.ts), which also requires the session-bound
 * export-authorization cookie.
 *
 * NON-PAGING sections below are fully materialized in ONE call (every
 * repository already loops its own internal DynamoDB pagination) and
 * returned on the FIRST page only. The sign-in/security history
 * (`AuthEvent` — the whole retained history, no window) is the one
 * section large enough to need HTTP-level paging; it pages behind an opaque
 * cursor and the response always carries `nextCursor`.
 *
 * `ACCOUNT_EXPORT_SECTION_KEYS` is the single source of truth for "every section this builder
 * assembles" — the API integration test asserts it against the accounted-for table in the test file
 * (derived independently from the `TABLE_*` config names), so dropping a section from the builder
 * OR from this constant both fail the test rather than passing silently.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { S3_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { EmailReservationsRepository } from '../dynamo/email-reservations.repository.js';
import { EmailVerificationsRepository } from '../dynamo/email-verifications.repository.js';
import { PasswordResetsRepository } from '../dynamo/password-resets.repository.js';
import { SignupApprovalsRepository } from '../dynamo/signup-approvals.repository.js';
import { CredentialsRepository } from '../dynamo/credentials.repository.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import { RefreshTokensRepository } from '../dynamo/refresh-tokens.repository.js';
import {
  RevokedTokensRepository,
  type RevokedTokenExportRow,
} from '../dynamo/revoked-tokens.repository.js';
import { FailedLoginAttemptsRepository } from '../dynamo/failed-login-attempts.repository.js';
import { sleep, backoffMs } from '../dynamo/transact-write.js';
import {
  AuthEventsRepository,
  type AuthEventPage,
} from '../dynamo/auth-events.repository.js';
import { HouseholdKeyEnvelopesRepository } from '../dynamo/household-key-envelopes.repository.js';
import { UserMfaRepository } from '../dynamo/user-mfa.repository.js';
import { MfaEmailOtpRepository } from '../dynamo/mfa-email-otp.repository.js';
import { TrustedDeviceRepository } from '../dynamo/trusted-device.repository.js';
import { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import { MutationLogRepository } from '../dynamo/mutation-log.repository.js';
import { AggregateVersionRepository } from '../dynamo/aggregate-version.repository.js';
import { IdempotencyKeyRepository } from '../dynamo/idempotency-key.repository.js';
import { DeviceRegistryRepository } from '../dynamo/device-registry.repository.js';
import type {
  AggregateVersionRow,
  DeviceRegistryRow,
  EmailReservationRow,
  EmailVerificationRow,
  FailedLoginAttemptRow,
  HouseholdKeyEnvelopeRow,
  IdempotencyKeyRow,
  MfaEmailOtpRow,
  MutationLogRow,
  PasskeyRow,
  SignupApprovalRow,
  TrustedDeviceRow,
  UserMfaRow,
  UserRow,
  WorkspaceMetaRow,
} from '../dynamo/types.js';

/**
 * The complete, ordered set of account-export sections. This IS the
 * accounted-for enumeration: `apps/api/src/test/account-export.spec.ts`
 * derives its own expected set independently (from the `TABLE_*` config
 * names) and asserts it against this constant, so deleting a section here —
 * or from {@link AccountExportService.build} — fails the test either way.
 */
export const ACCOUNT_EXPORT_SECTION_KEYS = [
  'workspaceMeta',
  'mutationLog',
  'aggregateVersion',
  'idempotencyKey',
  'deviceRegistry',
  'user',
  'emailReservations',
  'emailVerifications',
  'passwordReset',
  'signupApprovals',
  'credential',
  'passkeys',
  'refreshTokens',
  'revokedTokens',
  'failedLoginAttempt',
  'history', // AuthEvent — the one paging section
  'householdKeyEnvelope',
  'userMfa',
  'mfaEmailOtp',
  'trustedDevices',
  's3SnapshotInventory',
] as const;

/**
 * Thrown when the User row is gone by the time `buildNonPagingSections`
 * reads it — the only way to reach here despite `JwtAuthGuard` is a session
 * whose account was deleted mid-request (a concurrent `DELETE /auth/account`
 * in another tab). Building a bundle around a fabricated empty User record
 * would return `200` with a subset of rows the deletion sweep happened to
 * race past, presented to the browser as a complete export. Failing closed
 * here means no bundle is ever silently partial.
 */
export class AccountExportUserGoneError extends Error {
  constructor(message = 'Account export could not be completed: the account no longer exists.') {
    super(message);
    this.name = 'AccountExportUserGoneError';
  }
}

/**
 * Thrown when the bracketed, strongly-consistent User read around the
 * email-keyed sections (`emailReservations`, `failedLoginAttempt`) cannot
 * settle within the bounded retry: the live/pending email kept changing
 * between the two consistent reads. Exporting anyway risks keying those
 * lookups off an `emailLowercase` this user has since released — which,
 * once another signup recycles the address, would attach a stranger's
 * reservation row or sign-in backoff activity to this export.
 */
export class AccountExportEmailKeyReadConflictError extends Error {
  constructor(message = 'Account export could not read email-keyed records consistently; retry later.') {
    super(message);
    this.name = 'AccountExportEmailKeyReadConflictError';
  }
}

/** Bounded attempts for the bracketed consistent-User-read around the
 *  email-keyed sections (mirrors `HouseholdKeyEnvelopesRepository`'s own
 *  stable-set bracketing read). */
const MAX_EMAIL_KEY_READ_ATTEMPTS = 3;

/** Login-credential KDF: every `argon2.hash()` call
 *  in this codebase (`signup.service.ts`, `change-password.service.ts`,
 *  `password-reset.service.ts`) passes only `{ type: argon2.argon2id }`, so
 *  these are node-argon2's own Argon2id defaults — the ACTUAL cost
 *  parameters every live credential is hashed under, not per-row stored
 *  state (the row holds only the resulting digest, which is why
 *  `argon2Hash` itself is omitted from the export). */
const LOGIN_CREDENTIAL_KDF = {
  algorithm: 'Argon2id',
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
} as const;

/** Projected `User` row: the readable account record plus status and counters.
 *  The three `current*Token` pointer fields are omitted
 *  — they are live bearer-token handles. */
type UserExportRow = Omit<
  UserRow,
  'currentVerificationToken' | 'currentResetToken' | 'currentPendingEmailToken'
>;

/** Projected `MutationLog` row: metadata only. `payload` (ciphertext) is
 *  omitted — its plaintext is already the workspace `aggregates` section. */
type MutationLogExportRow = Omit<MutationLogRow, 'payload'>;

/** Projected `EmailVerification` row: `verificationToken` (the PK — a live
 *  bearer token) is omitted. */
type EmailVerificationExportRow = Omit<EmailVerificationRow, 'verificationToken'>;

/** Projected `PasswordReset` row: timestamps only. */
interface PasswordResetExportRow {
  createdAt: string;
  expiresAt: number;
}

/** Projected `SignupApproval` row: email + timestamps. `approvalToken` (the
 *  PK — a live bearer token) and the redundant `userId` are omitted. */
interface SignupApprovalExportRow {
  email: string;
  createdAt: string;
  expiresAt: number;
}

/** Projected `Credential` row: `updatedAt` plus the login KDF's algorithm
 *  and cost parameters. `argon2Hash` (salt + digest) is omitted. */
interface CredentialExportRow {
  updatedAt: string;
  kdf: typeof LOGIN_CREDENTIAL_KDF;
}

/** Projected `Passkey` row. Every field here is already non-secret (the
 *  public key, not the private key, lives server-side for WebAuthn). */
type PasskeyExportRow = Pick<
  PasskeyRow,
  'credentialId' | 'publicKey' | 'counter' | 'deviceType' | 'backedUp' | 'transports' | 'createdAt' | 'lastUsedAt'
>;

/** Projected `RefreshToken` row. `tokenHash` (the SK) and `rotatedFrom` are
 *  omitted — both are token hashes. */
interface RefreshTokenExportRow {
  deviceId: string;
  tokenFamilyId: string;
  jti: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: number;
  revokedAt: string | null;
}

/** Projected `FailedLoginAttempt` row. Labelled explicitly in the bundle as
 *  24-hour sign-in backoff state — NOT the retained sign-in history (that is
 *  `history`, below). */
interface FailedLoginAttemptExportRow {
  /** Absent on a row holding only the guessing-notice stamp — no counter to report. */
  consecutiveFailures?: number;
  lastFailedAt?: string;
  expiresAt: number;
  note: 'This is 24-hour sign-in backoff state, not your full sign-in history. See "history" for that.';
}

/** Projected `HouseholdKeyEnvelope` slot row. `wrappedKey`, `kdf.salt`,
 *  `prfSalt`, and `credentialBinding` are omitted. */
interface HouseholdKeyEnvelopeSlotExportRow {
  slotId: string;
  slotType: HouseholdKeyEnvelopeRow['slotType'];
  encryptionVersion: number;
  kdf?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string;
}

/** Projected `HouseholdKeyEnvelope` section: the slots above plus the meta
 *  row's `envelopeSetVersion` + `updatedAt` ONLY — `envelopeSetTag` is
 *  omitted (it is a tag computed from the household key and would be an
 *  offline oracle for it). */
interface HouseholdKeyEnvelopeExportSection {
  slots: HouseholdKeyEnvelopeSlotExportRow[];
  meta: { envelopeSetVersion: number; updatedAt: string } | null;
}

/** Projected `UserMfa` row. TOTP secrets and unknown legacy attributes are omitted. */
interface UserMfaExportRow {
  totpEnabled: boolean;
  enrolledAt?: string;
  lastVerifiedAt?: string;
  updatedAt: string;
}

/** Projected `MfaEmailOtp` row. `codeHash` is omitted. */
interface MfaEmailOtpExportRow {
  sentAt: string;
  expiresAt: number;
  attempts: number;
  purpose?: string;
}

/** Both `MfaEmailOtp` rows attributable to a user: the login/change-email
 *  code and the namespaced step-up code. */
interface MfaEmailOtpExportSection {
  login: MfaEmailOtpExportRow | null;
  stepUp: MfaEmailOtpExportRow | null;
}

/** Projected `TrustedDevice` row. `tokenHash` is omitted. */
interface TrustedDeviceExportRow {
  deviceId: string;
  createdAt: string;
  expiresAt: number;
  lastUsedAt: string;
  ip: string | null;
  userAgent: string | null;
}

/** Projected `WorkspaceMeta` row. `cursorTag` is omitted: it is
 *  `HMAC(HKDF(HDK,"cursor-auth"), canonical(freshnessCounter))` — the same
 *  export also carries `freshnessCounter` (the known message), so serializing
 *  `cursorTag` wholesale would hand anyone with the export an offline oracle
 *  to verify candidate household data keys, the same class of leak
 *  `envelopeSetTag` is already excluded for above. */
type WorkspaceMetaExportRow = Omit<WorkspaceMetaRow, 'cursorTag'>;

/** One S3 snapshot object's inventory metadata (no bytes). */
export interface SnapshotInventoryExportRow {
  key: string;
  size: number;
  lastModified: string;
  isLive: boolean;
}

/** Every non-paging section, fully materialized. */
export interface AccountExportSections {
  workspaceMeta: WorkspaceMetaExportRow | null;
  mutationLog: MutationLogExportRow[];
  aggregateVersion: AggregateVersionRow[];
  idempotencyKey: IdempotencyKeyRow[];
  deviceRegistry: DeviceRegistryRow[];
  user: UserExportRow;
  emailReservations: EmailReservationRow[];
  emailVerifications: EmailVerificationExportRow[];
  passwordReset: PasswordResetExportRow | null;
  signupApprovals: SignupApprovalExportRow[];
  credential: CredentialExportRow | null;
  passkeys: PasskeyExportRow[];
  refreshTokens: RefreshTokenExportRow[];
  revokedTokens: RevokedTokenExportRow[];
  failedLoginAttempt: FailedLoginAttemptExportRow | null;
  householdKeyEnvelope: HouseholdKeyEnvelopeExportSection;
  userMfa: UserMfaExportRow | null;
  mfaEmailOtp: MfaEmailOtpExportSection;
  trustedDevices: TrustedDeviceExportRow[];
  s3SnapshotInventory: SnapshotInventoryExportRow[];
}

/** The first-page response: every non-paging section plus the first page of
 *  `history`. */
export interface AccountExportFirstPage extends AccountExportSections {
  history: AuthEventPage['items'];
  nextCursor: string | null;
}

/** A subsequent-page response: `history` only ("non-paging sections are returned on the first page
 * only"). */
export interface AccountExportNextPage {
  history: AuthEventPage['items'];
  nextCursor: string | null;
}

@Injectable()
export class AccountExportService {
  private readonly snapshotsBucket: string;

  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    config: ConfigService<EnvConfig, true>,
    private readonly users: UsersRepository,
    private readonly emailReservations: EmailReservationsRepository,
    private readonly emailVerifications: EmailVerificationsRepository,
    private readonly passwordResets: PasswordResetsRepository,
    private readonly signupApprovals: SignupApprovalsRepository,
    private readonly credentials: CredentialsRepository,
    private readonly passkeys: PasskeysRepository,
    private readonly refreshTokens: RefreshTokensRepository,
    private readonly revokedTokens: RevokedTokensRepository,
    private readonly failedLoginAttempts: FailedLoginAttemptsRepository,
    private readonly authEvents: AuthEventsRepository,
    private readonly householdKeyEnvelopes: HouseholdKeyEnvelopesRepository,
    private readonly userMfa: UserMfaRepository,
    private readonly mfaEmailOtp: MfaEmailOtpRepository,
    private readonly trustedDevices: TrustedDeviceRepository,
    private readonly workspaceMeta: WorkspaceMetaRepository,
    private readonly mutationLog: MutationLogRepository,
    private readonly aggregateVersion: AggregateVersionRepository,
    private readonly idempotencyKey: IdempotencyKeyRepository,
    private readonly deviceRegistry: DeviceRegistryRepository,
  ) {
    this.snapshotsBucket = config.get('SNAPSHOTS_BUCKET', { infer: true });
  }

  /**
   * Build one page of the account export for `(userId, householdId)`. `cursor`
   * is the opaque `history` cursor from a prior call, or `null`/`undefined`
   * for the first page. The first page carries every non-paging section fully
   * materialized (each already loops its own DynamoDB pagination — never
   * silently truncated); every later page carries `history` only.
   */
  async build(
    userId: string,
    householdId: string,
    cursor: string | null,
  ): Promise<AccountExportFirstPage | AccountExportNextPage> {
    const historyPage = await this.authEvents.listForUser(userId, { cursor });
    if (cursor) {
      return { history: historyPage.items, nextCursor: historyPage.nextCursor };
    }
    const sections = await this.buildNonPagingSections(userId, householdId);
    return {
      ...sections,
      history: historyPage.items,
      nextCursor: historyPage.nextCursor,
    };
  }

  private async buildNonPagingSections(
    userId: string,
    householdId: string,
  ): Promise<AccountExportSections> {
    // Bracketed, strongly-consistent User read around the email-keyed
    // sections (`emailReservations`, `failedLoginAttempt`) — throws
    // {@link AccountExportUserGoneError} if the User row is gone (a
    // concurrent account deletion) rather than fabricating an empty account
    // record, and {@link AccountExportEmailKeyReadConflictError} if the
    // live/pending email cannot be confirmed stable within the bounded
    // retry, so this export never keys those two sections off a recycled
    // `emailLowercase`.
    const { user, emailReservationRows, failedLoginAttemptRow } =
      await this.readUserAndEmailKeyedSections(userId);
    const userExport: UserExportRow = stripUserSecrets(user);

    const [
      workspaceMetaRow,
      mutationLogRows,
      aggregateVersionRows,
      idempotencyKeyRows,
      deviceRegistryRows,
      emailVerificationRows,
      signupApprovalRows,
      credentialRow,
      passkeyRows,
      refreshTokenRows,
      revokedTokenRows,
      { slots, meta },
      userMfaRow,
      mfaEmailOtpLogin,
      mfaEmailOtpStepUp,
      trustedDeviceRows,
      s3Inventory,
    ] = await Promise.all([
      this.workspaceMeta.find(householdId),
      this.mutationLog.listForHousehold(householdId),
      this.aggregateVersion.listForHousehold(householdId),
      this.idempotencyKey.listForHousehold(householdId),
      this.deviceRegistry.listForHousehold(householdId),
      this.emailVerifications.listForUser(userId),
      this.signupApprovals.listForUser(userId),
      this.credentials.findByUserId(userId),
      this.passkeys.listForUser(userId),
      this.refreshTokens.listAllForUser(userId),
      this.revokedTokens.listForUser(userId),
      // Bracketed, strongly-consistent read — slots and meta come from
      // the SAME stable snapshot rather than two independent eventually
      // consistent reads, which could otherwise race a concurrent rotation
      // and combine old slots with new meta or vice versa.
      this.householdKeyEnvelopes.getStableEnvelopeSet(householdId),
      this.userMfa.get(userId),
      this.mfaEmailOtp.get(userId),
      this.mfaEmailOtp.getStepUp(userId),
      this.trustedDevices.listByUser(userId),
      this.listSnapshotInventory(householdId),
    ]);

    // The live snapshot's key needs the (now-resolved) WorkspaceMeta pointer,
    // so annotate `isLive` after both are in hand rather than threading the
    // pointer through `listSnapshotInventory`.
    const livePointer = workspaceMetaRow?.latestSnapshotId
      ? `${householdId}/${workspaceMetaRow.latestSnapshotId}.json.gz`
      : null;
    const s3SnapshotInventory: SnapshotInventoryExportRow[] = s3Inventory.map((item) => ({
      ...item,
      isLive: livePointer !== null && item.key === livePointer,
    }));

    const passwordResetRow = user.currentResetToken
      ? await this.passwordResets.findByToken(user.currentResetToken)
      : null;

    return {
      workspaceMeta: workspaceMetaRow ? projectWorkspaceMeta(workspaceMetaRow) : null,
      mutationLog: mutationLogRows.map(stripMutationLogPayload),
      aggregateVersion: aggregateVersionRows,
      idempotencyKey: idempotencyKeyRows,
      deviceRegistry: deviceRegistryRows,
      user: userExport,
      emailReservations: emailReservationRows,
      emailVerifications: emailVerificationRows.map(stripVerificationToken),
      passwordReset: passwordResetRow
        ? { createdAt: passwordResetRow.createdAt, expiresAt: passwordResetRow.expiresAt }
        : null,
      signupApprovals: signupApprovalRows.map(projectSignupApproval),
      credential: credentialRow
        ? { updatedAt: credentialRow.updatedAt, kdf: LOGIN_CREDENTIAL_KDF }
        : null,
      passkeys: passkeyRows.map(projectPasskey),
      refreshTokens: refreshTokenRows.map(projectRefreshToken),
      revokedTokens: revokedTokenRows,
      failedLoginAttempt: failedLoginAttemptRow
        ? {
            consecutiveFailures: failedLoginAttemptRow.consecutiveFailures,
            lastFailedAt: failedLoginAttemptRow.lastFailedAt,
            expiresAt: failedLoginAttemptRow.expiresAt,
            note: 'This is 24-hour sign-in backoff state, not your full sign-in history. See "history" for that.',
          }
        : null,
      householdKeyEnvelope: {
        slots: slots.map(projectEnvelopeSlot),
        meta: meta ? { envelopeSetVersion: meta.envelopeSetVersion, updatedAt: meta.updatedAt } : null,
      },
      userMfa: userMfaRow ? projectUserMfa(userMfaRow) : null,
      mfaEmailOtp: {
        login: mfaEmailOtpLogin ? projectMfaEmailOtp(mfaEmailOtpLogin) : null,
        stepUp: mfaEmailOtpStepUp ? projectMfaEmailOtp(mfaEmailOtpStepUp) : null,
      },
      trustedDevices: trustedDeviceRows.map(projectTrustedDevice),
      s3SnapshotInventory,
    };
  }

  /**
   * The User row plus the two sections keyed off its email addresses rather
   * than its `userId` (`emailReservations`, `failedLoginAttempt`), read
   * together inside a bracketed, strongly-consistent User read.
   *
   * `EmailReservation` and `FailedLoginAttempt` are both keyed by
   * `emailLowercase`, and an email address is RECYCLABLE: once a user
   * confirms an email change, the released address can be claimed by a
   * different signup. A plain eventually-consistent `findById` can hand back
   * a stale `emailLowercase` the caller has already released — and once
   * another account claims it, `findByEmail`/`find` on that address returns
   * THAT account's rows, not this caller's. Bracketing two strongly-
   * consistent reads around the email-keyed lookups (mirroring the
   * key-envelope stable-set read) catches a change that lands mid-read;
   * {@link listEmailReservations}'s own `userId` check below is the
   * remaining defense for a release+reuse that completes strictly between
   * the two brackets.
   *
   * @throws {AccountExportUserGoneError} if the User row is gone.
   * @throws {AccountExportEmailKeyReadConflictError} if the live/pending
   *   email cannot be confirmed stable within the bounded retry.
   */
  private async readUserAndEmailKeyedSections(userId: string): Promise<{
    user: UserRow;
    emailReservationRows: EmailReservationRow[];
    failedLoginAttemptRow: FailedLoginAttemptRow | null;
  }> {
    for (let attempt = 1; attempt <= MAX_EMAIL_KEY_READ_ATTEMPTS; attempt++) {
      const userBefore = await this.users.findByIdConsistent(userId);
      if (!userBefore) throw new AccountExportUserGoneError();

      const [emailReservationRows, failedLoginAttemptRow] = await Promise.all([
        this.listEmailReservations(userBefore),
        this.failedLoginAttempts.find(userBefore.emailLowercase),
      ]);

      const userAfter = await this.users.findByIdConsistent(userId);
      if (!userAfter) throw new AccountExportUserGoneError();
      if (
        userAfter.emailLowercase === userBefore.emailLowercase &&
        userAfter.pendingEmailLowercase === userBefore.pendingEmailLowercase
      ) {
        return { user: userAfter, emailReservationRows, failedLoginAttemptRow };
      }
      if (attempt < MAX_EMAIL_KEY_READ_ATTEMPTS) await sleep(backoffMs(attempt));
    }
    throw new AccountExportEmailKeyReadConflictError();
  }

  /** Both reservation rows attributable to the user: the live email and,
   *  when a change-email request is in flight, the pending one. Verifies
   *  `userId` on every returned row — never exports a reservation that does
   *  not actually belong to this user, even if it was reached by a recycled
   *  `emailLowercase` key (see {@link readUserAndEmailKeyedSections}). */
  private async listEmailReservations(user: UserRow): Promise<EmailReservationRow[]> {
    const out: EmailReservationRow[] = [];
    const live = await this.emailReservations.findByEmail(user.emailLowercase);
    if (live && live.userId === user.userId) out.push(live);
    if (user.pendingEmailLowercase) {
      const pending = await this.emailReservations.findByEmail(user.pendingEmailLowercase);
      if (pending && pending.userId === user.userId) out.push(pending);
    }
    return out;
  }

  /**
   * Raw S3 object inventory under `<householdId>/`, no bytes, no cap
   * (Snapshots.list() is capped at 50 for the self-service UI; the export
   * must never silently truncate). Reuses the already-granted `ListBucket` +
   * bucket-scoped resource — no new grant.
   */
  private async listSnapshotInventory(
    householdId: string,
  ): Promise<Omit<SnapshotInventoryExportRow, 'isLive'>[]> {
    const prefix = `${householdId}/`;
    const items: Omit<SnapshotInventoryExportRow, 'isLive'>[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.snapshotsBucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of r.Contents ?? []) {
        if (!obj.Key) continue;
        items.push({
          key: obj.Key,
          size: obj.Size ?? 0,
          lastModified: (obj.LastModified ?? new Date(0)).toISOString(),
        });
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return items;
  }
}

function stripUserSecrets(user: UserRow): UserExportRow {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit: strip the live bearer-token pointer fields from the result
  const { currentVerificationToken: _cvt, currentResetToken: _crt, currentPendingEmailToken: _cpet, ...rest } = user;
  return rest;
}

function projectWorkspaceMeta(row: WorkspaceMetaRow): WorkspaceMetaExportRow {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit: strip the HDK-derived cursor-auth tag (see WorkspaceMetaExportRow doc comment) from the result
  const { cursorTag: _cursorTag, ...rest } = row;
  return rest;
}

function stripMutationLogPayload(row: MutationLogRow): MutationLogExportRow {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit: strip ciphertext payload from the result
  const { payload: _payload, ...rest } = row;
  return rest;
}

function stripVerificationToken(row: EmailVerificationRow): EmailVerificationExportRow {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit: strip the live bearer token (the PK) from the result
  const { verificationToken: _vt, ...rest } = row;
  return rest;
}

function projectSignupApproval(row: SignupApprovalRow): SignupApprovalExportRow {
  return { email: row.email, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

function projectPasskey(row: PasskeyRow): PasskeyExportRow {
  return {
    credentialId: row.credentialId,
    publicKey: row.publicKey,
    counter: row.counter,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    transports: row.transports,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function projectRefreshToken(row: {
  deviceId: string;
  tokenFamilyId: string;
  jti: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: number;
  revokedAt: string | null;
}): RefreshTokenExportRow {
  return {
    deviceId: row.deviceId,
    tokenFamilyId: row.tokenFamilyId,
    jti: row.jti,
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

function projectEnvelopeSlot(row: HouseholdKeyEnvelopeRow): HouseholdKeyEnvelopeSlotExportRow {
  const kdf = row.kdf
    ? row.kdf.algorithm === 'Argon2id'
      ? { algorithm: row.kdf.algorithm, m: row.kdf.m, t: row.kdf.t, p: row.kdf.p }
      : { algorithm: row.kdf.algorithm, iterations: row.kdf.iterations }
    : undefined;
  return {
    slotId: row.slotId,
    slotType: row.slotType,
    encryptionVersion: row.encryptionVersion,
    ...(kdf ? { kdf } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.rotatedAt ? { rotatedAt: row.rotatedAt } : {}),
  };
}

function projectUserMfa(row: UserMfaRow): UserMfaExportRow {
  return {
    totpEnabled: row.totpEnabled,
    ...(row.enrolledAt ? { enrolledAt: row.enrolledAt } : {}),
    ...(row.lastVerifiedAt ? { lastVerifiedAt: row.lastVerifiedAt } : {}),
    updatedAt: row.updatedAt,
  };
}

function projectMfaEmailOtp(row: MfaEmailOtpRow): MfaEmailOtpExportRow {
  return {
    sentAt: row.sentAt,
    expiresAt: row.expiresAt,
    attempts: row.attempts,
    ...(row.purpose ? { purpose: row.purpose } : {}),
  };
}

function projectTrustedDevice(row: TrustedDeviceRow): TrustedDeviceExportRow {
  return {
    deviceId: row.deviceId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    ip: row.ip,
    userAgent: row.userAgent,
  };
}
