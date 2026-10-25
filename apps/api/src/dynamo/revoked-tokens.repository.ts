import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import type { TransactItem } from './transact-write.js';
import type { RevokedTokenRow } from './types.js';

/**
 * Projection of a RevokedToken row for the account export: the attributes the `UserIndex` GSI projects, so no per-row
 * GetItem is needed.
 */
export interface RevokedTokenExportRow {
  jti: string;
  kind?: 'mfa_challenge' | 'generation_revoked' | 'family_barrier';
  revokedAt: string;
  expiresAt: number;
}

// Tombstone key for a retired session generation, keyed by the retired value so JwtAuthGuard can check it with one
// exact-key GetItem. The `gen:` prefix keeps it disjoint from bare-UUID and `mfa:` rows.
function generationTombstoneKey(userId: string, generation: number): string {
  return `gen:${userId}:${generation}`;
}

// Family-barrier key: issuance and rotation ConditionCheck its absence in the same transaction as their Put, so no
// descendant commits once it exists. The `family:` prefix keeps it disjoint from other rows.
function familyBarrierKey(tokenFamilyId: string): string {
  return `family:${tokenFamilyId}`;
}

@Injectable()
export class RevokedTokensRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_REVOKED_TOKEN');
  }

  /**
   * Hot-path read on every authenticated request: one GetItem on a small table, the accepted cost of immediate
   * logout.
   */
  async isRevoked(jti: string): Promise<boolean> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { jti } }),
    );
    return r.Item !== undefined;
  }

  async revoke(row: RevokedTokenRow): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: row }),
    );
  }

  /**
   * Single-use MFA-challenge consumption: writes a `mfa_challenge` ledger row under `attribute_not_exists(jti)`, so a
   * replayed challenge loses the write. The `mfa:` prefix is asserted so a bare-UUID bearer jti is never written as a
   * consumption row. The TTL is the challenge own expiry. Returns false when already consumed.
   */
  async consumeMfaChallenge(args: {
    jti: string;
    userId: string;
    expiresAt: number;
  }): Promise<boolean> {
    if (!args.jti.startsWith('mfa:')) {
      throw new Error('consumeMfaChallenge requires an mfa:-prefixed jti');
    }
    const row: RevokedTokenRow = {
      jti: args.jti,
      userId: args.userId,
      kind: 'mfa_challenge',
      revokedAt: new Date().toISOString(),
      expiresAt: args.expiresAt,
    };
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: row,
          ConditionExpression: 'attribute_not_exists(jti)',
        }),
      );
      return true;
    } catch (err) {
      if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Builds the item that tombstones a just-retired session generation. Must commit in the same TransactWriteItems as
   * the matching `UsersRepository.bumpSessionGenerationTransactItem`, or a token minted under the retired generation
   * would pass JwtAuthGuard forever. No condition: a generation is retired at most once, since the paired bump pins
   * the exact value.
   */
  tombstoneGenerationTransactItem(
    userId: string,
    retiredGeneration: number,
    expiresAt: number,
  ): TransactItem {
    const row: RevokedTokenRow = {
      jti: generationTombstoneKey(userId, retiredGeneration),
      userId,
      kind: 'generation_revoked',
      revokedAt: new Date().toISOString(),
      expiresAt,
    };
    return { Put: { TableName: this.tableName, Item: row } };
  }

  /**
   * Hot-path read (`JwtAuthGuard`): true iff `generation` was retired for `userId`, issued concurrently with
   * `isRevoked`. ConsistentRead, because a replica could miss the tombstone just committed by
   * `retireCurrentGeneration` and let a retired generation token pass; DynamoDB Local cannot reproduce that lag.
   */
  async isGenerationRevoked(userId: string, generation: number): Promise<boolean> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { jti: generationTombstoneKey(userId, generation) },
        ConsistentRead: true,
      }),
    );
    return r.Item !== undefined;
  }

  /**
   * Builds the ConditionCheck asserting a token family has no revocation barrier, in the same transaction as an
   * issuance or rotation Put.
   */
  conditionCheckNoFamilyBarrierTransactItem(tokenFamilyId: string): TransactItem {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: { jti: familyBarrierKey(tokenFamilyId) },
        ConditionExpression: 'attribute_not_exists(jti)',
      },
    };
  }

  /**
   * Plants a token family revocation barrier, used by reuse detection (before enumerating the family) and
   * single-session logout. An unconditional Put: it is idempotent and only needs to exist before a later issuance
   * ConditionChecks its absence.
   */
  async putFamilyBarrier(tokenFamilyId: string, userId: string, expiresAt: number): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: this.familyBarrierRow(tokenFamilyId, userId, expiresAt),
      }),
    );
  }

  private familyBarrierRow(tokenFamilyId: string, userId: string, expiresAt: number): RevokedTokenRow {
    return {
      jti: familyBarrierKey(tokenFamilyId),
      userId,
      kind: 'family_barrier',
      revokedAt: new Date().toISOString(),
      expiresAt,
    };
  }

  /**
   * Every revoked row attributable to `userId`, via the `UserIndex` GSI (the base table is keyed by `jti` alone, so
   * the alternative is a Scan). Returns only the projected attributes.
   */
  async listForUser(userId: string): Promise<RevokedTokenExportRow[]> {
    const out: RevokedTokenExportRow[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'UserIndex',
          KeyConditionExpression: 'userId = :u',
          ExpressionAttributeValues: { ':u': userId },
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const item of (r.Items as RevokedTokenExportRow[] | undefined) ?? []) {
        out.push({
          jti: item.jti,
          ...(item.kind ? { kind: item.kind } : {}),
          revokedAt: item.revokedAt,
          expiresAt: item.expiresAt,
        });
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return out;
  }
}
