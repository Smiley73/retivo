// EmailReservation row access. Uniqueness is enforced by signup.service.ts via TransactWriteItems; this repo exposes the deletion
// path for DeleteAccountService.
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

  /** Point read by PK, to reach a user own reservation rows: the live `emailLowercase` and any pending change. */
  async findByEmail(emailLowercase: string): Promise<EmailReservationRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { emailLowercase } }),
    );
    return (r.Item as EmailReservationRow | undefined) ?? null;
  }
}
