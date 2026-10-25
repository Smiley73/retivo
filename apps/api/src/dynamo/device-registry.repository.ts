// DeviceRegistry row access (PK householdId, SK deviceId): an audit and display-name row per device. Outside the sync loop only the
// household sweep touches it.
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
   * Hard-deletes every device-registry row for a household, for the shared household sweep only
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
   * Every device-registry row for a household, whole (not the key-only projection of the sweep), for the account
   * export.
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
