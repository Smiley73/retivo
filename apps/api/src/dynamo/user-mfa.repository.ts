// Repository for the UserMfa table (PK userId, no TTL): the SSE-protected TOTP secrets. Point-ops only (no Query or Scan grant);
// secrets are never logged.
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

/** Per-account TOTP lock state read off a UserMfa row; what `reserveTotpAttempt` swaps against. */
export type TotpFailureState = Pick<UserMfaRow, 'totpFailureCount' | 'totpLastFailureAt'>;

@Injectable()
export class UserMfaRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_USER_MFA');
  }

  async get(userId: string): Promise<UserMfaRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { userId } }),
    );
    return (r.Item as UserMfaRow | undefined) ?? null;
  }

  /**
   * Strongly consistent `get`. The TOTP lock decision reads the row right after the previous request
   * incrementTotpFailure commit, and a stale replica read would admit a guess the fresh state should block. Only the
   * lock-check callers pay for it.
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

  async put(row: UserMfaRow): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: row }),
    );
  }

  /** Partial update of the MFA row; always stamps `updatedAt`. */
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
   * Promotes a confirmed TOTP enrollment: SETs the live secret and enabled flag and REMOVEs `pendingTotpSecret` in
   * one update. Conditioned on TOTP still being disabled and the pending secret equal to `expectedPendingSecret`, so
   * two concurrent enrollments cannot overwrite a live secret; returns false (no write) on a lost race. `restricted`
   * stamps the restriction pair inside an open reset window and otherwise REMOVEs it, so a re-enrollment never
   * inherits a stale restriction.
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
   * Lifts the TOTP post-reset restriction; the caller (`StepUpService.confirmRestrictedTotp`) has already verified
   * the proof.
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
   * Consumes a TOTP time step for sign-in or step-up, committing it only if it strictly advances the stored value.
   * Two verifies racing the same code both pass the otplib guard, but only one wins this write; the loser gets false.
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
   * The cleared-row Put that disables TOTP, as a transact item for the factor-undo consume. A full Put because a
   * partial update cannot REMOVE the secrets. Committed in the same transaction as the single-use token clear, so a
   * `totp_add` undo cannot clear a factor re-enrolled after its token was superseded.
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
   * Reserves one TOTP verification attempt: a compare-and-swap that advances the miss count and stamps
   * `totpLastFailureAt` only if the row still carries the failure state the caller `observed`. Exactly one of N
   * concurrent attempts wins; losers get null having written nothing, so a refused attempt neither inflates the count
   * nor restarts the window. The guard names both the timestamp and the count, since two stamps can share a
   * millisecond. UserMfa has no TTL, so an observed timestamp older than `decaySec` (or absent) restarts the count at
   * 1. The winner write is provisional: the caller undoes it with `clearTotpFailure` on a correct code.
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
   * Clears the TOTP failure state on success; REMOVE rather than zero, so the next `reserveTotpAttempt` starts over
   * at 1.
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

  async delete(userId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { userId } }),
    );
  }
}
