// Repository for the shared request-throttle counter, on the PasskeyChallenge table under a `throttle:` key namespace (api-role
// isolation already covers it).
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';

// Separates throttle rows from passkey-challenge rows in the shared table key namespace.
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
    // Same table as PasskeyChallengeRepository.
    super(doc, config, 'TABLE_PASSKEY_CHALLENGE');
  }

  /**
   * Atomically adds one hit to the key current fixed window, starting a fresh window when the stored one has ended.
   * `abortSignal` bounds every send at the caller deadline so a hung dependency adds no latency beyond it. DynamoDB
   * TTL is hygiene only (deletion lags, DynamoDB Local never sweeps): the window is enforced from the row own
   * `windowEnd`.
   */
  async increment(
    throttleKey: string,
    windowMs: number,
    abortSignal: AbortSignal,
  ): Promise<ThrottleCounterResult> {
    const key = `${KEY_PREFIX}${throttleKey}`;
    const nowMs = Date.now();
    const newWindowEndMs = nowMs + windowMs;
    // Hygiene-only TTL; the window is enforced from `windowEnd`.
    const ttlSec = Math.ceil(newWindowEndMs / 1000);

    try {
      // Common path: the window is still open, so ADD one hit without a read-modify-write; `if_not_exists` seeds the
      // first sighting.
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

  // The window has ended: start a fresh one-hit window, guarded so a racer that already rolled it over is not
  // clobbered; if the guard fails, a plain ADD lands the hit in the racer window.
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
