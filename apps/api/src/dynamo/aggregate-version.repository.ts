// AggregateVersion row access. The primary writer is sync/push.service.ts; this repo only exposes the read and sweep paths outside
// the push loop.
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
   * Unconditional PutItem, used by `RestoreService` to reseed rows from a restored snapshot so the first post-restore
   * push does not hit a spurious CONFLICT; overwriting keeps a retry idempotent.
   */
  async put(row: AggregateVersionRow): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: row }),
    );
  }

  /**
   * Hard-deletes every aggregate-version row for a household, for the shared household sweep only
   * (`HouseholdSweepService`; see AGENTS.md, "Project-specific security").
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
   * Every aggregate-version row for a household, whole (not the key-only projection of the sweep), for the account
   * export.
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
