/**
 * Repository for the `TrustedDevice` table (PK `userId`, SK `deviceId`, TTL on `expiresAt` ~30
 * days) — per-device MFA-skip trust. Stores the SHA-256 hash of the opaque device-trust secret
 * (never the raw secret, mirroring RefreshToken).
 *
 * The api-role grant on this table is the point-ops set (Get/Put/Update/
 * Delete) PLUS `dynamodb:Query` — `listByUser` scans by the `userId` PK only
 * (no Scan) to back the "manage trusted devices" listing and the
 * account-deletion cascade deleting every SK row under the `userId` PK.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import type { TrustedDeviceRow } from './types.js';

@Injectable()
export class TrustedDeviceRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_TRUSTED_DEVICE');
  }

  /** The trust row for `(userId, deviceId)`, or null if the device is untrusted. */
  async get(userId: string, deviceId: string): Promise<TrustedDeviceRow | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { userId, deviceId },
      }),
    );
    return (r.Item as TrustedDeviceRow | undefined) ?? null;
  }

  /** Put (create or replace) a trust row. */
  async put(row: TrustedDeviceRow): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: row }),
    );
  }

  /**
   * Best-effort keyed stamp of `lastUsedAt` on a successful cookie
   * verification. A targeted `UpdateItem` — never a
   * `put` of the whole row — so it can't race `set()`'s full-row replace
   * (which rotates the trust secret on a fresh remember-this-device).
   */
  async stampLastUsed(userId: string, deviceId: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId, deviceId },
        UpdateExpression: 'SET lastUsedAt = :now',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
      }),
    );
  }

  /** Keyed delete of one device's trust ("forget this device"). */
  async delete(userId: string, deviceId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { userId, deviceId },
      }),
    );
  }

  /**
   * Every trusted device for a user, by `userId` PK Query (no Scan). Backs
   * the "manage trusted devices" listing and the account-deletion cascade
   * deleting all of a user's trust rows. Paginates on
   * `LastEvaluatedKey` for completeness; the per-user count is tiny.
   */
  async listByUser(userId: string): Promise<TrustedDeviceRow[]> {
    const out: TrustedDeviceRow[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'userId = :u',
          ExpressionAttributeValues: { ':u': userId },
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const item of (r.Items as TrustedDeviceRow[] | undefined) ?? []) {
        out.push(item);
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return out;
  }

  /**
   * Atomically record one failed password attempt from this trusted device.
   * Conditioned on the row actually existing
   * (`attribute_exists(tokenHash)`) — a bare `ADD` on an absent row would mint
   * one with no `tokenHash`/`expiresAt`, which would then never TTL-expire.
   * Mirrors `FailedLoginAttemptsRepository.increment`'s monotonic-timestamp
   * primary/fallback shape. Returns `null` when the row is already gone (the
   * device isn't trusted — nothing to increment); the caller treats that the
   * same as "not trusted".
   */
  async incrementFailure(userId: string, deviceId: string): Promise<TrustedDeviceRow | null> {
    const ts = new Date().toISOString();
    const base = {
      TableName: this.tableName,
      Key: { userId, deviceId },
      UpdateExpression: 'SET lastFailedAt = :ts ADD consecutiveFailures :one',
      ExpressionAttributeValues: { ':ts': ts, ':one': 1 },
      ReturnValues: 'ALL_NEW' as const,
    };
    try {
      const r = await this.doc.send(
        new UpdateCommand({
          ...base,
          ConditionExpression:
            'attribute_exists(tokenHash) AND (attribute_not_exists(lastFailedAt) OR lastFailedAt <= :ts)',
        }),
      );
      return r.Attributes as TrustedDeviceRow;
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      // Either the row is gone (untrusted — nothing to do) or a newer failure
      // already stamped a later `lastFailedAt`. Retry the increment alone,
      // still gated on existence, without touching the timestamp.
      try {
        const r = await this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { userId, deviceId },
            UpdateExpression: 'ADD consecutiveFailures :one',
            ExpressionAttributeValues: { ':one': 1 },
            ConditionExpression: 'attribute_exists(tokenHash)',
            ReturnValues: 'ALL_NEW',
          }),
        );
        return r.Attributes as TrustedDeviceRow;
      } catch (err2) {
        if (err2 instanceof ConditionalCheckFailedException) return null;
        throw err2;
      }
    }
  }

  /**
   * Clear the per-device failure counter on a successful password
   * verification from this device. Conditioned on the
   * row existing — an unconditioned `UpdateItem` would create a bare
   * key-only row for a device that was never trusted.
   */
  async clearFailure(userId: string, deviceId: string): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { userId, deviceId },
          UpdateExpression: 'REMOVE consecutiveFailures, lastFailedAt',
          ConditionExpression: 'attribute_exists(tokenHash)',
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  }
}
