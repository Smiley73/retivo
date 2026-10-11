/**
 * Read/write surface for the SignupApproval table. Mirrors the
 * EmailVerificationsRepository shape — the PK is the key, no GSI; the
 * cleanup paths (DELETE /auth/account, the cascade Lambda, and the
 * lazy signup-recycle in SignupService) read by primary key.
 *
 * Hashed key at rest: the
 * `approvalToken` PK is the SHA-256 digest of the raw approval token, never the
 * raw token itself — `SignupApprovalService` hashes at its boundary before
 * insert/lookup/delete, so this repository only ever handles digests (a raw
 * token never reaches it or its logs). Every `token` parameter below is that
 * already-hashed key.
 */
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
   * Sweep every approval row for a user. Used by the account-deletion
   * cascade and the signup-recycle path so a stale row doesn't outlive
   * the user it gates. Volume is small (one active row per pending user)
   * and this only runs on cleanup paths.
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
   * Every approval row for a user, WHOLE — the table
   * PK is the hashed approval token (no GSI on userId), so this Scans with a
   * filter, mirroring {@link deleteAllForUser}. Volume is small (one active
   * row per pending user).
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
