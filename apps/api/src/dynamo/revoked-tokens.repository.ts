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

/** Field-level projection of a `RevokedToken` row for the full account export: jti, kind, revokedAt, expiresAt only — the exact
 *  attributes the `UserIndex` GSI projects (`INCLUDE`), so this never needs a
 *  per-row `GetItem` against the base table. */
export interface RevokedTokenExportRow {
  jti: string;
  kind?: 'mfa_challenge' | 'generation_revoked' | 'family_barrier';
  revokedAt: string;
  expiresAt: number;
}

/**
 * Namespaced key for an account's retired session-generation tombstone —
 * see
 * {@link RevokedTokensRepository.tombstoneGenerationTransactItem}'s doc
 * comment for the invariant this key encodes. Keying by the RETIRED value
 * (not the current one) turns "is this access token's generation dead?" into
 * one exact-key `GetItem` — `JwtAuthGuard` cannot ask a range question. The
 * `gen:` prefix keeps this namespace disjoint from the bare-UUID
 * bearer-token rows and the `mfa:`-prefixed challenge-consumption ledger.
 */
function generationTombstoneKey(userId: string, generation: number): string {
  return `gen:${userId}:${generation}`;
}

/**
 * Namespaced key for a token family's revocation barrier — refresh-token issuance and rotation
 * ConditionCheck its absence in the SAME transaction as their own row Put, so no descendant can
 * commit once the barrier exists. `tokenFamilyId` is already a globally unique `randomUUID()`, so
 * the key needs no `userId` component. The `family:` prefix keeps this namespace disjoint from
 * bearer-token and tombstone rows.
 */
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
   * Hot-path read on every authenticated request. Single GetItem against
   * a small table is ~5-10 ms and is the cost we accept in exchange for
   * immediate logout.
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
   * Single-use MFA-challenge consumption. Writes a `mfa_challenge` ledger row keyed by the
   * challenge's `mfa:<uuid>` jti under `attribute_not_exists(jti)`, so exactly one caller can ever
   * consume a given challenge — a replayed challenge (sequential or concurrent) loses the
   * conditional write and is rejected. The `mfa:` prefix is asserted here so a bare-UUID bearer jti
   * can never be written as a consumption row (keeping `isRevoked`, called only with bare jtis,
   * namespace-disjoint from this ledger). The row's numeric TTL is the challenge's own expiry, so
   * consumed rows self-purge once the 5-min window closes.
   *
   * Returns `true` when this call won the single-use write, `false` when the
   * challenge was already consumed (the `ConditionalCheckFailedException`
   * this conditional PutItem throws by name — a single-item conditional write,
   * unlike a transaction, does throw it directly).
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
   * Build the transact item that tombstones a just-retired account session
   * generation. MUST be committed in the
   * SAME `TransactWriteItems` as
   * {@link UsersRepository.bumpSessionGenerationTransactItem}'s matching bump
   * for `retiredGeneration` — see that method's doc comment for the
   * invariant: a generation that stops being current always gets its
   * tombstone written in the same atomic write that retires it, or a token
   * minted under it could pass `JwtAuthGuard` forever. No
   * `ConditionExpression`: a given generation value is retired at most once
   * by construction (the paired bump's own condition pins the exact value
   * being moved away from), so this Put can never collide.
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
   * Hot-path read (`JwtAuthGuard`) — true iff `generation` has been retired
   * for `userId`. Issued CONCURRENTLY with {@link isRevoked} (never
   * sequentially — see jwt-auth.guard.ts, which explains why).
   *
   * `ConsistentRead: true`: the
   * default eventually-consistent `GetItem` can be served from a replica
   * that has not yet received the tombstone this call is checking for,
   * immediately after `SessionRevocationService.retireCurrentGeneration`'s
   * transaction commits it — letting a just-retired generation's access
   * token pass the guard for the length of that replica lag. DynamoDB Local
   * cannot reproduce that lag, so only the `ConsistentRead` read (not a
   * DynamoDB-Local-backed test) closes this.
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
   * Build the ConditionCheck transact item asserting a token family carries
   * NO revocation barrier — included in the
   * same transaction as a refresh-token issuance/rotation row Put so no
   * descendant of a revoked family can commit after the barrier lands.
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
   * Plant a token family's revocation barrier — used by refresh-token reuse detection (writes this
   * FIRST, before enumerating the family with a strongly consistent read) and by single-session
   * logout (`RefreshTokenService.revokeOne`). Unconditional Put: a barrier is idempotent to
   * re-write, and either caller only needs it to exist by the time a future issuance/rotation's OWN
   * transaction ConditionChecks its absence — not to originate from a transaction of its own.
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
   * Every revoked/denylisted-token row attributable to `userId`, via the `UserIndex` GSI added for
   * this purpose (the base table is keyed by `jti` alone, so there is no other way to reach a
   * user's rows without a Scan). Returns only the GSI-projected attributes — see {@link
   * RevokedTokenExportRow}.
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
