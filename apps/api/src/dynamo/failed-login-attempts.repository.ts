import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import type { FailedLoginAttemptRow } from './types.js';

@Injectable()
export class FailedLoginAttemptsRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_FAILED_LOGIN_ATTEMPT');
  }

  async find(emailLowercase: string): Promise<FailedLoginAttemptRow | null> {
    // ConsistentRead: this read enforces the brute-force lockout window, and a stale replica after an atomic increment
    // would admit an attempt the fresh state should block.
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { emailLowercase },
        ConsistentRead: true,
      }),
    );
    return (r.Item as FailedLoginAttemptRow | undefined) ?? null;
  }

  /**
   * Atomically records one failed attempt in a single UpdateItem (ADD 1, stamp the latest-failure time, re-arm the
   * TTL) and returns the post-increment row. An atomic ADD cannot lose a concurrent increment, unlike a
   * find-then-Put. No idempotency token wraps it: an ambiguous SDK retry could double-count, which only makes the
   * backoff more conservative (fail-safe).
   *
   * The timestamp and TTL advance monotonically: the primary write is gated on `attribute_not_exists(lastFailedAt) OR
   * lastFailedAt <= :ts`, so a delayed request cannot move them backward and shorten the backoff. If that fails, a
   * fallback still lands the increment and SETs both via `if_not_exists`: a concurrent `clear()` may have deleted the
   * row, and a bare ADD would recreate it with no `lastFailedAt` (checkBackoff would fail open) and no `expiresAt`
   * (never TTL-expired).
   */
  async increment(
    emailLowercase: string,
    ttlAfterLastFailureSec: number,
  ): Promise<FailedLoginAttemptRow> {
    const nowSec = Math.floor(Date.now() / 1000);
    const ts = new Date(nowSec * 1000).toISOString();
    try {
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { emailLowercase },
          UpdateExpression:
            'SET lastFailedAt = :ts, expiresAt = :exp ADD consecutiveFailures :one',
          // Advance the timestamp and TTL only when they do not regress.
          ConditionExpression:
            'attribute_not_exists(lastFailedAt) OR lastFailedAt <= :ts',
          ExpressionAttributeValues: {
            ':ts': ts,
            ':exp': nowSec + ttlAfterLastFailureSec,
            ':one': 1,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return r.Attributes as FailedLoginAttemptRow;
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      // Would regress `lastFailedAt`: still land the increment, seeding the timestamps with `if_not_exists`.
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { emailLowercase },
          UpdateExpression:
            'SET lastFailedAt = if_not_exists(lastFailedAt, :ts), expiresAt = if_not_exists(expiresAt, :exp) ADD consecutiveFailures :one',
          ExpressionAttributeValues: {
            ':ts': ts,
            ':exp': nowSec + ttlAfterLastFailureSec,
            ':one': 1,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return r.Attributes as FailedLoginAttemptRow;
    }
  }

  /**
   * Clears the counter on success. An unconditional delete would destroy a guessing-notice stamp and let the next
   * burst re-notify inside the same 24h, so a row holding a stamp has only its counter fields removed.
   */
  async clear(emailLowercase: string): Promise<void> {
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { emailLowercase },
          ConditionExpression: 'attribute_not_exists(guessingNoticeSentAt)',
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { emailLowercase },
          UpdateExpression: 'REMOVE consecutiveFailures, lastFailedAt',
        }),
      );
    }
  }

  /**
   * Unconditional delete for account deletion, stamp included, so a newly registered account reusing the address does
   * not inherit the old notice-suppression state. Only `DeleteAccountService` should call it; others want the
   * stamp-preserving `clear()`.
   */
  async deleteRow(emailLowercase: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { emailLowercase },
      }),
    );
  }

  /**
   * Once-per-24h gate for the guessing notice: one atomic conditional UpdateItem, so two concurrent
   * threshold-crossing requests cannot both win. Returns true only when no stamp exists or it is over 24h old; also
   * re-arms the TTL via `if_not_exists`.
   */
  async stampGuessingNotice(
    emailLowercase: string,
    windowSec: number,
  ): Promise<boolean> {
    const nowSec = Math.floor(Date.now() / 1000);
    const ts = new Date(nowSec * 1000).toISOString();
    const cutoffTs = new Date((nowSec - windowSec) * 1000).toISOString();
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { emailLowercase },
          UpdateExpression:
            'SET guessingNoticeSentAt = :ts, expiresAt = if_not_exists(expiresAt, :exp)',
          ConditionExpression:
            'attribute_not_exists(guessingNoticeSentAt) OR guessingNoticeSentAt <= :cutoff',
          ExpressionAttributeValues: {
            ':ts': ts,
            ':cutoff': cutoffTs,
            ':exp': nowSec + windowSec,
          },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }
}
