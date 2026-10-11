/**
 * Repository for the `UserMfa` table (PK `userId`, no TTL) — the TOTP factor.
 * Holds the SSE-protected `totpSecret` /
 * `pendingTotpSecret`.
 *
 * Point-ops only (the api-role grant on this table is Get/Put/Update/Delete —
 * no Query, no Scan): every access is keyed by `userId`. The account-deletion
 * cascade deletes the row by `userId`, a single keyed delete — no Scan.
 *
 * The secret is NEVER logged.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import type { TransactItem } from './transact-write.js';
import type { UserMfaRow } from './types.js';

/**
 * The per-account TOTP lock state as read off a `UserMfa` row: both absent on a row with no
 * recorded miss. What {@link UserMfaRepository.reserveTotpAttempt} swaps against.
 */
export type TotpFailureState = Pick<UserMfaRow, 'totpFailureCount' | 'totpLastFailureAt'>;

@Injectable()
export class UserMfaRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_USER_MFA');
  }

  /** The user's MFA row, or null if they have no TOTP state yet. */
  async get(userId: string): Promise<UserMfaRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { userId } }),
    );
    return (r.Item as UserMfaRow | undefined) ?? null;
  }

  /**
   * Strongly-consistent variant of {@link get}. The per-account TOTP lock decision in
   * `MfaService.verifyTotp` / `verifyTotpForStepUp` reads this row right
   * after the PRECEDING request's `incrementTotpFailure` commits; an
   * eventually-consistent replica read there can still return the
   * pre-increment count/timestamp for a moment and wrongly admit a guess the
   * fresh state should have blocked — the same hazard
   * `FailedLoginAttemptsRepository.find` closes with `ConsistentRead: true`
   * and `CredentialsRepository.findByUserIdConsistent` closes for the
   * revision read. Only the lock-check callers need the stronger (costlier)
   * read; every other caller here keeps the cheaper default `get`.
   */
  async getConsistent(userId: string): Promise<UserMfaRow | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { userId },
        ConsistentRead: true,
      }),
    );
    return (r.Item as UserMfaRow | undefined) ?? null;
  }

  /** Put (create or replace) the full MFA row. */
  async put(row: UserMfaRow): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: row }),
    );
  }

  /**
   * Partial update of the MFA row. Always stamps `updatedAt`. Callers pass
   * only the attributes they want to change; `userId` (the key) and an empty
   * patch are rejected at the type level / no-op respectively.
   */
  async update(
    userId: string,
    partial: Partial<Omit<UserMfaRow, 'userId' | 'updatedAt'>>,
  ): Promise<void> {
    const now = new Date().toISOString();
    const sets: string[] = ['updatedAt = :updatedAt'];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = { ':updatedAt': now };
    for (const [key, value] of Object.entries(partial)) {
      if (value === undefined) continue;
      const nameKey = `#${key}`;
      const valueKey = `:${key}`;
      names[nameKey] = key;
      values[valueKey] = value;
      sets.push(`${nameKey} = ${valueKey}`);
    }
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ...(Object.keys(names).length > 0
          ? { ExpressionAttributeNames: names }
          : {}),
        ExpressionAttributeValues: values,
      }),
    );
  }

  /**
   * Promote a confirmed TOTP enrollment: SET the live
   * `totpSecret` + `totpEnabled = true` + the enrollment timestamps AND REMOVE
   * the `pendingTotpSecret` attribute in one update, so a stale pending secret
   * can never be re-confirmed after promotion. Always stamps `updatedAt`.
   *
   * Conditioned on TOTP still being disabled AND `pendingTotpSecret` still
   * equal to `args.expectedPendingSecret` — the same pair `MfaService.
   * enrollConfirm` read moments earlier. Without this the caller's read-time
   * check is a TOCTOU: two concurrent enrollments can both pass it, one
   * enables its secret, and the other's delayed unconditional confirmation
   * would then overwrite that live secret — an enroll-over-enabled the
   * read-time check was supposed to prevent. Returns `false` (no write) on a
   * condition failure instead of throwing, so the caller treats it exactly
   * like a losing race.
   *
   * `restricted`: when the write lands inside an
   * open password-reset window, ALSO stamp the restriction pair; otherwise
   * explicitly REMOVE it — a re-enrollment over an already-enabled factor
   * (`enrollStart` only overwrites `pendingTotpSecret`; it does not require a
   * prior `disable()`) must not inherit a stale restriction from a PRIOR
   * confirm.
   */
  async confirmTotpEnrollment(
    userId: string,
    args: {
      totpSecret: string;
      enrolledAt: string;
      lastVerifiedAt: string;
      expectedPendingSecret: string;
      restricted: { requestedAt: string } | null;
    },
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const { restricted } = args;
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { userId },
          UpdateExpression:
            'SET totpSecret = :secret, totpEnabled = :enabled, ' +
            'enrolledAt = :enrolledAt, lastVerifiedAt = :lastVerifiedAt, ' +
            'updatedAt = :updatedAt' +
            (restricted
              ? ', totpRestrictedPostReset = :restricted, totpRestrictedByResetRequestedAt = :restrictedAt'
              : '') +
            ' REMOVE pendingTotpSecret' +
            (restricted ? '' : ', totpRestrictedPostReset, totpRestrictedByResetRequestedAt'),
          ConditionExpression:
            '(attribute_not_exists(totpEnabled) OR totpEnabled = :notEnabled) ' +
            'AND pendingTotpSecret = :expectedPending',
          ExpressionAttributeValues: {
            ':secret': args.totpSecret,
            ':enabled': true,
            ':notEnabled': false,
            ':enrolledAt': args.enrolledAt,
            ':lastVerifiedAt': args.lastVerifiedAt,
            ':updatedAt': now,
            ':expectedPending': args.expectedPendingSecret,
            ...(restricted
              ? { ':restricted': true, ':restrictedAt': restricted.requestedAt }
              : {}),
          },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  /**
   * Lift the TOTP factor's post-reset restriction.
   * Unconditional: the caller (`StepUpService.confirmRestrictedTotp`) has
   * already verified the fresh proof + the predates-the-reset check.
   */
  async clearTotpRestriction(userId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId },
        UpdateExpression:
          'SET updatedAt = :now REMOVE totpRestrictedPostReset, totpRestrictedByResetRequestedAt',
        ExpressionAttributeValues: { ':now': now },
      }),
    );
  }

  /**
   * Consume a step-up TOTP time step: commit
   * `step` to `lastUsedTotpStepStepUp` only if it strictly advances the stored
   * value (`attribute_not_exists(lastUsedTotpStepStepUp) OR lastUsedTotpStepStepUp < :step`).
   * Closes the concurrent-double-use TOCTOU — two step-up verifies racing the
   * same freshly-entered code both pass otplib's `afterTimeStep` guard, but only
   * one wins this conditional write; the loser's condition fails and `false` is
   * returned so the caller rejects the reuse. Returns `true` on commit. Always
   * stamps `updatedAt`. Additive attribute only — no key/table change.
   */
  async consumeTotpStepUpStep(userId: string, step: number): Promise<boolean> {
    const now = new Date().toISOString();
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { userId },
          UpdateExpression:
            'SET lastUsedTotpStepStepUp = :step, updatedAt = :updatedAt',
          ConditionExpression:
            'attribute_not_exists(lastUsedTotpStepStepUp) OR lastUsedTotpStepStepUp < :step',
          ExpressionAttributeValues: { ':step': step, ':updatedAt': now },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  /**
   * The cleared-row `Put` that disables TOTP, as a `TransactWriteItems` item
   * for the factor-undo consume. Same shape
   * `MfaService.disable` writes — a full `Put` with the secret attributes
   * absent, since a partial update can't REMOVE them. `UsersRepository.
   * consumeFactorUndo` commits it in the SAME transaction as the single-use
   * token clear, so a `totp_add` undo can only clear the factor while its
   * token is still the active one — never a factor re-enrolled after that
   * token was superseded. Unconditional on the MFA row itself (convergent,
   * like `disable`'s put).
   */
  clearTotpTransactItem(userId: string): TransactItem {
    const cleared: UserMfaRow = {
      userId,
      totpEnabled: false,
      updatedAt: new Date().toISOString(),
    };
    return { Put: { TableName: this.tableName, Item: cleared } };
  }

  /**
   * Reserve one TOTP verification attempt against the per-account lock state:
   * a compare-and-swap that advances the running miss
   * count and stamps `totpLastFailureAt` ONLY if the row still carries exactly
   * the failure state the caller `observed` on its consistent read. Exactly
   * one of N concurrent attempts that read the same state wins; every other
   * gets `null`, having written nothing, and must re-read before deciding —
   * the winner's stamp is what tells its racers whether the window is now
   * open or blocked, so a burst can't all slip through on one pre-burst read.
   * Because a loser never writes, a refused attempt can
   * neither inflate the count nor restart the window: the state only ever
   * advances by an attempt that is then actually compared (the earlier unconditional `ADD` on
   * every attempt made the lock permanent past the grace threshold).
   *
   * The guard names both the observed timestamp and the observed count: two
   * stamps can land in the same millisecond, and the count the winner
   * advanced is what still tells a stale observation apart.
   *
   * Decay: `UserMfa` carries **no TTL** (unlike `FailedLoginAttempt`), so a
   * stale count can't expire on its own — an observed `totpLastFailureAt`
   * older than `decaySec` (or absent) starts the count over at 1 instead of
   * continuing it, so an honest miss-here-and-there over weeks never
   * accumulates toward a lockout.
   *
   * The winner's write is provisional: the caller undoes it via
   * {@link clearTotpFailure} when the code turns out to be correct and keeps
   * it as the miss record otherwise. Returns the post-write state so the
   * caller can derive the lock window without a second read.
   */
  async reserveTotpAttempt(
    userId: string,
    observed: TotpFailureState,
    decaySec: number,
  ): Promise<{ totpFailureCount: number; totpLastFailureAt: string } | null> {
    const now = new Date();
    const ts = now.toISOString();
    const staleBefore = new Date(now.getTime() - decaySec * 1000).toISOString();
    const seenAt = observed.totpLastFailureAt;
    const seenCount = observed.totpFailureCount;
    const continues = seenAt !== undefined && seenAt > staleBefore;
    const totpFailureCount = continues ? (seenCount ?? 0) + 1 : 1;

    const guards: string[] = [];
    const values: Record<string, unknown> = { ':count': totpFailureCount, ':ts': ts };
    if (seenAt === undefined) {
      guards.push('attribute_not_exists(totpLastFailureAt)');
    } else {
      guards.push('totpLastFailureAt = :seenAt');
      values[':seenAt'] = seenAt;
    }
    if (seenCount === undefined) {
      guards.push('attribute_not_exists(totpFailureCount)');
    } else {
      guards.push('totpFailureCount = :seenCount');
      values[':seenCount'] = seenCount;
    }

    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { userId },
          UpdateExpression:
            'SET totpFailureCount = :count, totpLastFailureAt = :ts, updatedAt = :ts',
          ConditionExpression: guards.join(' AND '),
          ExpressionAttributeValues: values,
        }),
      );
      return { totpFailureCount, totpLastFailureAt: ts };
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return null;
      throw err;
    }
  }

  /**
   * Clear the per-account TOTP failure state on a successful verification.
   * `REMOVE` rather than zero, so the next attempt's
   * {@link reserveTotpAttempt} observes no failure state and starts over at 1.
   * Additive attributes only — no key/table change.
   */
  async clearTotpFailure(userId: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId },
        UpdateExpression: 'SET updatedAt = :now REMOVE totpFailureCount, totpLastFailureAt',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
      }),
    );
  }

  /** Keyed delete — used by the account-deletion cascade. */
  async delete(userId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { userId } }),
    );
  }
}
