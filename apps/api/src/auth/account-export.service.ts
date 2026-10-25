// Builds the account half of "Export my data": field-level projections of every store holding the user rows, never a whole row that
// carries a secret. Behind `GET /auth/account-export`.
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
 * The complete, ordered set of account-export sections; the API integration test derives its own expected set
 * independently, so dropping a section here or from `build` fails it.
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
 * Thrown when the User row is gone when read, i.e. a concurrent `DELETE /auth/account`. A bundle around a fabricated
 * empty record would be presented as a complete export while holding only the rows the sweep raced past, so it fails
 * closed.
 */
export class AccountExportUserGoneError extends Error {
  constructor(message = 'Account export could not be completed: the account no longer exists.') {
    super(message);
    this.name = 'AccountExportUserGoneError';
  }
}

/**
 * Thrown when the bracketed consistent User read around the email-keyed sections cannot settle within the bounded
 * retry. Exporting anyway could key them off an `emailLowercase` this user released, attaching a stranger reservation
 * or backoff activity once another signup recycles it.
 */
export class AccountExportEmailKeyReadConflictError extends Error {
  constructor(message = 'Account export could not read email-keyed records consistently; retry later.') {
    super(message);
    this.name = 'AccountExportEmailKeyReadConflictError';
  }
}

// Bounded attempts for the bracketed User read, as in `HouseholdKeyEnvelopesRepository` stable-set read.
const MAX_EMAIL_KEY_READ_ATTEMPTS = 3;

// Login-credential KDF: every `argon2.hash()` call passes only `{ type: argon2.argon2id }`, so these are node-argon2
// defaults, the actual cost under which live credentials are hashed (the row stores only the digest, which is
// omitted).
const LOGIN_CREDENTIAL_KDF = {
  algorithm: 'Argon2id',
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
} as const;

// Projected `User` row; the three `current*Token` fields are live bearer-token handles and are omitted.
type UserExportRow = Omit<
  UserRow,
  'currentVerificationToken' | 'currentResetToken' | 'currentPendingEmailToken'
>;

// Metadata only: `payload` ciphertext is omitted, its plaintext being the workspace `aggregates` section.
type MutationLogExportRow = Omit<MutationLogRow, 'payload'>;

// `verificationToken` (the PK) is a live bearer token and is omitted.
type EmailVerificationExportRow = Omit<EmailVerificationRow, 'verificationToken'>;

interface PasswordResetExportRow {
  createdAt: string;
  expiresAt: number;
}

// Email and timestamps; `approvalToken` (the PK, a live bearer token) and the redundant `userId` are omitted.
interface SignupApprovalExportRow {
  email: string;
  createdAt: string;
  expiresAt: number;
}

// `updatedAt` plus the login KDF algorithm and cost; `argon2Hash` is omitted.
interface CredentialExportRow {
  updatedAt: string;
  kdf: typeof LOGIN_CREDENTIAL_KDF;
}

// Every field is non-secret (the public key is stored, not the private).
type PasskeyExportRow = Pick<
  PasskeyRow,
  'credentialId' | 'publicKey' | 'counter' | 'deviceType' | 'backedUp' | 'transports' | 'createdAt' | 'lastUsedAt'
>;

// `tokenHash` (the SK) and `rotatedFrom` are token hashes and are omitted.
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

// 24-hour sign-in backoff state, labelled so in the bundle; not the retained sign-in history (`history`).
interface FailedLoginAttemptExportRow {
  /** Absent on a row holding only the guessing-notice stamp. */
  consecutiveFailures?: number;
  lastFailedAt?: string;
  expiresAt: number;
  note: 'This is 24-hour sign-in backoff state, not your full sign-in history. See "history" for that.';
}

// `wrappedKey`, `kdf.salt`, `prfSalt` and `credentialBinding` are omitted.
interface HouseholdKeyEnvelopeSlotExportRow {
  slotId: string;
  slotType: HouseholdKeyEnvelopeRow['slotType'];
  encryptionVersion: number;
  kdf?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string;
}

// The slots plus the meta `envelopeSetVersion` and `updatedAt` only: `envelopeSetTag` is computed from the household
// key and would be an offline oracle for it.
interface HouseholdKeyEnvelopeExportSection {
  slots: HouseholdKeyEnvelopeSlotExportRow[];
  meta: { envelopeSetVersion: number; updatedAt: string } | null;
}

// TOTP secrets and unknown legacy attributes are omitted.
interface UserMfaExportRow {
  totpEnabled: boolean;
  enrolledAt?: string;
  lastVerifiedAt?: string;
  updatedAt: string;
}

// `codeHash` is omitted.
interface MfaEmailOtpExportRow {
  sentAt: string;
  expiresAt: number;
  attempts: number;
  purpose?: string;
}

// Both MfaEmailOtp rows for a user: the login or change-email code and the step-up code.
interface MfaEmailOtpExportSection {
  login: MfaEmailOtpExportRow | null;
  stepUp: MfaEmailOtpExportRow | null;
}

// `tokenHash` is omitted.
interface TrustedDeviceExportRow {
  deviceId: string;
  createdAt: string;
  expiresAt: number;
  lastUsedAt: string;
  ip: string | null;
  userAgent: string | null;
}

// `cursorTag` is an HMAC over the exported `freshnessCounter`, so exporting it would give anyone with the bundle an
// offline oracle for candidate household data keys, as with `envelopeSetTag`.
type WorkspaceMetaExportRow = Omit<WorkspaceMetaRow, 'cursorTag'>;

export interface SnapshotInventoryExportRow {
  key: string;
  size: number;
  lastModified: string;
  isLive: boolean;
}

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

export interface AccountExportFirstPage extends AccountExportSections {
  history: AuthEventPage['items'];
  nextCursor: string | null;
}

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
   * Builds one page of the export. `cursor` is the opaque `history` cursor from a prior page (null for the first).
   * The first page carries every non-paging section fully materialized; later pages carry `history` only.
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
    // Bracketed consistent User read around the email-keyed sections: throws AccountExportUserGoneError if the User
    // is gone (no fabricated record) and AccountExportEmailKeyReadConflictError if the email cannot be confirmed
    // stable, so those sections are never keyed off a recycled address.
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
      // Slots and meta come from one stable snapshot, not two eventually consistent reads that could pair old slots
      // with new meta.
      this.householdKeyEnvelopes.getStableEnvelopeSet(householdId),
      this.userMfa.get(userId),
      this.mfaEmailOtp.get(userId),
      this.mfaEmailOtp.getStepUp(userId),
      this.trustedDevices.listByUser(userId),
      this.listSnapshotInventory(householdId),
    ]);

    // The live-snapshot key needs the resolved WorkspaceMeta pointer, so `isLive` is annotated afterwards.
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

  // The User row plus the two sections keyed by email (`emailReservations`, `failedLoginAttempt`), read inside a
  // bracketed strongly consistent User read. An email is recyclable: a stale `emailLowercase` released by a change
  // and claimed by another signup would return that account rows. Two consistent reads around the lookups catch a
  // mid-read change; `listEmailReservations` userId check is the defense for a release and reuse between the
  // brackets.
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

  // Both reservation rows for the user (live and pending email), verifying `userId` on each so a recycled key never
  // exports a stranger row.
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

  // Raw S3 inventory under `<householdId>/`, with no cap (the self-service list is capped at 50, but the export must
  // not truncate), reusing the existing ListBucket grant.
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
