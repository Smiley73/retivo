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
    // `ConsistentRead`: this read enforces the brute-force backoff/lockout
    // window. On the very next login attempt after an atomic `increment` commits,
    // an eventually-consistent replica could still return the stale pre-increment
    // count/timestamp and admit an attempt the fresh state should have blocked. A
    // strongly-consistent single-item read closes that window; the ~2x RCU cost is
    // negligible at this table's traffic and adds no extra request. `checkBackoff`
    // is the only production caller and always wants the freshest state.
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
   * Atomically record one failed attempt in a single `UpdateItem`: `ADD` 1 to
   * the running counter, stamp the latest-failure time, and (re)arm the numeric
   * epoch-second TTL. Returns the post-increment row (`ALL_NEW`) so the caller
   * needs no separate read.
   *
   * This is the race fix: the previous
   * find-then-`Put` was a read/modify/write that silently dropped a concurrent
   * increment (lost update) — two racers each read count `N` and both wrote
   * `N+1`. An atomic `ADD` cannot lose an increment, so `N` concurrent misses
   * always land an exact `+N`.
   *
   * No idempotency token wraps this write: an ambiguous-response SDK retry
   * (DynamoDB applied the `ADD`, but the response was lost) could rarely
   * double-count one failed-login attempt. That is accepted deliberately — the
   * effect is strictly fail-SAFE (over-counting only makes the derived backoff
   * slightly more conservative, never weaker), so the transactional-write
   * `ClientRequestToken` machinery would add cost/complexity for no security
   * gain.
   *
   * The timestamp/TTL advance is **monotonic**: the counter `ADD` is
   * fail-safe (it can only climb), but a blind `SET lastFailedAt = :ts` is not —
   * a delayed / out-of-order request (or an ambiguous SDK retry that lands after
   * a newer failure already committed a later timestamp) could stamp its OLDER
   * timestamp on top and move `lastFailedAt`/`expiresAt` BACKWARD, shortening the
   * derived backoff window below what the newer failure earned. So the primary
   * write gates the whole `UpdateItem` on `attribute_not_exists(lastFailedAt) OR
   * lastFailedAt <= :ts`; if that condition fails (this request's timestamp would
   * regress), a fallback update still lands the increment WITHOUT overwriting a
   * newer timestamp/TTL. The counter therefore always advances on every call, and
   * the timestamp/TTL never move backward.
   *
   * The fallback still `SET`s `lastFailedAt`/`expiresAt` via `if_not_exists`:
   * a concurrent `clear()` (an unconditional `DeleteCommand`) can delete
   * the row between the primary conditional write failing and this fallback
   * running. A bare `ADD` on the now-absent item would recreate a row holding
   * ONLY the key + counter — no `lastFailedAt` (so `checkBackoff` reads a
   * non-finite timestamp and fails open) and no `expiresAt` (so the row never
   * TTL-expires). `if_not_exists` seeds valid values on a freshly-recreated row
   * while leaving a genuinely-existing newer timestamp from a concurrent winner
   * untouched.
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
          // Advance the timestamp/TTL only when it does not regress (monotonic).
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
      // This request's timestamp would move `lastFailedAt` backward — a newer
      // failure already stamped a later time. Still land the increment (the
      // counter is fail-safe and must never be skipped), and seed
      // `lastFailedAt`/`expiresAt` via `if_not_exists` so a row that a concurrent
      // `clear()` just deleted is recreated with valid values while a
      // genuinely-existing newer timestamp is left at its newer values.
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
   * Clear the counter on a success. An unconditional delete would destroy an
   * existing guessing-notice stamp — the row would
   * come back empty on the account's very next burst and re-notify inside the
   * same 24h window the stamp exists to bound. So: delete ONLY when no stamp
   * is present (the common, no-notice-yet path); when a stamp exists, fall
   * back to removing just the counter fields, leaving the stamp (and the
   * row's TTL) alive. Mirrors `increment`'s primary/fallback shape — one
   * round trip on the common path.
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
   * Unconditional delete for account-lifecycle cleanup — always removes the row, including any
   * guessing-notice stamp. `clear()` deliberately preserves that stamp on a
   * successful login so a still-guessed account isn't re-notified inside the
   * same 24h window; but account deletion must not leave the row (and its
   * stamp) behind, or a newly registered account reusing the freed address
   * would inherit the old notice-suppression state. Only `DeleteAccountService`
   * should call this — every other caller of the shared primitive wants the
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
   * Once-per-24h gate for the guessing notice: one
   * atomic conditional `UpdateItem` so two concurrent threshold-crossing
   * requests can't both win. Advances (and returns `true`) only when no stamp
   * exists yet or the existing one is more than 24h old; otherwise a no-op
   * (`false`) — including when this call is racing another winner. Also
   * re-arms the row's TTL via `if_not_exists` so a stamp written on an
   * otherwise-cleared row still survives ~24h.
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
