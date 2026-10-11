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
   * Conditional single-key delete for the version-aware rejection replay.
   * Deletes the cached row ONLY if it is STILL a
   * `rejected` outcome at the exact `expectedVersion` the caller just read —
   * closing the TOCTOU: an unconditional delete could wipe a
   * concurrently-applied idempotency row (a race where retry A applies while
   * retry B's blind delete removes A's row and re-runs into an advanced
   * aggregate, caching a false CONFLICT over an applied mutation).
   *
   * `expectedVersion === undefined` targets a LEGACY cached row that
   * predates this field (never stamped it) — the condition then requires
   * `attribute_not_exists(expectedVersion)` instead of an equality match.
   *
   * Returns `false` (never throws) when the condition fails — the row was
   * deleted / re-cached / changed underneath by a concurrent request since
   * the caller's read. The caller replays whatever now occupies the key.
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
      // Deleting an absent key also lands here (attribute_exists(#k) fails)
      // — treated the same as "changed underneath" (the pattern used
      // elsewhere in this codebase: string-compare the SDK error name
      // rather than importing the exception class, matching
      // workspace-meta.repository.ts).
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Hard-delete every idempotency-key row whose composite key starts with
   * `<householdId>#`. Used only by the shared household-data sweep
   * (`HouseholdSweepService`) — the four authorised consumers: account
   * deletion (`DELETE /auth/account`), encrypted-workspace reset
   * (`POST /auth/encrypted-workspace-reset`), self-service restore
   * (`POST /sync/restore`), and the server-authoritative workspace clear
   * (`POST /sync/workspace/clear`). The table has no GSI on householdId,
   * so a Scan with `begins_with` is the only option. Volume is small
   * (≤ 7-day TTL × push rate). The api-role IAM policy permits
   * `BatchWriteItem` on this table for that sweep.
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
   * Every idempotency-key row whose composite key starts with `<householdId>#`,
   * WHOLE — unlike {@link deleteAllForHousehold}'s
   * key-only projection. Household id is unindexed by design; this Scans
   * with a `begins_with` filter, the same explicit-scan case the sweep uses —
   * no new grant.
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
   * Caller is expected to write idempotency rows as part of the same
   * TransactWriteItems that materializes the mutation; this helper
   * just produces a row with a ready-to-use TTL.
   *
   * `expectedVersion` is stamped only when caching a
   * REJECTED outcome — the mutation's attempted `version` at rejection time,
   * read later by the version-aware replay comparison. Applied outcomes
   * never need it (exact-replay semantics are unchanged).
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
