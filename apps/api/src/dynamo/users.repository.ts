import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import { runTransactWrite, type TransactItem } from './transact-write.js';
import type { UserRow } from './types.js';

// Thrown inside consumeFactorUndo transaction callback when the single-use condition fails; caught there.
class FactorUndoConditionFailed extends Error {
  constructor() {
    super('Factor-undo token is no longer the active one');
    this.name = 'FactorUndoConditionFailed';
  }
}

// Session-generation write-authority condition: `expectedGeneration` must equal the row current `sessionGeneration`,
// or the row must carry none and `expectedGeneration` be 0.
const SESSION_GENERATION_CONDITION_EXPRESSION =
  '(attribute_exists(sessionGeneration) AND sessionGeneration = :expectedGeneration) OR ' +
  '(attribute_not_exists(sessionGeneration) AND :expectedGeneration = :zeroGeneration)';

@Injectable()
export class UsersRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_USER');
  }

  async findById(userId: string): Promise<UserRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { userId } }),
    );
    return (r.Item as UserRow | undefined) ?? null;
  }

  /**
   * Strongly consistent `findById`. Needed where a stale null would be acted on: `SignupApprovalService.decline`
   * early-exits on a null user and would strand the pending rows with no retry path, and sign-in pins the session
   * generation, which a replica or the EmailIndex GSI can still hold after an account-wide revoke retired it, failing
   * the issuance ConditionCheck for a legitimate sign-in.
   */
  async findByIdConsistent(userId: string): Promise<UserRow | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { userId },
        ConsistentRead: true,
      }),
    );
    return (r.Item as UserRow | undefined) ?? null;
  }

  /**
   * True iff the user table has at least one row; drives the first-run redirect to /signup. Scan with Limit 1,
   * rate-limited at the controller.
   */
  async hasAnyUser(): Promise<boolean> {
    const r = await this.doc.send(
      new ScanCommand({
        TableName: this.tableName,
        Limit: 1,
        ProjectionExpression: 'userId',
      }),
    );
    return (r.Items?.length ?? 0) > 0;
  }

  async findByEmail(emailLowercase: string): Promise<UserRow | null> {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'EmailIndex',
        KeyConditionExpression: 'emailLowercase = :e',
        ExpressionAttributeValues: { ':e': emailLowercase },
        Limit: 1,
      }),
    );
    return ((r.Items?.[0] as UserRow | undefined) ?? null);
  }

  /** Marks a user email-verified (idempotent) and clears every unverified-signup tracking field in the same call. */
  async markEmailVerified(userId: string, at: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId },
        UpdateExpression:
          'SET emailVerifiedAt = :at, updatedAt = :at ' +
          'REMOVE signupExpiresAt, currentVerificationToken, ' +
          'lastVerificationSentAt, verificationsSentDayKey, verificationsSentToday',
        ExpressionAttributeValues: { ':at': at },
      }),
    );
  }

  async deleteByUserId(userId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { userId } }),
    );
  }

  /** Flips the approval gate; idempotent apart from the `updatedAt` bump. */
  async setApprovalStatus(
    userId: string,
    status: 'auto_approved' | 'pending' | 'approved' | 'declined',
  ): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId },
        UpdateExpression: 'SET approvalStatus = :s, updatedAt = :now',
        ExpressionAttributeValues: {
          ':s': status,
          ':now': new Date().toISOString(),
        },
      }),
    );
  }

  /**
   * Stamps the rotated verification-token handle and resend bookkeeping. `newToken` is the SHA-256 hash; the caller
   * hashes at the service boundary and this repo stores it verbatim.
   */
  async applyVerificationSend(args: {
    userId: string;
    newToken: string;
    sentAtIso: string;
    dayKey: number;
    countToday: number;
    signupExpiresAt: number;
  }): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId: args.userId },
        UpdateExpression:
          'SET currentVerificationToken = :tok, ' +
          'lastVerificationSentAt = :sent, ' +
          'verificationsSentDayKey = :day, ' +
          'verificationsSentToday = :count, ' +
          'signupExpiresAt = :exp, ' +
          'updatedAt = :sent',
        ExpressionAttributeValues: {
          ':tok': args.newToken,
          ':sent': args.sentAtIso,
          ':day': args.dayKey,
          ':count': args.countToday,
          ':exp': args.signupExpiresAt,
        },
      }),
    );
  }

  /**
   * Persists password-reset request bookkeeping: the active reset token hash (so the consume can pin it and account
   * deletion can sweep the row) and the cooldown and daily counters. The write is conditioned on the rate-limit
   * values the handler read (`observed`), closing the read-then-write TOCTOU (CODING_STANDARDS "Check-and-mutate
   * requires a transaction"): a losing concurrent request aborts the transaction and the service maps it to the
   * opaque no-op 202, so at most one send wins the cooldown window.
   */
  resetSendUpdate(args: {
    userId: string;
    newToken: string;
    sentAtIso: string;
    dayKey: number;
    countToday: number;
    observed: {
      lastResetSentAt?: string | null;
      resetsSentDayKey?: number | null;
      resetsSentToday?: number | null;
    };
  }): { tableName: string; key: { userId: string }; update: {
    UpdateExpression: string;
    ConditionExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  } } {
    // A guard term per rate-limit field: an absent observed value must still be absent, a present one must still
    // equal what the handler read.
    const values: Record<string, unknown> = {
      ':tok': args.newToken,
      ':sent': args.sentAtIso,
      ':day': args.dayKey,
      ':count': args.countToday,
    };
    const guard = (field: string, observed: string | number | null | undefined): string => {
      if (observed === null || observed === undefined) {
        return `attribute_not_exists(${field})`;
      }
      const placeholder = `:obs_${field}`;
      values[placeholder] = observed;
      return `${field} = ${placeholder}`;
    };
    const conditionExpression = [
      guard('lastResetSentAt', args.observed.lastResetSentAt),
      guard('resetsSentDayKey', args.observed.resetsSentDayKey),
      guard('resetsSentToday', args.observed.resetsSentToday),
    ].join(' AND ');
    return {
      tableName: this.tableName,
      key: { userId: args.userId },
      update: {
        UpdateExpression:
          'SET currentResetToken = :tok, ' +
          'lastResetSentAt = :sent, ' +
          // Same value as `lastResetSentAt` but not removed by `resetConsumeUpdate`, so `factor-restriction.ts` can still
          // resolve the request instant after the reset completes.
          'passwordResetRequestOpenedAt = :sent, ' +
          'resetsSentDayKey = :day, ' +
          'resetsSentToday = :count, ' +
          'updatedAt = :sent',
        ConditionExpression: conditionExpression,
        ExpressionAttributeValues: values,
      },
    };
  }

  /**
   * Builds the Email-OTP send bookkeeping update (daily-cap and cooldown counters) under a TOCTOU condition pinned to
   * the rate-limit state the handler read. The counters live on the User row because the MfaEmailOtp TTL would wipe
   * them. The code Put is deliberately not bundled into a cross-table transaction (a simplicity choice, not an IAM
   * limit): the service runs this conditional update first and Puts the code only after the guard commits, as
   * PasswordResetService does.
   */
  mfaEmailOtpSendUpdate(args: {
    userId: string;
    sentAtIso: string;
    dayKey: number;
    countToday: number;
    observed: {
      mfaEmailOtpLastSentAt?: string | null;
      mfaEmailOtpSentDayKey?: number | null;
      mfaEmailOtpSentToday?: number | null;
    };
  }): {
    TableName: string;
    Key: { userId: string };
    UpdateExpression: string;
    ConditionExpression: string;
    ExpressionAttributeNames: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
  } {
    const values: Record<string, unknown> = {
      ':sent': args.sentAtIso,
      ':day': args.dayKey,
      ':count': args.countToday,
    };
    const guard = (
      field: string,
      observed: string | number | null | undefined,
    ): string => {
      if (observed === null || observed === undefined) {
        return `attribute_not_exists(${field})`;
      }
      const placeholder = `:obs_${field}`;
      values[placeholder] = observed;
      return `${field} = ${placeholder}`;
    };
    const conditionExpression = [
      guard('mfaEmailOtpLastSentAt', args.observed.mfaEmailOtpLastSentAt),
      guard('mfaEmailOtpSentDayKey', args.observed.mfaEmailOtpSentDayKey),
      guard('mfaEmailOtpSentToday', args.observed.mfaEmailOtpSentToday),
    ].join(' AND ');
    return {
      TableName: this.tableName,
      Key: { userId: args.userId },
      UpdateExpression:
        'SET mfaEmailOtpLastSentAt = :sent, ' +
        'mfaEmailOtpSentDayKey = :day, ' +
        'mfaEmailOtpSentToday = :count, ' +
        'updatedAt = :sent',
      ConditionExpression: conditionExpression,
      ExpressionAttributeNames: {},
      ExpressionAttributeValues: values,
    };
  }

  /**
   * Builds the step-up Email-OTP send update: a separate budget on the `stepUpEmailOtp*` fields, so login and step-up
   * allowances never drain each other. Same TOCTOU condition and send ordering as `mfaEmailOtpSendUpdate`.
   */
  stepUpMfaEmailOtpSendUpdate(args: {
    userId: string;
    sentAtIso: string;
    dayKey: number;
    countToday: number;
    observed: {
      stepUpEmailOtpLastSentAt?: string | null;
      stepUpEmailOtpSentDayKey?: number | null;
      stepUpEmailOtpSentToday?: number | null;
    };
  }): {
    TableName: string;
    Key: { userId: string };
    UpdateExpression: string;
    ConditionExpression: string;
    ExpressionAttributeNames: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
  } {
    const values: Record<string, unknown> = {
      ':sent': args.sentAtIso,
      ':day': args.dayKey,
      ':count': args.countToday,
    };
    const guard = (
      field: string,
      observed: string | number | null | undefined,
    ): string => {
      if (observed === null || observed === undefined) {
        return `attribute_not_exists(${field})`;
      }
      const placeholder = `:obs_${field}`;
      values[placeholder] = observed;
      return `${field} = ${placeholder}`;
    };
    const conditionExpression = [
      guard('stepUpEmailOtpLastSentAt', args.observed.stepUpEmailOtpLastSentAt),
      guard('stepUpEmailOtpSentDayKey', args.observed.stepUpEmailOtpSentDayKey),
      guard('stepUpEmailOtpSentToday', args.observed.stepUpEmailOtpSentToday),
    ].join(' AND ');
    return {
      TableName: this.tableName,
      Key: { userId: args.userId },
      UpdateExpression:
        'SET stepUpEmailOtpLastSentAt = :sent, ' +
        'stepUpEmailOtpSentDayKey = :day, ' +
        'stepUpEmailOtpSentToday = :count, ' +
        'updatedAt = :sent',
      ConditionExpression: conditionExpression,
      ExpressionAttributeNames: {},
      ExpressionAttributeValues: values,
    };
  }

  /**
   * Builds the consume-side User update: clears the reset token and counters, conditioned on the presented token hash
   * still being current. Returned as parts for the single consume TransactWriteItems, so a superseded link can never
   * rotate the password.
   */
  resetConsumeUpdate(args: {
    userId: string;
    presentedToken: string;
    requestedAt: string;
    now: string;
  }): { tableName: string; key: { userId: string }; update: {
    UpdateExpression: string;
    ConditionExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  } } {
    return {
      tableName: this.tableName,
      key: { userId: args.userId },
      update: {
        UpdateExpression:
          // `lastPasswordResetCompletedAt` and `lastPasswordResetCompletedRequestedAt` (the consumed row own `createdAt`)
          // are the durable completion trace `factor-restriction.ts` resolves the completed branch from; a later
          // unconsumed request overwrites `passwordResetRequestOpenedAt`, which is deliberately not removed here, so it
          // cannot cancel the window.
          'SET updatedAt = :now, lastPasswordResetCompletedAt = :now, ' +
          'lastPasswordResetCompletedRequestedAt = :reqAt ' +
          'REMOVE currentResetToken, lastResetSentAt, ' +
          'resetsSentDayKey, resetsSentToday',
        ConditionExpression: 'currentResetToken = :tok',
        ExpressionAttributeValues: {
          ':now': args.now,
          ':tok': args.presentedToken,
          ':reqAt': args.requestedAt,
        },
      },
    };
  }

  // ---------- Self-service email change ----------

  /**
   * Persists the pending email-change intent (`pendingEmail`, `pendingEmailLowercase`, a ~15-minute
   * `pendingEmailExpiresAt`) after the password re-auth and uniqueness pre-check; a fresh request overwrites any
   * prior intent. The change-email token is minted only once step-up completes.
   */
  async setPendingEmail(args: {
    userId: string;
    pendingEmail: string;
    pendingEmailLowercase: string;
    expiresAt: number;
    now: string;
  }): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId: args.userId },
        UpdateExpression:
          'SET pendingEmail = :pe, pendingEmailLowercase = :pel, ' +
          'pendingEmailExpiresAt = :exp, updatedAt = :now ' +
          'REMOVE currentPendingEmailToken',
        ExpressionAttributeValues: {
          ':pe': args.pendingEmail,
          ':pel': args.pendingEmailLowercase,
          ':exp': args.expiresAt,
          ':now': args.now,
        },
      }),
    );
  }

  /**
   * Stamps the active change-email token hash and send bookkeeping. Conditioned on `pendingEmailLowercase == :pel`,
   * so a send superseded by a newer `setPendingEmail` aborts.
   */
  pendingEmailSendUpdate(args: {
    userId: string;
    pendingEmailLowercase: string;
    newToken: string;
    sentAtIso: string;
    dayKey: number;
    countToday: number;
    observed: {
      lastPendingEmailSentAt?: string | null;
      pendingEmailSentDayKey?: number | null;
      pendingEmailSentToday?: number | null;
    };
  }): {
    tableName: string;
    key: { userId: string };
    update: {
      UpdateExpression: string;
      ConditionExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
    };
  } {
    // Pin the pending intent and the rate-limit state, so two concurrent sends that passed the pre-check cannot both
    // commit.
    const values: Record<string, unknown> = {
      ':tok': args.newToken,
      ':sent': args.sentAtIso,
      ':day': args.dayKey,
      ':count': args.countToday,
      ':pel': args.pendingEmailLowercase,
    };
    const guard = (field: string, observed: string | number | null | undefined): string => {
      if (observed === null || observed === undefined) {
        return `attribute_not_exists(${field})`;
      }
      const placeholder = `:obs_${field}`;
      values[placeholder] = observed;
      return `${field} = ${placeholder}`;
    };
    const conditionExpression = [
      'pendingEmailLowercase = :pel',
      guard('lastPendingEmailSentAt', args.observed.lastPendingEmailSentAt),
      guard('pendingEmailSentDayKey', args.observed.pendingEmailSentDayKey),
      guard('pendingEmailSentToday', args.observed.pendingEmailSentToday),
    ].join(' AND ');
    return {
      tableName: this.tableName,
      key: { userId: args.userId },
      update: {
        UpdateExpression:
          'SET currentPendingEmailToken = :tok, ' +
          'lastPendingEmailSentAt = :sent, ' +
          'pendingEmailSentDayKey = :day, ' +
          'pendingEmailSentToday = :count, ' +
          'updatedAt = :sent',
        ConditionExpression: conditionExpression,
        ExpressionAttributeValues: values,
      },
    };
  }

  /**
   * Clears the pending password-reset handle and counters after a committed email swap drops the PasswordReset row,
   * so a reset link cannot mail the old address. With `expectedToken`, the clear is conditioned on it so a reset
   * minted after the swap is not wiped; that ConditionalCheckFailed is benign and swallowed.
   */
  async clearPendingResetHandle(userId: string, expectedToken?: string): Promise<void> {
    const eav: Record<string, unknown> = { ':now': new Date().toISOString() };
    const updateCmd: Record<string, unknown> = {
      TableName: this.tableName,
      Key: { userId },
      UpdateExpression:
        'SET updatedAt = :now ' +
        'REMOVE currentResetToken, lastResetSentAt, ' +
        'resetsSentDayKey, resetsSentToday',
      ExpressionAttributeValues: eav,
    };
    if (expectedToken !== undefined) {
      updateCmd['ConditionExpression'] = 'currentResetToken = :expectedToken';
      eav[':expectedToken'] = expectedToken;
    }
    try {
      await this.doc.send(
        new UpdateCommand(updateCmd as ConstructorParameters<typeof UpdateCommand>[0]),
      );
    } catch (err) {
      if (expectedToken !== undefined && err instanceof ConditionalCheckFailedException) return;
      throw err;
    }
  }

  /**
   * Builds the confirm-time swap for the User row: moves the live email to the pending address and clears the pending
   * fields and counters. Conditioned on `currentPendingEmailToken == :presentedToken` and `pendingEmailLowercase ==
   * :newEmailLower`, so a stale token or moved intent aborts the whole transaction before email or reservation move.
   */
  swapEmailUpdate(args: {
    userId: string;
    newEmail: string;
    newEmailLowercase: string;
    presentedToken: string;
    now: string;
  }): {
    tableName: string;
    key: { userId: string };
    update: {
      UpdateExpression: string;
      ConditionExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
    };
  } {
    return {
      tableName: this.tableName,
      key: { userId: args.userId },
      update: {
        UpdateExpression:
          'SET email = :email, emailLowercase = :emailLower, updatedAt = :now ' +
          'REMOVE pendingEmail, pendingEmailLowercase, currentPendingEmailToken, ' +
          'pendingEmailExpiresAt, lastPendingEmailSentAt, ' +
          'pendingEmailSentDayKey, pendingEmailSentToday',
        ConditionExpression:
          'currentPendingEmailToken = :tok AND pendingEmailLowercase = :emailLower',
        ExpressionAttributeValues: {
          ':email': args.newEmail,
          ':emailLower': args.newEmailLowercase,
          ':now': args.now,
          ':tok': args.presentedToken,
        },
      },
    };
  }

  /**
   * Builds the approve-time update: pending to approved, conditioned on the user existing and still pending, so a
   * user raced by a decline aborts the whole approval transaction.
   */
  approveSignupUpdate(userId: string): {
    tableName: string;
    key: { userId: string };
    update: {
      UpdateExpression: string;
      ConditionExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
    };
  } {
    return {
      tableName: this.tableName,
      key: { userId },
      update: {
        UpdateExpression: 'SET approvalStatus = :approved, updatedAt = :now',
        ConditionExpression: 'attribute_exists(userId) AND approvalStatus = :pending',
        ExpressionAttributeValues: {
          ':approved': 'approved',
          ':pending': 'pending',
          ':now': new Date().toISOString(),
        },
      },
    };
  }

  /**
   * Builds the email-verification update (mirrors `markEmailVerified`), conditioned on the user existing and
   * `currentVerificationToken` still equalling the presented digest, so a rotated token aborts the whole transaction.
   */
  markEmailVerifiedUpdate(
    userId: string,
    at: string,
    expectedToken: string,
  ): {
    tableName: string;
    key: { userId: string };
    update: {
      UpdateExpression: string;
      ConditionExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
    };
  } {
    return {
      tableName: this.tableName,
      key: { userId },
      update: {
        UpdateExpression:
          'SET emailVerifiedAt = :at, updatedAt = :at ' +
          'REMOVE signupExpiresAt, currentVerificationToken, ' +
          'lastVerificationSentAt, verificationsSentDayKey, verificationsSentToday',
        ConditionExpression:
          'attribute_exists(userId) AND currentVerificationToken = :tok',
        ExpressionAttributeValues: { ':at': at, ':tok': expectedToken },
      },
    };
  }

  /**
   * Corrects `firstName`, `lastName` and `birthdate`, conditioned on the row existing as a guard against a concurrent
   * deletion.
   */
  async updateProfile(args: {
    userId: string;
    firstName: string;
    lastName: string;
    birthdate: string;
  }): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId: args.userId },
        UpdateExpression:
          'SET firstName = :fn, lastName = :ln, birthdate = :bd, updatedAt = :now',
        ConditionExpression: 'attribute_exists(userId)',
        ExpressionAttributeValues: {
          ':fn': args.firstName,
          ':ln': args.lastName,
          ':bd': args.birthdate,
          ':now': new Date().toISOString(),
        },
      }),
    );
  }

  // ---------- Session revocation generation ----------

  /**
   * Builds a ConditionCheck-only item asserting the current session generation equals `expectedGeneration`, so an
   * issuance or rotation racing an account-wide revoke cannot commit under the retired value (see
   * `RefreshTokenService.issue`). Prefixed with `attribute_exists(userId)`: against an absent item
   * `attribute_not_exists(sessionGeneration)` is true, so generation 0 would pass for a deleted account.
   */
  conditionCheckSessionGenerationTransactItem(
    userId: string,
    expectedGeneration: number,
  ): TransactItem {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: { userId },
        ConditionExpression: `attribute_exists(userId) AND (${SESSION_GENERATION_CONDITION_EXPRESSION})`,
        ExpressionAttributeValues: {
          ':expectedGeneration': expectedGeneration,
          ':zeroGeneration': 0,
        },
      },
    };
  }

  /**
   * Builds the item that retires `expectedGeneration` and advances to a fresh one, the linearization point of
   * account-wide revocation (`SessionRevocationService.revokeAll`). Must commit in the same transaction as the
   * matching `RevokedTokensRepository.tombstoneGenerationTransactItem`, or a token minted under the retired
   * generation would pass JwtAuthGuard forever. Requires `attribute_exists(userId)`, or the UpdateItem would create a
   * phantom User row for a deleted account.
   */
  bumpSessionGenerationTransactItem(userId: string, expectedGeneration: number): TransactItem {
    return {
      Update: {
        TableName: this.tableName,
        Key: { userId },
        UpdateExpression: 'SET sessionGeneration = :next',
        ConditionExpression: `attribute_exists(userId) AND (${SESSION_GENERATION_CONDITION_EXPRESSION})`,
        ExpressionAttributeValues: {
          ':next': expectedGeneration + 1,
          ':expectedGeneration': expectedGeneration,
          ':zeroGeneration': 0,
        },
      },
    };
  }

  // ---------- Factor-change undo ----------

  /**
   * Persists a fresh factor-change undo token, overwriting any pending one: one outstanding undo per account is
   * intended. Only the SHA-256 hash is stored.
   */
  async setPendingFactorUndo(args: {
    userId: string;
    tokenHash: string;
    expiresAt: number;
    kind: 'passkey_add' | 'passkey_remove' | 'totp_add' | 'totp_remove';
    credentialId?: string;
    now: string;
  }): Promise<void> {
    const base =
      'pendingFactorUndoTokenHash = :tok, pendingFactorUndoExpiresAt = :exp, ' +
      'pendingFactorUndoKind = :kind, updatedAt = :now';
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId: args.userId },
        UpdateExpression:
          args.credentialId !== undefined
            ? `SET ${base}, pendingFactorUndoCredentialId = :cred`
            : `SET ${base} REMOVE pendingFactorUndoCredentialId`,
        ExpressionAttributeValues: {
          ':tok': args.tokenHash,
          ':exp': args.expiresAt,
          ':kind': args.kind,
          ':now': args.now,
          ...(args.credentialId !== undefined ? { ':cred': args.credentialId } : {}),
        },
      }),
    );
  }

  /**
   * Re-validates a presented undo token (hash, kind, not expired) in one conditional UpdateItem with `ALL_OLD` and
   * returns the `(kind, credentialId)` it names; the pre-flight gate of `FactorNoticeService.consume`. It is a check
   * at one instant, not a lock: `consumeFactorUndo` is what stays safe against a superseding token.
   */
  async claimFactorUndo(args: {
    userId: string;
    presentedTokenHash: string;
    presentedKind: 'passkey_add' | 'passkey_remove' | 'totp_add' | 'totp_remove';
    nowSec: number;
    now: string;
  }): Promise<{
    kind: 'passkey_add' | 'passkey_remove' | 'totp_add' | 'totp_remove';
    credentialId?: string;
  } | null> {
    try {
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { userId: args.userId },
          UpdateExpression: 'SET updatedAt = :now',
          ConditionExpression:
            'pendingFactorUndoTokenHash = :tok AND pendingFactorUndoExpiresAt > :nowSec AND pendingFactorUndoKind = :kind',
          ExpressionAttributeValues: {
            ':now': args.now,
            ':tok': args.presentedTokenHash,
            ':nowSec': args.nowSec,
            ':kind': args.presentedKind,
          },
          ReturnValues: 'ALL_OLD',
        }),
      );
      const old = r.Attributes as UserRow | undefined;
      if (!old?.pendingFactorUndoKind) return null;
      return {
        kind: old.pendingFactorUndoKind,
        ...(old.pendingFactorUndoCredentialId
          ? { credentialId: old.pendingFactorUndoCredentialId }
          : {}),
      };
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return null;
      throw err;
    }
  }

  /**
   * Consumes the pending undo token and performs the undo action it gates in one TransactWriteItems, conditioned on
   * the presented hash still being active and unexpired, so a superseded or concurrently consumed token aborts the
   * action too. Returns false on that condition failure; a transient cancellation that survives the retry propagates
   * as `TransientTransactionError`.
   */
  async consumeFactorUndo(args: {
    userId: string;
    presentedTokenHash: string;
    nowSec: number;
    now: string;
    action?: TransactItem;
  }): Promise<boolean> {
    const items: TransactItem[] = [
      {
        Update: {
          TableName: this.tableName,
          Key: { userId: args.userId },
          UpdateExpression:
            'SET updatedAt = :now ' +
            'REMOVE pendingFactorUndoTokenHash, pendingFactorUndoExpiresAt, ' +
            'pendingFactorUndoKind, pendingFactorUndoCredentialId',
          ConditionExpression:
            'pendingFactorUndoTokenHash = :tok AND pendingFactorUndoExpiresAt > :nowSec',
          ExpressionAttributeValues: {
            ':now': args.now,
            ':tok': args.presentedTokenHash,
            ':nowSec': args.nowSec,
          },
        },
      },
      ...(args.action ? [args.action] : []),
    ];
    try {
      await runTransactWrite(this.doc, items, () => {
        // Only item 0 carries a condition, so any ConditionalCheckFailed is the single-use gate losing.
        throw new FactorUndoConditionFailed();
      });
      return true;
    } catch (err) {
      if (err instanceof FactorUndoConditionFailed) return false;
      throw err;
    }
  }
}
