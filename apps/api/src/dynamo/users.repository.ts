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

/**
 * Thrown inside `consumeFactorUndo`'s transaction callback when the
 * single-use condition fails, and caught there — never escapes the method.
 */
class FactorUndoConditionFailed extends Error {
  constructor() {
    super('Factor-undo token is no longer the active one');
    this.name = 'FactorUndoConditionFailed';
  }
}

/**
 * The account session-generation write-authority condition — mirrors `credentials.repository.ts`'s
 * `REVISION_CONDITION_EXPRESSION` shape: `expectedGeneration` must equal the
 * row's CURRENT `sessionGeneration`, or the row must carry none AND
 * `expectedGeneration` be `0` (no revocation has ever happened for this
 * account). Shared by the ConditionCheck-only variant (issuance/rotation)
 * and the bump (account-wide revoke) below.
 */
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
   * Strongly-consistent variant of {@link findById}. Callers that treat
   * a null result as an authoritative "user is gone" decision must not act on
   * an eventually-consistent replica's stale miss: `SignupApprovalService.decline`
   * early-exits (deleting the approval token OUTSIDE the atomic cascade) when the
   * user reads null, so a stale null there would strand the pending
   * User/Credential/EmailReservation rows with no approval row left to retry
   * decline/approve through and no TTL-cascade trigger — a permanent orphan. A
   * `ConsistentRead` GetItem closes that window; the ~2x RCU cost is negligible
   * at this table's traffic. Also the read that PINS a session generation at
   * sign-in (`LoginService.login`, `PasskeyController.authenticateFinish`): the
   * `EmailIndex` GSI image and a default replica read can both still hold a
   * generation an account-wide revoke seconds earlier already retired, and
   * stamping that stale value fails issuance's generation `ConditionCheck`
   * for a legitimate sign-in. Every other {@link findById} caller stays on
   * the cheaper default read.
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
   * True iff the user table has at least one row. Drives the first-run
   * "no users yet -> /signup" redirect on the web root. Scan with Limit 1
   * is O(1) for the empty case and bounded by Scan's per-segment work
   * for the populated case; rate-limited at the controller.
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

  /**
   * Mark a user as email-verified. Idempotent: setting `emailVerifiedAt`
   * on an already-verified user just updates the timestamp. Clears every
   * unverified-signup tracking field in the same call so a verified row
   * carries no resend / expiry state.
   */
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

  /**
   * Persist resend bookkeeping in a single update: rotates the active
   * verification token, advances the cooldown anchor + daily counter,
   * and extends the signup-expiry window. Caller has already validated
   * that the cooldown / cap permits a new send.
   */
  async deleteByUserId(userId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { userId } }),
    );
  }

  /**
   * Flip the approval gate. Used by the owner-approval endpoint and the
   * cascade Lambda's idempotency check. Idempotent: re-applying the same
   * status is a no-op other than the `updatedAt` bump.
   */
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
   * Stamp the rotated verification-token handle + resend bookkeeping on the
   * User row. `newToken` is the SHA-256 hash of the raw token — the
   * caller hashes at the service boundary; this repo stores the value verbatim.
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
   * Persist password-reset request bookkeeping in a single update:
   * stamps the active reset token (so the consume can pin
   * `currentResetToken == :presentedToken` and so account deletion can
   * sweep the row), advances the cooldown anchor + daily counter. Mirrors
   * {@link applyVerificationSend}. `newToken` is the SHA-256 hash of the raw
   * token — the caller hashes at the service boundary; this repo
   * stores it verbatim, so the consume-side `currentResetToken == :tok`
   * compares hash-to-hash. The request transaction in
   * PasswordResetService bundles the new PasswordReset Put with this
   * User update so the mail only fires after the write commits.
   *
   * Concurrency (CODING_STANDARDS "Check-and-mutate requires a
   * transaction"): the handler reads the rate-limit state
   * (`lastResetSentAt` / `resetsSentDayKey` / `resetsSentToday`) before
   * deciding to send. To close the read-then-write TOCTOU — two concurrent
   * requests both passing the cooldown / daily-cap pre-check and both
   * committing — `observed` carries the exact rate-limit values the handler
   * read, and we condition the write on those still being current. A losing
   * concurrent request fails the condition, aborts the whole transaction
   * (`TransactionCanceledException`), and the service maps it to the same
   * opaque no-op `202` (no token, no audit), so at most one real send wins
   * the cooldown window.
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
    // Build a guard term per rate-limit field: an absent observed value must
    // still be absent (attribute_not_exists); a present one must still equal
    // what the handler read. Any drift = a concurrent send already advanced
    // the state, so this losing write must abort.
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
          // Durable request-time stamp — same
          // value as `lastResetSentAt`, but NOT removed by `resetConsumeUpdate`
          // below, so `factor-restriction.ts` can still resolve the request
          // instant after the reset completes. Overwritten (not appended) by
          // the next request.
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
   * Build the Email-OTP MFA send bookkeeping update,
   * analogous to {@link resetSendUpdate}: advance the per-User daily-cap +
   * cooldown counters (`mfaEmailOtpSentDayKey` / `mfaEmailOtpSentToday` /
   * `mfaEmailOtpLastSentAt`) under a TOCTOU `ConditionExpression` pinned to the
   * rate-limit state the handler read. These counters live on the `User` row
   * (not the ~10-min-TTL `MfaEmailOtp` row, whose TTL would wipe them and defeat
   * the daily cap).
   *
   * Returned as a self-contained composite `{ TableName, Key, UpdateExpression,
   * ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues }`.
   *
   * NOTE: the Email-OTP code Put is NOT bundled into a cross-table transaction with this User
   * update by deliberate design — a simplicity/cost choice matching `PasswordResetService`, not an
   * IAM limitation. DynamoDB has no `TransactWriteItems`-named IAM action to withhold; a
   * transaction is authorized by the per-item `PutItem`/`UpdateItem` actions already granted on
   * each table. The real boundary on these secret tables is the narrow point-ops action set (no
   * `Query`/`Scan`) plus api-role-only access. The service runs this conditional `UpdateItem` first
   * (the TOCTOU guard wins the cooldown race for at most one concurrent sender), then Puts the
   * `MfaEmailOtp` row only after the guard commits — the same "advance counters under condition,
   * then side effect" ordering `PasswordResetService` uses.
   *
   * `attempts` invalidation and the code hash itself live on the `MfaEmailOtp`
   * row, not here.
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
   * Build the step-up Email-OTP send bookkeeping update — a SEPARATE budget from {@link
   * mfaEmailOtpSendUpdate}, on the additive `stepUpEmailOtp*` `User` fields, so a step-up user's
   * code allowance is never drained by (nor drains) the login Email-OTP budget. Same TOCTOU
   * `ConditionExpression` posture as {@link mfaEmailOtpSendUpdate}: pin the rate-limit state the
   * handler read so at most one concurrent sender wins the cooldown window. The code Put (to the
   * namespaced `<userId>#stepup` row) follows this conditional `UpdateItem` — same point-op
   * ordering. The absence of a cross-table transaction is a deliberate simplicity/cost choice, not
   * an IAM limitation (see {@link mfaEmailOtpSendUpdate}).
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
   * Build the consume-side User update: clear the active reset
   * token + request counters, condition on the presented token still
   * being the authoritative one. Returned as parts so the caller can fold
   * it into the single consume `TransactWriteItems` (a stale/superseded
   * token fails this condition and aborts the whole transaction, so a
   * superseded link can never rotate the password). `presentedToken` is the
   * SHA-256 hash of the raw URL token; the stored `currentResetToken`
   * is the same hash, so the condition compares hash-to-hash.
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
          // `lastPasswordResetCompletedAt` is the
          // durable "a reset completed" trace `factor-restriction.ts` needs —
          // nothing else records this once `currentResetToken` is cleared
          // below. `lastPasswordResetCompletedRequestedAt` is `args.requestedAt` —
          // the consumed PasswordReset row's OWN `createdAt`, paired with the
          // completion so a later, never-consumed reset request (which
          // overwrites `passwordResetRequestOpenedAt` below) can never cancel
          // this still-open post-completion window; `factor-restriction.ts`
          // resolves the completed branch from this pair, never from the
          // mutable `passwordResetRequestOpenedAt`. `passwordResetRequestOpenedAt`
          // (SET by `resetSendUpdate`, above) is deliberately NOT removed here —
          // it must survive consume so a still-pending request can still
          // resolve its own branch.
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
   * Persist the pending email-change intent: set `pendingEmail` /
   * `pendingEmailLowercase` and stamp the ~15-min logical
   * `pendingEmailExpiresAt`. Written by `change-email/request` AFTER the
   * password re-auth + uniqueness pre-check pass, BEFORE the step-up factor.
   * Overwrites any prior pending intent (a fresh request supersedes the old
   * one); the change-email token itself is minted only once the step-up
   * completes (or directly when `AUTH_MFA_ENFORCED` is off), so a re-request
   * before completion just re-stamps the intent. `updatedAt` is bumped.
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
   * Stamp the active change-email verification-token handle + send
   * bookkeeping on the User row (mirrors {@link applyVerificationSend}):
   * rotate `currentPendingEmailToken` to the new `sha256(rawToken)` (so the
   * confirm can pin `currentPendingEmailToken == sha256(presented)` for the
   * single-valid-link invariant), advance the per-user cooldown anchor +
   * daily counter. Conditioned on the pending intent still being the one the
   * handler read (`pendingEmailLowercase == :pel`) so a superseded request
   * (a newer `setPendingEmail` for a different address) aborts this stale
   * send. `newToken` is the SHA-256 hash (the caller hashes at the boundary).
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
    // Pin the pending intent (still the address the handler read) AND the
    // rate-limit state (still what the handler read) so two concurrent sends
    // that both passed the cooldown / daily-cap pre-check can't both commit —
    // the loser fails the condition and aborts the transaction (TOCTOU guard,
    // mirroring resetSendUpdate).
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
   * Clear the pending password-reset handle + request counters on the User row.
   * Called after a committed email swap drops
   * the `PasswordReset` row so the dangling `currentResetToken` handle can't
   * survive — a reset link must not mail the now-old address. Bumps `updatedAt`.
   *
   * When `expectedToken` is supplied the clear is conditioned on
   * `currentResetToken == expectedToken` so a fresh reset minted AFTER the swap
   * (but before this post-commit cleanup runs) isn't wiped — a
   * `ConditionalCheckFailedException` in that case is benign and swallowed. When
   * omitted (no handle was present pre-swap) the clear is unconditional.
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
   * Build the confirm-time swap parts for the User row: move the live
   * `email` / `emailLowercase` to the pending address and clear every pending
   * field + the cooldown counters. Returned as parts so the caller folds it
   * into the single confirm `TransactWriteItems` alongside the
   * `EmailReservation` move. The single-valid-link invariant is enforced by
   * the `ConditionExpression`: `currentPendingEmailToken == :presentedToken`
   * AND `pendingEmailLowercase == :newEmailLower` — a superseded/stale token
   * (or a pending intent that moved) fails the condition and aborts the WHOLE
   * transaction, so `email` / `emailLowercase` never move and the reservation
   * is not touched. `presentedToken` is the SHA-256 hash of the raw URL token
   * (the stored handle is the same hash → hash-to-hash compare).
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
   * Build the approve-time User update parts: flip `approvalStatus` pending → approved, conditioned
   * on the user still existing AND still being pending. Returned as parts so the caller folds it
   * into the single approval `TransactWriteItems` alongside the conditional delete of the presented
   * approval row — both commit or neither does. A no-longer-pending user (raced with a decline /
   * already approved) fails the condition and aborts the whole transaction.
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
   * Build the email-verification User update parts: mark verified + clear the unverified-signup
   * tracking fields (mirrors {@link markEmailVerified}), conditioned on the user still existing AND
   * its `currentVerificationToken` still equalling the presented digest. Returned as parts so the
   * caller folds it into the single verification `TransactWriteItems` alongside the conditional
   * delete of the hashed token row — both commit or neither does. A stale/superseded token (the
   * handle already rotated or removed) fails the condition and aborts the whole transaction, so no
   * write occurs.
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
   * Correct the account-record fields.
   * Narrow purpose-built writer, mirroring this repository's other single-row
   * updates: writes exactly `firstName`/`lastName`/`birthdate` + `updatedAt`,
   * conditioned on the row still existing. The caller (`AuthController.updateMe`)
   * already confirmed existence via `findById` moments earlier — the condition
   * here is defense-in-depth against an exceedingly rare concurrent deletion
   * mid-request, not the primary existence check.
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
   * Build a `ConditionCheck`-only transact item asserting the account's
   * CURRENT session generation still equals `expectedGeneration` — the
   * generation the caller stamped onto the refresh-token row it is about to
   * Put in the SAME transaction. A revoked (moved-on) generation fails this
   * condition and aborts the whole transaction, so an issuance or rotation
   * racing an account-wide revoke can never commit a session under the
   * retired value. See `RefreshTokenService.issue`.
   *
   * Prefixed with `attribute_exists(userId)`, mirroring
   * `bumpSessionGenerationTransactItem`: against an ABSENT item, DynamoDB
   * evaluates `attribute_not_exists(sessionGeneration)` as true, so the bare
   * condition below would SUCCEED whenever `expectedGeneration` is `0` — the
   * common case, since 0 is what every account that has never had an
   * account-wide revoke carries. Without this guard, a session issuance or
   * rotation racing account deletion could commit a brand-new refresh-token
   * row for a user whose row no longer exists, the opposite of the "a
   * missing user row fails closed" rule this generation gate exists to
   * enforce.
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
   * Build the transact item that atomically retires `expectedGeneration` and
   * advances the account to a fresh one — the single linearization point
   * account-wide revocation rests on (`SessionRevocationService.revokeAll`).
   * MUST be committed in the SAME `TransactWriteItems` as
   * `RevokedTokensRepository.tombstoneGenerationTransactItem`'s matching row
   * for `expectedGeneration`: every generation that stops being current gets
   * its tombstone in the same atomic write that retires it, or a token
   * minted under it could pass `JwtAuthGuard` forever.
   *
   * Requires the row to still exist (`attribute_exists(userId)`): a plain
   * `UpdateItem` whose condition would otherwise pass against an absent key
   * CREATES a fresh item, which would silently manufacture a phantom `User`
   * row for a concurrently deleted account — the revoke path must fail
   * closed there instead.
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
   * Persist a fresh factor-change undo token, unconditionally overwriting any
   * pending token from an earlier change — ONE outstanding undo per account
   * is the intended behaviour (the newest factor change is the one worth
   * undoing, and its undo still ends every session). `tokenHash` is the
   * SHA-256 hash of the raw URL token; only the hash is stored.
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
   * Re-validate a presented factor-undo token (hash, kind, not expired) and
   * hand back the `(kind, credentialId)` it names, in one conditional
   * `UpdateItem` with `ReturnValues: 'ALL_OLD'` that only re-stamps
   * `updatedAt` — the pending fields are left in place. This is the
   * pre-flight gate of `FactorNoticeService.consume`: an unknown, expired,
   * superseded, or kind-mismatched token returns `null` here and never gets
   * as far as ending sessions, and the returned descriptor is what the
   * caller builds the undo action from. It is a validation at one instant,
   * NOT a lock: `setPendingFactorUndo` can still overwrite the pending token
   * after this returns (ONE outstanding undo per account by design — see
   * that method's doc comment). What makes the destructive action safe
   * against that is `consumeFactorUndo`, which commits the action and the
   * single-use clear in one transaction conditioned on the token STILL being
   * the active one at commit time.
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
   * Consume the pending factor-undo token AND perform the undo action it
   * gates, in ONE `TransactWriteItems`: clear the pending-undo state,
   * conditioned on the presented token hash still being the active one AND
   * not yet expired, together with the caller's optional `action` item — the
   * passkey `Delete` (`PasskeysRepository.removeTransactItem`) or the TOTP
   * cleared-row `Put` (`UserMfaRepository.clearTotpTransactItem`); absent
   * for the `_remove` kinds, which undo nothing. Single-use is enforced by
   * this condition, not by a preceding read, and because the action commits
   * in the same transaction it can never run for a token that was superseded
   * by a newer factor change, or consumed by a concurrent click, between the
   * caller's earlier `claimFactorUndo` and this write: the condition fails
   * and the WHOLE transaction aborts, action included. Returns `false` on
   * that condition failure (the caller maps it to the opaque failure
   * response); a transient cancellation that survives the shared bounded
   * retry propagates as `TransientTransactionError`. `presentedTokenHash` is
   * the SHA-256 hash of the raw URL token.
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
        // Only item 0 (this User update) carries a condition, so any
        // ConditionalCheckFailed reason is the single-use gate losing.
        throw new FactorUndoConditionFailed();
      });
      return true;
    } catch (err) {
      if (err instanceof FactorUndoConditionFailed) return false;
      throw err;
    }
  }
}
