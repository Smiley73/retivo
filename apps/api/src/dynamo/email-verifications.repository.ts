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
   * Look up a verification row by its PK. The caller passes the SHA-256 hash of the raw token, not
   * the raw token: the table stores the hash (hashed at the service boundary). This repo performs
   * no hashing.
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

  /** Delete by PK. Caller passes the stored SHA-256 hash. */
  async deleteToken(token: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { verificationToken: token },
      }),
    );
  }

  /**
   * Delete every verification row for a user. The table PK is the
   * verification token (no GSI on userId), so this scans with a filter.
   * Volume is small per user — the email-verification flow keeps at most
   * one active token + a short TTL — and this only runs in the account-
   * deletion cascade.
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

  /**
   * Every verification row for a user, WHOLE — the
   * table PK is the hashed token (no GSI on userId), so this Scans with a
   * filter, mirroring {@link deleteAllForUser}. Volume is small per user (at
   * most one active token + a short TTL).
   */
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
