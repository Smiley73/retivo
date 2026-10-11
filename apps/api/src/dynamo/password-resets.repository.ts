/**
 * Repository for the PasswordReset table (PK `resetToken`, 15-min TTL).
 * Mirrors EmailVerificationsRepository: a token lookup + a keyed delete.
 *
 * The single-use consume runs as one `TransactWriteItems` driven from
 * PasswordResetService, so the conditional delete lives there, not
 * here. The account-deletion cascade deletes the user's row by the
 * `User.currentResetToken` handle — a single keyed delete, no Scan —
 * so this repo deliberately exposes no `deleteAllForUser`/Scan path and
 * the api role needs no Scan grant on this table.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import type { PasswordResetRow } from './types.js';

@Injectable()
export class PasswordResetsRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_PASSWORD_RESET');
  }

  /**
   * Look up a reset row by its PK. The caller passes the SHA-256 hash of the
   * raw token, not the raw token: the table stores the hash (hashed
   * at the service boundary). This repo performs no hashing.
   */
  async findByToken(token: string): Promise<PasswordResetRow | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { resetToken: token },
      }),
    );
    return (r.Item as PasswordResetRow | undefined) ?? null;
  }

  /**
   * Best-effort keyed delete by token. Used to drop a now-superseded
   * prior reset row on re-request and to sweep the user's dangling row on
   * account deletion. The consume path deletes conditionally inside
   * its own transaction instead. Caller passes the stored SHA-256 hash, not
   * the raw token.
   */
  async deleteToken(token: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { resetToken: token },
      }),
    );
  }
}
