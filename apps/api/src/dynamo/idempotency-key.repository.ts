import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import { batchWriteDraining } from './batch-write.util.js';
import type { IdempotencyKeyRow } from './types.js';

const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;
const BATCH_SIZE = 25;

@Injectable()
export class IdempotencyKeyRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_IDEMPOTENCY_KEY');
  }

  static composeKey(householdId: string, deviceId: string, mutationId: string): string {
    return `${householdId}#${deviceId}#${mutationId}`;
  }

  async lookup(key: string): Promise<IdempotencyKeyRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { key } }),
    );
    return (r.Item as IdempotencyKeyRow | undefined) ?? null;
  }

  /**
   * Conditional delete for the version-aware rejection replay: removes the cached row only if it is still a
   * `rejected` outcome at `expectedVersion`, so a blind delete cannot wipe a concurrently applied row and cache a
   * false CONFLICT over an applied mutation. `undefined` targets a legacy row that never stamped the field. Returns
   * false (never throws) when the row changed underneath.
   */
  async delete(key: string, expectedVersion: number | undefined): Promise<boolean> {
    const names: Record<string, string> = {
      '#k': 'key',
      '#r': 'response',
      '#status': 'status',
      '#ev': 'expectedVersion',
    };
    const values: Record<string, unknown> = { ':rejected': 'rejected' };
    const versionCondition =
      expectedVersion === undefined
        ? 'attribute_not_exists(#ev)'
        : '#ev = :ev';
    if (expectedVersion !== undefined) values[':ev'] = expectedVersion;
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { key },
          ConditionExpression: `attribute_exists(#k) AND #r.#status = :rejected AND ${versionCondition}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    } catch (err) {
      // An absent key also lands here; treated as changed underneath. The SDK error name is string-compared, as in
      // workspace-meta.repository.ts.
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Hard-deletes every idempotency row whose key starts with `<householdId>#`, for the shared sweep
   * (`HouseholdSweepService`; see AGENTS.md, "Project-specific security"). No GSI on householdId, so a Scan with
   * `begins_with`; volume is small (7-day TTL).
   */
  async deleteAllForHousehold(householdId: string): Promise<void> {
    const prefix = `${householdId}#`;
    let lastKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: 'begins_with(#k, :p)',
          ExpressionAttributeNames: { '#k': 'key' },
          ExpressionAttributeValues: { ':p': prefix },
          ProjectionExpression: '#k',
          ExclusiveStartKey: lastKey,
        }),
      );
      const rows = (r.Items as Pick<IdempotencyKeyRow, 'key'>[] | undefined) ?? [];
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        await batchWriteDraining(this.doc, {
          [this.tableName]: batch.map((row) => ({
            DeleteRequest: { Key: { key: row.key } },
          })),
        });
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
  }

  /**
   * Every idempotency row for the household, whole (unlike the key-only projection of `deleteAllForHousehold`), by
   * the same `begins_with` Scan.
   */
  async listForHousehold(householdId: string): Promise<IdempotencyKeyRow[]> {
    const prefix = `${householdId}#`;
    const out: IdempotencyKeyRow[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: 'begins_with(#k, :p)',
          ExpressionAttributeNames: { '#k': 'key' },
          ExpressionAttributeValues: { ':p': prefix },
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const item of (r.Items as IdempotencyKeyRow[] | undefined) ?? []) {
        out.push(item);
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return out;
  }

  /**
   * Builds a row with a ready-to-use TTL, to write in the same TransactWriteItems as the mutation. `expectedVersion`
   * is stamped only when caching a rejected outcome, for the version-aware replay comparison.
   */
  static rowFor(
    key: string,
    response: IdempotencyKeyRow['response'],
    expectedVersion?: number,
  ): IdempotencyKeyRow {
    const now = new Date();
    return {
      key,
      response,
      createdAt: now.toISOString(),
      expiresAt: Math.floor(now.getTime() / 1000) + SEVEN_DAYS_SEC,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    };
  }
}
