// Repository for the TrustedDevice table (PK userId, SK deviceId, TTL ~30 days): per-device MFA-skip trust, storing only the SHA-256
// hash of the device-trust secret.
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
import { runTransactWrite, type TransactItem } from './transact-write.js';
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
   * Put (create or replace) a trust row in one transaction with `check`, a ConditionCheck on another table, so the row
   * commits only while the check holds; `onCheckFailed` must throw the caller's conflict error.
   */
  async putChecked(
    row: TrustedDeviceRow,
    check: TransactItem,
    onCheckFailed: () => never,
  ): Promise<void> {
    await runTransactWrite(
      this.doc,
      [{ Put: { TableName: this.tableName, Item: row } }, check],
      onCheckFailed,
    );
  }

  /**
   * Best-effort stamp of `lastUsedAt`; a targeted UpdateItem, so it cannot race the full-row replace that rotates the
   * trust secret.
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

  /** Every trusted device for a user, by Query on the `userId` PK (the grant includes Query, not Scan). */
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
   * Atomically records one failed password attempt from this trusted device, conditioned on
   * `attribute_exists(tokenHash)`: a bare ADD on an absent row would mint one with no `tokenHash` or `expiresAt` that
   * never expires. Returns null when the row is gone (untrusted).
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
      // The row is gone or a newer failure stamped a later `lastFailedAt`: retry the increment alone, still gated on
      // existence.
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
   * Clears the per-device failure counter after a successful password verification; conditioned on existence, since
   * an unconditioned UpdateItem would create a bare key-only row.
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
