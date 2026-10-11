/**
 * `EmailReservation` row access. Email uniqueness is enforced by
 * `signup.service.ts` via `TransactWriteItems` (DynamoDB does not
 * support GSI conditional writes); this repo exposes the deletion
 * path used by `DeleteAccountService` so an account can be fully
 * purged including the email lock row.
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
import type { EmailReservationRow } from './types.js';

@Injectable()
export class EmailReservationsRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_EMAIL_RESERVATION');
  }

  async delete(emailLowercase: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { emailLowercase },
      }),
    );
  }

  /**
   * Point read by the table's PK. Used to reach a
   * user's own reservation row(s) — the live `emailLowercase` and, when
   * present, the `pendingEmailLowercase` of an in-flight email change.
   */
  async findByEmail(emailLowercase: string): Promise<EmailReservationRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { emailLowercase } }),
    );
    return (r.Item as EmailReservationRow | undefined) ?? null;
  }
}
