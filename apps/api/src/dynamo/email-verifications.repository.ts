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
import type { EmailVerificationRow } from './types.js';

@Injectable()
export class EmailVerificationsRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_EMAIL_VERIFICATION');
  }

  /**
   * Looks up a verification row by PK; the caller passes the SHA-256 hash of the raw token, and this repo performs no
   * hashing.
   */
  async findByToken(token: string): Promise<EmailVerificationRow | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { verificationToken: token },
      }),
    );
    return (r.Item as EmailVerificationRow | undefined) ?? null;
  }

  async deleteToken(token: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { verificationToken: token },
      }),
    );
  }

  /**
   * Deletes every verification row for a user in the account-deletion cascade; the PK is the token (no GSI on
   * userId), so this scans with a filter.
   */
  async deleteAllForUser(userId: string): Promise<void> {
    let lastKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: 'userId = :u',
          ExpressionAttributeValues: { ':u': userId },
          ProjectionExpression: 'verificationToken',
          ExclusiveStartKey: lastKey,
        }),
      );
      const tokens = (r.Items as Pick<EmailVerificationRow, 'verificationToken'>[] | undefined) ?? [];
      for (const row of tokens) {
        await this.deleteToken(row.verificationToken);
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
  }

  /** Every verification row for a user, whole, by the same filtered scan as `deleteAllForUser`. */
  async listForUser(userId: string): Promise<EmailVerificationRow[]> {
    const out: EmailVerificationRow[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: 'userId = :u',
          ExpressionAttributeValues: { ':u': userId },
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const item of (r.Items as EmailVerificationRow[] | undefined) ?? []) {
        out.push(item);
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return out;
  }
}
