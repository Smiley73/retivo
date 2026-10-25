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
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import type { TransactItem } from './transact-write.js';
import type { PasskeyRow } from './types.js';

@Injectable()
export class PasskeysRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_PASSKEY');
  }

  async find(userId: string, credentialId: string): Promise<PasskeyRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { userId, credentialId } }),
    );
    return (r.Item as PasskeyRow | undefined) ?? null;
  }

  /**
   * Every passkey row for a user, looping on `LastEvaluatedKey`: the partition has no count cap and can exceed 1 MB,
   * and one page would truncate `deleteAllForUser` and the export.
   */
  async listForUser(userId: string): Promise<PasskeyRow[]> {
    const out: PasskeyRow[] = [];
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
      out.push(...((r.Items as PasskeyRow[] | undefined) ?? []));
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return out;
  }

  async insert(row: PasskeyRow): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: row }),
    );
  }

  /**
   * Advances the signature counter and stamps `lastUsedAt` as a conditional write, since passkey login and the MFA
   * passkey factor can race and a blind SET would let a stale assertion overwrite a newer counter, defeating clone
   * detection. The condition keys on the stored counter: `attribute_not_exists` (first write), `= 0` (most platform
   * and synced passkeys report 0 forever, so 0 to 0 still updates `lastUsedAt`), or `< :counter` (strictly increasing
   * once the stored counter is above 0). A failure surfaces as `PASSKEY_COUNTER_ANOMALY`.
   */
  async updateCounterAndLastUsed(
    userId: string,
    credentialId: string,
    counter: number,
    lastUsedAt: string,
  ): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId, credentialId },
        UpdateExpression:
          'SET #counter = :counter, lastUsedAt = :lastUsedAt',
        ConditionExpression:
          'attribute_not_exists(#counter) OR #counter = :zero OR #counter < :counter',
        ExpressionAttributeNames: { '#counter': 'counter' },
        ExpressionAttributeValues: {
          ':counter': counter,
          ':lastUsedAt': lastUsedAt,
          ':zero': 0,
        },
      }),
    );
  }

  /**
   * Lifts a passkey post-reset restriction, removing both attributes; the caller
   * (`StepUpService.confirmRestrictedPasskey`) has already verified the proof.
   */
  async clearRestriction(userId: string, credentialId: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId, credentialId },
        UpdateExpression: 'REMOVE restrictedPostReset, restrictedByResetRequestedAt',
      }),
    );
  }

  /**
   * Deletes a credential and reports whether a row existed (`ALL_OLD`), for callers that gate a side effect on an
   * actual removal, such as the factor-change notice. The endpoint stays idempotent.
   */
  async remove(userId: string, credentialId: string): Promise<boolean> {
    const r = await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { userId, credentialId },
        ReturnValues: 'ALL_OLD',
      }),
    );
    return r.Attributes !== undefined;
  }

  /**
   * The credential delete as a transact item for the factor-undo consume: committed with the single-use token clear,
   * so the credential is only deleted while its token is still active. Unconditional on the row, so deleting an
   * absent row succeeds.
   */
  removeTransactItem(userId: string, credentialId: string): TransactItem {
    return { Delete: { TableName: this.tableName, Key: { userId, credentialId } } };
  }

  async deleteAllForUser(userId: string): Promise<void> {
    const rows = await this.listForUser(userId);
    for (const row of rows) {
      await this.remove(userId, row.credentialId);
    }
  }
}
