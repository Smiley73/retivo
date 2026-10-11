/**
 * Repository for the shared request-throttle counter. Reuses the `PasskeyChallenge` table
 * under a distinct
 * `throttle:` key namespace rather than provisioning a new one — an opaque
 * single-attribute `key` plus a numeric TTL attribute is exactly the shape a
 * fixed-window counter needs, and this table's api-role grant already covers
 * the isolation boundary this counter wants (api role only).
 *
 * One row per throttle bucket — the opaque, already-hashed key
 * `ThrottlerGuard.generateKey` mints per route/tracker (see
 * `../throttle/dynamo-throttler-storage.ts`). DynamoDB TTL is NOT the expiry
 * mechanism here either (deletion lags up to ~48h, and DynamoDB Local never
 * sweeps at all): the window is enforced from the row's own `windowEnd`, and
 * `increment` resets the counter itself once a read shows that window has
 * ended, mirroring `FailedLoginAttemptsRepository.increment`'s single
 * atomic-`UpdateItem` idiom rather than a read-modify-write.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';

/** Distinguishes throttle-counter rows from 04's passkey-challenge rows in
 *  the shared table's single `key` namespace. */
const KEY_PREFIX = 'throttle:';

export interface ThrottleCounterResult {
  /** Hit count within the current window, INCLUDING this call's hit. */
  hits: number;
  /** Epoch-milliseconds the current window ends. */
  windowEndMs: number;
}

@Injectable()
export class ThrottleCounterRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    // Same table as PasskeyChallengeRepository — see the class doc above.
    super(doc, config, 'TABLE_PASSKEY_CHALLENGE');
  }

  /**
   * Atomically add one hit to `throttleKey`'s current fixed window, starting
   * a fresh one-hit window when the stored window has already ended.
   * `windowMs` sizes both the window length and the row's (hygiene-only)
   * DynamoDB TTL.
   *
   * `abortSignal` bounds the call at the caller's deadline (see
   * `DynamoThrottlerStorage`) — every `send` here takes it, so a hung
   * dependency cannot add latency beyond that budget.
   */
  async increment(
    throttleKey: string,
    windowMs: number,
    abortSignal: AbortSignal,
  ): Promise<ThrottleCounterResult> {
    const key = `${KEY_PREFIX}${throttleKey}`;
    const nowMs = Date.now();
    const newWindowEndMs = nowMs + windowMs;
    // Hygiene-only DynamoDB TTL (epoch seconds) — see the class doc; the
    // window itself is enforced from `windowEnd` below, never from this.
    const ttlSec = Math.ceil(newWindowEndMs / 1000);

    try {
      // Common path: the stored window (if any) is still open — ADD one hit
      // without a read-modify-write. `if_not_exists` seeds `windowEnd` /
      // `expiresAt` the first time this key is ever seen, and DynamoDB
      // creates the item outright when it's missing (same idiom as
      // `FailedLoginAttemptsRepository.increment`).
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { key },
          UpdateExpression:
            'ADD hits :one SET windowEnd = if_not_exists(windowEnd, :windowEnd), expiresAt = if_not_exists(expiresAt, :ttlSec)',
          ConditionExpression: 'attribute_not_exists(windowEnd) OR windowEnd > :now',
          ExpressionAttributeValues: {
            ':one': 1,
            ':windowEnd': newWindowEndMs,
            ':ttlSec': ttlSec,
            ':now': nowMs,
          },
          ReturnValues: 'ALL_NEW',
        }),
        { abortSignal },
      );
      return {
        hits: r.Attributes!.hits as number,
        windowEndMs: r.Attributes!.windowEnd as number,
      };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      return this.resetWindow(key, nowMs, newWindowEndMs, ttlSec, abortSignal);
    }
  }

  /**
   * The stored window has ended (or never existed): start a fresh one-hit
   * window. Guarded by the mirror-image condition so a racer that already
   * rolled the window over between our two attempts isn't clobbered — if
   * that guard fails too, the window is now fresh (the racer won it), so a
   * plain `ADD` lands this call's hit inside it rather than resetting again.
   */
  private async resetWindow(
    key: string,
    nowMs: number,
    newWindowEndMs: number,
    ttlSec: number,
    abortSignal: AbortSignal,
  ): Promise<ThrottleCounterResult> {
    try {
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { key },
          UpdateExpression: 'SET hits = :one, windowEnd = :windowEnd, expiresAt = :ttlSec',
          ConditionExpression: 'attribute_not_exists(windowEnd) OR windowEnd <= :now',
          ExpressionAttributeValues: {
            ':one': 1,
            ':windowEnd': newWindowEndMs,
            ':ttlSec': ttlSec,
            ':now': nowMs,
          },
          ReturnValues: 'ALL_NEW',
        }),
        { abortSignal },
      );
      return {
        hits: r.Attributes!.hits as number,
        windowEndMs: r.Attributes!.windowEnd as number,
      };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { key },
          UpdateExpression: 'ADD hits :one',
          ExpressionAttributeValues: { ':one': 1 },
          ReturnValues: 'ALL_NEW',
        }),
        { abortSignal },
      );
      return {
        hits: r.Attributes!.hits as number,
        windowEndMs: r.Attributes!.windowEnd as number,
      };
    }
  }
}
