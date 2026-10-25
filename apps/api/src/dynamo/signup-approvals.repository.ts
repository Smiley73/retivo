// Read/write surface for the SignupApproval table (PK is the approval token, no GSI). The PK is the SHA-256 digest of the raw token,
// hashed by SignupApprovalService, so a raw token never reaches this repo or its logs.
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import type { SignupApprovalRow } from './types.js';

@Injectable()
export class SignupApprovalsRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_SIGNUP_APPROVAL');
  }

  /** Used by the resend / decline endpoints when only the token is in hand. */
  async findByToken(token: string): Promise<SignupApprovalRow | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { approvalToken: token },
      }),
    );
    return (r.Item as SignupApprovalRow | undefined) ?? null;
  }

  async insert(row: SignupApprovalRow): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: row }),
    );
  }

  async deleteToken(token: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { approvalToken: token },
      }),
    );
  }

  /**
   * Sweeps every approval row for a user on cleanup paths (account-deletion cascade, signup recycle), so a stale row
   * does not outlive the user it gates.
   */
  async deleteAllForUser(userId: string): Promise<void> {
    let lastKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: 'userId = :u',
          ExpressionAttributeValues: { ':u': userId },
          ProjectionExpression: 'approvalToken',
          ExclusiveStartKey: lastKey,
        }),
      );
      const tokens =
        (r.Items as Pick<SignupApprovalRow, 'approvalToken'>[] | undefined) ?? [];
      for (const row of tokens) {
        await this.deleteToken(row.approvalToken);
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
  }

  /**
   * Every approval row for a user, whole; the PK is the hashed token (no GSI on userId), so this Scans with a filter.
   */
  async listForUser(userId: string): Promise<SignupApprovalRow[]> {
    const out: SignupApprovalRow[] = [];
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
      for (const item of (r.Items as SignupApprovalRow[] | undefined) ?? []) {
        out.push(item);
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return out;
  }
}
