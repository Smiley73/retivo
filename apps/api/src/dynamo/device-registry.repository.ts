/**
 * `DeviceRegistry` row access. PK `householdId`, SK `deviceId`. Audit /
 * display-name row per device that has ever pushed (single-device v1).
 *
 * The only path that touches this table outside the sync hot loop is the
 * shared household-data sweep (`HouseholdSweepService`), whose four
 * authorised consumers are `DELETE /auth/account`,
 * `POST /auth/encrypted-workspace-reset`, `POST /sync/restore`, and
 * `POST /sync/workspace/clear` — it deletes every device row for a
 * household.
 */
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
import type { DeviceRegistryRow } from './types.js';

const BATCH_SIZE = 25;

@Injectable()
export class DeviceRegistryRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_DEVICE_REGISTRY');
  }

  /**
   * Hard-delete every device-registry row for a household. Used only by
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
          ProjectionExpression: 'householdId, deviceId',
          ExclusiveStartKey: lastKey,
        }),
      );
      const rows =
        (r.Items as Pick<DeviceRegistryRow, 'householdId' | 'deviceId'>[] | undefined) ?? [];
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        await batchWriteDraining(this.doc, {
          [this.tableName]: batch.map((row) => ({
            DeleteRequest: {
              Key: { householdId: row.householdId, deviceId: row.deviceId },
            },
          })),
        });
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
  }

  /**
   * Every device-registry row for a household, WHOLE —
   * unlike {@link deleteAllForHousehold}'s key-only projection, used for the
   * account-export builder.
   */
  async listForHousehold(householdId: string): Promise<DeviceRegistryRow[]> {
    const out: DeviceRegistryRow[] = [];
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
      for (const item of (r.Items as DeviceRegistryRow[] | undefined) ?? []) {
        out.push(item);
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return out;
  }
}
