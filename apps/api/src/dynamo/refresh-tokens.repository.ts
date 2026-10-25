import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import type { TransactItem } from './transact-write.js';
import type { RefreshTokenRow } from './types.js';

// Revoke condition shared by markRevoked and revokeTransactItem: the row must exist and not already be revoked.
const REVOKE_CONDITION_EXPRESSION =
  'attribute_exists(userId) AND (attribute_not_exists(revokedAt) OR revokedAt = :null)';

@Injectable()
export class RefreshTokensRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_REFRESH_TOKEN');
  }

  async insert(row: RefreshTokenRow): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: row }),
    );
  }

  /**
   * Builds the Put for a fresh refresh-token row, used by `RefreshTokenService.issue` alongside the generation and
   * family-barrier ConditionChecks in one transaction. No condition of its own: the key derives from 48 random bytes.
   */
  insertTransactItem(row: RefreshTokenRow): TransactItem {
    return { Put: { TableName: this.tableName, Item: row } };
  }

  /**
   * `opts.consistentRead`: `RefreshTokenService.revokeOne` returns without planting the family barrier when this is
   * null, so a row inserted by a rotation moments earlier must not read as missing from replica lag. `revokeOne`
   * passes it; other callers keep the cheaper default read.
   */
  async find(
    userId: string,
    tokenHash: string,
    opts: { consistentRead?: boolean } = {},
  ): Promise<RefreshTokenRow | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { userId, tokenHash },
        ConsistentRead: opts.consistentRead,
      }),
    );
    return (r.Item as RefreshTokenRow | undefined) ?? null;
  }

  /**
   * Updates the current session recorded write authority in place (no new row, token or cookie), after `POST
   * /auth/verify-password` succeeds. A missing row (a concurrent logout) is a silent no-op.
   */
  async updateCredentialRevision(
    userId: string,
    tokenHash: string,
    credentialRevision: string,
  ): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { userId, tokenHash },
          UpdateExpression: 'SET credentialRevision = :rev',
          ConditionExpression: 'attribute_exists(userId)',
          ExpressionAttributeValues: { ':rev': credentialRevision },
        }),
      );
    } catch (err) {
      if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
        return;
      }
      throw err;
    }
  }

  /**
   * Marks one refresh-token row revoked (single-session logout). Requires `attribute_exists(userId)`: a condition on
   * `attribute_not_exists(revokedAt)` alone succeeds against an absent key and would create a partial row with no
   * `expiresAt` or `tokenFamilyId`, which TTL and family sweeps never see, leaving it behind after account deletion.
   * The caller treats the resulting ConditionalCheckFailedException as an already-revoked no-op.
   */
  async markRevoked(userId: string, tokenHash: string, at: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId, tokenHash },
        UpdateExpression: 'SET revokedAt = :at',
        ConditionExpression: REVOKE_CONDITION_EXPRESSION,
        ExpressionAttributeValues: { ':at': at, ':null': null },
      }),
    );
  }

  /**
   * Builds the conditional single-row revoke (same condition as `markRevoked`, existence guard included) as a
   * transact item, so `RefreshTokenService.rotate` commits the revoke with the successor Put and the ConditionChecks
   * in one transaction. A separate revoke-first transaction left the presented row revoked with no successor after a
   * transient cancellation, and the client retry then read as reuse.
   */
  revokeTransactItem(userId: string, tokenHash: string, at: string): TransactItem {
    return {
      Update: {
        TableName: this.tableName,
        Key: { userId, tokenHash },
        UpdateExpression: 'SET revokedAt = :at',
        ConditionExpression: REVOKE_CONDITION_EXPRESSION,
        ExpressionAttributeValues: { ':at': at, ':null': null },
      },
    };
  }

  /**
   * Lists every refresh-token row for a user (active and revoked, all families), fully paginated: the partition can
   * exceed the 1 MB Query limit.
   */
  async listAllForUser(userId: string): Promise<RefreshTokenRow[]> {
    // A single page would silently truncate password-change revoke-all and the account export.
    const out: RefreshTokenRow[] = [];
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
      out.push(...((r.Items as RefreshTokenRow[] | undefined) ?? []));
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return out;
  }

  /**
   * Lists every row of a token family, for reuse detection. Paginates on the whole `userId` partition because the
   * FilterExpression applies after the 1 MB read, so an empty page can still carry a LastEvaluatedKey.
   * `opts.consistentRead`: reuse detection writes the barrier then enumerates, and must see a descendant inserted in
   * between; DynamoDB Local is more consistent than production, so only ConsistentRead guarantees it.
   */
  async listFamily(
    userId: string,
    tokenFamilyId: string,
    opts: { consistentRead?: boolean } = {},
  ): Promise<RefreshTokenRow[]> {
    const out: RefreshTokenRow[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'userId = :u',
          FilterExpression: 'tokenFamilyId = :f',
          ExpressionAttributeValues: { ':u': userId, ':f': tokenFamilyId },
          ExclusiveStartKey: lastKey,
          ConsistentRead: opts.consistentRead,
        }),
      );
      out.push(...((r.Items as RefreshTokenRow[] | undefined) ?? []));
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return out;
  }

  // DynamoDB hard per-call cap on TransactWriteItems.
  private static readonly TRANSACT_WRITE_LIMIT = 100;

  /**
   * Revokes the given rows in transactions of at most `TRANSACT_WRITE_LIMIT`; a single transaction would fail
   * outright past 100 rows.
   */
  async revokeFamily(rows: RefreshTokenRow[], at: string): Promise<void> {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += RefreshTokensRepository.TRANSACT_WRITE_LIMIT) {
      const chunk = rows.slice(i, i + RefreshTokensRepository.TRANSACT_WRITE_LIMIT);
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: chunk.map((row) => ({
            Update: {
              TableName: this.tableName,
              Key: { userId: row.userId, tokenHash: row.tokenHash },
              UpdateExpression: 'SET revokedAt = :at',
              ConditionExpression: 'attribute_exists(userId)',
              ExpressionAttributeValues: { ':at': at },
            },
          })),
        }),
      );
    }
  }

  /**
   * Hard-deletes every refresh-token row for a user, used by `DeleteAccountService`. Single DeleteItem calls, so the
   * api-role IAM scope needs no BatchWriteItem on this table.
   */
  async deleteAllForUser(userId: string): Promise<void> {
    const rows = await this.listAllForUser(userId);
    for (const row of rows) {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { userId: row.userId, tokenHash: row.tokenHash },
        }),
      );
    }
  }
}
