import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DynamoDBDocumentClient,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import { batchWriteDraining } from './batch-write.util.js';
import type { MutationLogRow } from './types.js';

const BATCH_SIZE = 25;

@Injectable()
export class MutationLogRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_MUTATION_LOG');
  }

  /** Page through entries with sequenceId > since. */
  async pageSince(
    householdId: string,
    since: string,
    limit: number,
  ): Promise<{ items: MutationLogRow[]; lastSequenceId: string | null; hasMore: boolean }> {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          'householdId = :h AND sequenceId > :s',
        ExpressionAttributeValues: { ':h': householdId, ':s': since },
        Limit: limit,
      }),
    );
    const items = (r.Items as MutationLogRow[] | undefined) ?? [];
    const last = items[items.length - 1]?.sequenceId ?? null;
    return { items, lastSequenceId: last, hasMore: !!r.LastEvaluatedKey };
  }

  /**
   * The highest live `sequenceId` for a household, or null when the log is empty; `RestoreService.clearToEmpty`
   * derives its convergence watermark from it.
   */
  async maxSequenceId(householdId: string): Promise<string | null> {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'householdId = :h',
        ExpressionAttributeValues: { ':h': householdId },
        ProjectionExpression: 'sequenceId',
        ScanIndexForward: false,
        Limit: 1,
      }),
    );
    const rows =
      (r.Items as Pick<MutationLogRow, 'sequenceId'>[] | undefined) ?? [];
    return rows[0]?.sequenceId ?? null;
  }

  /**
   * Every mutation-log row for a household, whole, paged internally until exhausted (unlike `pageSince`). The export
   * builder drops `payload` at the service layer.
   */
  async listForHousehold(householdId: string): Promise<MutationLogRow[]> {
    const out: MutationLogRow[] = [];
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
      for (const item of (r.Items as MutationLogRow[] | undefined) ?? []) {
        out.push(item);
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return out;
  }

  /**
   * Hard-deletes every mutation-log row for a household, for the shared household sweep only
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
          ProjectionExpression: 'householdId, sequenceId',
          ExclusiveStartKey: lastKey,
        }),
      );
      const rows = (r.Items as Pick<MutationLogRow, 'householdId' | 'sequenceId'>[] | undefined) ?? [];
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        await batchWriteDraining(this.doc, {
          [this.tableName]: batch.map((row) => ({
            DeleteRequest: { Key: { householdId: row.householdId, sequenceId: row.sequenceId } },
          })),
        });
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
  }
}
