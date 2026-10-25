// Repository for the PasskeyChallenge table (PK key): one row per in-flight WebAuthn ceremony. Point-ops only (Put/Delete grant);
// `issue` overwrites, `consume` is the single-use primitive.
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import type { PasskeyChallengeRow } from './types.js';

@Injectable()
export class PasskeyChallengeRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_PASSKEY_CHALLENGE');
  }

  /** Issue (create or replace) the challenge row for `row.key`. Overwrites — see class doc. */
  async issue(row: PasskeyChallengeRow): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: row }));
  }

  /**
   * Single-use consume: one atomic conditional DeleteItem returning the prior image, null when the key never existed
   * or was consumed. The condition is load-bearing: DynamoDB Local has been seen returning the prior image to both
   * sides of a concurrent unconditional delete, so there is deliberately no `get` (read-then-delete would reopen the
   * race).
   */
  async consume(key: string): Promise<PasskeyChallengeRow | null> {
    try {
      const r = await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { key },
          ConditionExpression: 'attribute_exists(#k)',
          ExpressionAttributeNames: { '#k': 'key' },
          ReturnValues: 'ALL_OLD',
        }),
      );
      return (r.Attributes as PasskeyChallengeRow | undefined) ?? null;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return null;
      throw err;
    }
  }
}
