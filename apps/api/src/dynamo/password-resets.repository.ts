// Repository for the PasswordReset table (PK resetToken, 15-min TTL): lookup and keyed delete. The single-use consume is a
// conditional delete in PasswordResetService transaction, and no Scan path exists here.
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
   * Looks up a reset row by PK; the caller passes the SHA-256 hash of the raw token, and this repo performs no
   * hashing.
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
   * Best-effort keyed delete of a superseded or dangling reset row; the consume path deletes conditionally in its own
   * transaction instead.
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
