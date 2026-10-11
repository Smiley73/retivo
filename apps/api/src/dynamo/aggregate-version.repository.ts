/**
 * `AggregateVersion` row access. The table's primary writer is
 * `sync/push.service.ts` (conditional version puts inside a
 * `TransactWriteItems`) — this repo only exposes the read + sweep
 * paths used outside the hot push loop.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import { batchWriteDraining } from './batch-write.util.js';
import type { AggregateVersionRow } from './types.js';

const BATCH_SIZE = 25;

@Injectable()
export class AggregateVersionRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_AGGREGATE_VERSION');
  }

  /**
   * Single-item unconditional PutItem. Used by `RestoreService` to
   * repopulate `AggregateVersion` rows from a restored snapshot after
   * the sweep cleared them, so the first post-restore push asserts
   * against the correct version instead of hitting a spurious CONFLICT
   * on a missing row. Unconditional (overwrite) keeps the restore
   * idempotent — a retry re-seeds the same rows.
   */
  async put(row: AggregateVersionRow): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: row }),
    );
  }

  /**
   * Hard-delete every aggregate-version row for a household. Used only by
   * the shared household-data sweep (`HouseholdSweepService`) — the four
   * authorised consumers: account deletion (`DELETE /auth/account`),
   * encrypted-workspace reset (`POST /auth/encrypted-workspace-reset`),
   * self-service restore (`POST /sync/restore`), and the
   * server-authoritative workspace clear (`POST /sync/workspace/clear`).
   * The api-role IAM policy permits `BatchWriteItem` on this table for
   * that sweep.
   */
  async deleteAllForHousehold(householdId: string): Promise<void> {
    let lastKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'householdId = :h',
          ExpressionAttributeValues: { ':h': householdId },
          ProjectionExpression: 'householdId, aggregateId',
          ExclusiveStartKey: lastKey,
        }),
      );
      const rows = (r.Items as Pick<AggregateVersionRow, 'householdId' | 'aggregateId'>[] | undefined) ?? [];
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        await batchWriteDraining(this.doc, {
          [this.tableName]: batch.map((row) => ({
            DeleteRequest: { Key: { householdId: row.householdId, aggregateId: row.aggregateId } },
          })),
        });
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
  }

  /**
   * Every aggregate-version row for a household, WHOLE —
   * unlike {@link deleteAllForHousehold}'s key-only projection, used for the
   * account-export builder.
   */
  async listForHousehold(householdId: string): Promise<AggregateVersionRow[]> {
    const out: AggregateVersionRow[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'householdId = :h',
          ExpressionAttributeValues: { ':h': householdId },
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const item of (r.Items as AggregateVersionRow[] | undefined) ?? []) {
        out.push(item);
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return out;
  }
}
