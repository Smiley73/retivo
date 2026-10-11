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

/**
 * The single-row revoke condition shared by {@link RefreshTokensRepository.markRevoked}
 * and {@link RefreshTokensRepository.revokeTransactItem}: the row must still
 * exist AND not already be revoked. See `markRevoked` for why the existence
 * guard is load-bearing.
 */
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
   * Build the Put transact item for a fresh refresh-token row — used by `RefreshTokenService.issue`
   * alongside the generation and family-barrier `ConditionCheck`s in the
   * same `TransactWriteItems`, replacing the bare {@link insert} Put on
   * every issuance/rotation path. No `ConditionExpression` of its own: the
   * key (`userId`, `tokenHash`) is derived from 48 random bytes, so a
   * collision is not a case this repository guards against.
   */
  insertTransactItem(row: RefreshTokenRow): TransactItem {
    return { Put: { TableName: this.tableName, Item: row } };
  }

  /**
   * `opts.consistentRead`:
   * `RefreshTokenService.revokeOne` treats a null result here as "no such
   * row, nothing to revoke" and returns without planting the family barrier
   * or revoking anything. A plain `GetCommand` is served by any replica, so
   * a row inserted by a rotation moments earlier (the SPA's
   * refresh-then-sign-out ordering) can appear missing here purely from
   * replica lag, silently skipping the whole revocation. `revokeOne` passes
   * `ConsistentRead: true` so the early return can only fire for a row that
   * genuinely does not exist. Every other caller keeps the cheaper default.
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
   * Update the CURRENT session's recorded write authority in place —
   * no new row, no token exchange, no
   * cookie. Called by `POST /auth/verify-password` after a successful
   * verification (and by the key-setup flow, which reuses that same route):
   * a session that just proved the current password is granted the authority
   * to write a password slot, the same way a fresh login records it. A
   * missing row (e.g. a concurrent logout) is a silent no-op — there is no
   * session left to grant authority to.
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
   * Mark a single refresh-token row revoked. Used by
   * `RefreshTokenService.revokeOne` (single-session logout).
   *
   * Requires the row to still exist — `attribute_exists(userId)`, the same
   * guard {@link revokeFamily} and {@link updateCredentialRevision} already
   * carry. Without it, an
   * `UpdateItem` whose only condition is `attribute_not_exists(revokedAt)`
   * SUCCEEDS against an absent key (that attribute does not exist on a
   * missing item either) and CREATES a partial row holding nothing but the
   * keys and `revokedAt`: no `expiresAt`, so TTL never removes it, and no
   * `tokenFamilyId`, so no family sweep ever sees it. A logout whose lookup
   * of the presented row completed just before the account-deletion
   * cascade's `deleteAllForUser` sweep would otherwise leave that row behind
   * permanently for a deleted account. The caller treats the resulting
   * `ConditionalCheckFailedException` as the same no-op as an already-revoked
   * row.
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
   * Build the Update transact item that conditionally revokes a single row —
   * the same condition as {@link markRevoked} (including its existence
   * guard, so a presented row deleted mid-rotation fails the whole
   * transaction closed instead of being recreated as a partial row), as a
   * transact item so `RefreshTokenService.rotate` can commit the presented
   * row's revoke in the SAME `TransactWriteItems` as its descendant's Put
   * and the generation / family-barrier `ConditionCheck`s.
   * Before this
   * existed, rotation committed the revoke FIRST and the descendant's
   * issuance as a SEPARATE transaction: a transient cancellation of the
   * second transaction left the presented row revoked with no successor, and
   * the client's own retry of that revoked cookie was then classified as
   * reuse. Folding both into one transaction means either both commit or
   * neither does, so a transient cancellation leaves the presented token
   * genuinely unchanged and retryable.
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
   * List every refresh-token row for a user (active + revoked, all
   * families). Used by password-change to revoke all sessions at once and by
   * the account-data export. Fully paginated (see the loop below) — a user's
   * partition can exceed DynamoDB's 1 MB `Query` response limit once enough
   * sessions/rotations have accumulated, so nothing here assumes a small row
   * count.
   */
  async listAllForUser(userId: string): Promise<RefreshTokenRow[]> {
    // Loops on `LastEvaluatedKey` — a user's partition can exceed DynamoDB's 1 MB `Query`
    // response limit if enough sessions/rotations have accumulated, and a
    // single-page read would silently truncate both password-change's
    // revoke-all-sessions sweep and the account export.
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
   * List every row of a token family in a user's partition. Used by reuse
   * detection (`RefreshTokenService`) to find the full family to revoke.
   * Fully paginated (see the loop below, same shape as `listAllForUser`
   * above): DynamoDB
   * applies `FilterExpression` *after* reading up to 1 MB of the partition,
   * so pagination is driven by the size of the whole `userId` partition
   * (every family, every rotation, revoked rows included), not by the size
   * of the one family being filtered for. A page whose filtered `Items` is
   * empty can still carry a `LastEvaluatedKey`, so an empty page must not
   * end enumeration — only an absent continuation key does.
   *
   * `opts.consistentRead`: reuse detection
   * writes the family's revocation barrier and THEN calls this with
   * `ConsistentRead: true` — a descendant row inserted in the brief window
   * between that Put and this enumeration must be seen, or it survives
   * detection. DynamoDB Local is more consistent than production, so this
   * property cannot be proven by an emulator-backed test; the strongly
   * consistent read is the reason it holds regardless. Every other caller
   * keeps the cheaper default.
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

  /**
   * DynamoDB's hard per-call cap on `TransactWriteItems` (applies across every
   * table in the request; this repository only ever puts rows from its own
   * table in one). `revokeFamily` chunks against it below.
   */
  private static readonly TRANSACT_WRITE_LIMIT = 100;

  /**
   * Revoke every row in a given set of refresh-token rows, chunked into
   * transactions of at most `TRANSACT_WRITE_LIMIT` items. Caller passes the
   * full list (e.g. from `listFamily`, or every active row for a user from
   * `SessionRevocationService.revokeAll`) to avoid double round-trips. A
   * single unchunked transaction would fail outright once a caller passes
   * more than 100 rows (e.g. a user with many devices/rotations whose
   * session-revocation sweep denylists ALL of their active rows) —
   * chunking keeps every row's revoke recoverable instead of failing the
   * whole sweep on that one caller.
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
   * Hard-delete every refresh-token row for a user, regardless of family
   * or revoked state. Used by `DeleteAccountService` after the family has
   * already been revoked + access-token jtis denylisted. Issues
   * single-item DeleteItem calls (rather than BatchWriteItem) so the api
   * role's narrow IAM scope does not need widening for this table. Volume per user is tiny
   * (one chain of rotations per device).
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
