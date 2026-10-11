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
   * Every passkey row for a user. Loops on `LastEvaluatedKey` — a user's partition can exceed
   * DynamoDB's 1 MB `Query` response limit if enough credentials are
   * enrolled (no TTL or count cap on this table), and a single-page read
   * would silently truncate both `deleteAllForUser` and the account export.
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
   * Advance the credential's signature counter + stamp `lastUsedAt` as a
   * conditional write that closes the TOCTOU. Two auth paths (passkey
   * login + the MFA passkey factor) can race a counter advance for the same
   * credential; a blind `SET` would let a stale/lost-update assertion overwrite
   * a newer counter and defeat clone detection.
   *
   * The condition preserves the (majority) zero-signCount authenticators and
   * keys the zero-exception on the STORED counter, never the presented value (a
   * presented-0 rollback against a stored-9 counter must be rejected, not roll
   * the stored counter back to 0):
   *  - `attribute_not_exists(#counter)` — first write after enrollment.
   *  - `#counter = :zero` — a zero-counter authenticator (most platform /
   *    synced passkeys report `counter: 0` forever; SimpleWebAuthn only flags a
   *    regression when both counters are non-zero), so a `0 → 0` assertion still
   *    updates `lastUsedAt` without rejection.
   *  - `#counter < :counter` — strict monotonicity once the STORED counter `> 0`,
   *    so a genuine regression / lost update on a counter-using authenticator is
   *    rejected (`ConditionalCheckFailedException`); the caller surfaces it as
   *    `PASSKEY_COUNTER_ANOMALY`.
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
   * Lift a passkey's post-reset restriction —
   * removes BOTH restriction attributes so a subsequent read has no leftover
   * `restrictedByResetRequestedAt` from a cleared restriction. Unconditional:
   * the caller (`StepUpService.confirmRestrictedPasskey`) has already verified
   * the fresh proof + the predates-the-reset check before calling this.
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
   * Delete a passkey credential and report whether a row actually existed to delete, via
   * `ReturnValues: 'ALL_OLD'` (DynamoDB returns the deleted item's attributes only when one was
   * present). Callers that gate a side effect on an ACTUAL removal — e.g. the factor-change notice,
   * which must not fire for a no-op delete of an unknown/already-removed credential) — need this
   * distinction; the endpoint itself stays idempotent (still `204` either
   * way).
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
   * The same credential delete as {@link remove}, as a `TransactWriteItems`
   * item for the factor-undo consume:
   * `UsersRepository.consumeFactorUndo` commits it in the SAME transaction
   * as the single-use token clear, so the credential can only be deleted
   * while the token that names it is still the active one. Unconditional on
   * the passkey row itself — a `Delete` of an already-absent row succeeds
   * (idempotent, like `remove`).
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
