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
   * The highest `sequenceId` (KSUID) currently live for a household, or
   * `null` when the log is empty. `RestoreService.clearToEmpty` uses it to
   * derive a convergence watermark strictly greater than every live device
   * cursor. A `ScanIndexForward: false` query with `Limit: 1` returns
   * the partition's top sort key.
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
   * Every mutation-log row for a household, WHOLE —
   * unlike {@link pageSince} (which is bounded to `PAGE_LIMIT` per call for the
   * live sync-pull loop), this pages internally until exhausted so the caller
   * gets the complete household history in one call. The account-export
   * builder drops `payload` (ciphertext already covered by the `aggregates`
   * export section) at the service layer, not here.
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
   * Hard-delete every mutation-log row for a household. Used only by the
   * shared household-data sweep (`HouseholdSweepService`) — the four
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
