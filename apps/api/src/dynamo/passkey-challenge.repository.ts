/**
 * Repository for the `PasskeyChallenge` table. One row per in-flight WebAuthn ceremony,
 * PK `key` (the caller's own
 * namespaced string — see `PasskeyChallengeRow` / `PasskeyChallengeStore`).
 *
 * `issue` overwrites — a caller starting the same ceremony twice (a stable
 * per-ceremony key, e.g. `reg:<userId>`) is expected, and the second issue
 * simply replaces the first.
 *
 * `consume` is the single-use primitive: ONE atomic conditional `DeleteItem`
 * returning the prior image (`ConditionExpression: attribute_exists(#k)` +
 * `ReturnValues: 'ALL_OLD'`). Of two concurrent consumes, exactly one
 * observes the row and gets it back; the other's condition fails against
 * the now-empty item and throws `ConditionalCheckFailedException`, mapped
 * here to `null` — the same won/lost discrimination
 * `RevokedTokensRepository.consumeMfaChallenge` uses, applied to a delete
 * instead of a create. The `ConditionExpression` is load-bearing, not
 * decorative: an unconditional `DeleteItem` with only `ReturnValues: ALL_OLD`
 * returns the prior image correctly for a SEQUENTIAL replay, but DynamoDB
 * Local has been observed handing the prior image back to BOTH sides of a
 * genuinely concurrent unconditional delete on the same item once its
 * connections are warm — a real emulator gap the condition closes (real
 * DynamoDB's own docs make no such unconditional-delete-is-exclusive
 * guarantee either). A read-then-delete pair would reopen the race this
 * repository exists to close, so there is deliberately no `get`.
 *
 * Point-ops only (the api-role grant on this table is Put/Delete — no Get,
 * no Update, no Query, no Scan, no BatchWriteItem): every access is keyed by
 * `key`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import type { PasskeyChallengeRow } from './types.js';

@Injectable()
export class PasskeyChallengeRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_PASSKEY_CHALLENGE');
  }

  /** Issue (create or replace) the challenge row for `row.key`. Overwrites — see class doc. */
  async issue(row: PasskeyChallengeRow): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: row }));
  }

  /**
   * Single-use atomic consume: one conditional `DeleteItem` returning the
   * prior image. Returns `null` when the key never existed, was already
   * consumed, or (a concurrent loser) lost the conditional write to another
   * caller — distinguished from a real error the same way
   * `consumeMfaChallenge` does, by catching the named exception rather than
   * letting it escape.
   */
  async consume(key: string): Promise<PasskeyChallengeRow | null> {
    try {
      const r = await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { key },
          ConditionExpression: 'attribute_exists(#k)',
          ExpressionAttributeNames: { '#k': 'key' },
          ReturnValues: 'ALL_OLD',
        }),
      );
      return (r.Attributes as PasskeyChallengeRow | undefined) ?? null;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return null;
      throw err;
    }
  }
}
