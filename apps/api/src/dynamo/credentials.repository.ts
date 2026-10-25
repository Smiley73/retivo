import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import { LEGACY_CREDENTIAL_REVISION, type CredentialRow } from './types.js';

type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

// Write-authority condition shared by the credential Put and the standalone ConditionCheck: `expectedRevision` must
// equal the stored `credentialRevision`, or the row carries none and `expectedRevision` is the legacy sentinel.
// NO_SESSION_REVISION_SENTINEL satisfies neither, so a session with no recorded authority always fails.
const REVISION_CONDITION_EXPRESSION =
  '(attribute_exists(credentialRevision) AND credentialRevision = :expectedRevision) OR ' +
  '(attribute_not_exists(credentialRevision) AND :expectedRevision = :legacyRevision)';

@Injectable()
export class CredentialsRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_CREDENTIAL');
  }

  async findByUserId(userId: string): Promise<CredentialRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { userId } }),
    );
    return (r.Item as CredentialRow | undefined) ?? null;
  }

  /**
   * Strongly consistent `findByUserId`. `GET /auth/key-envelopes` echoes the revision so the client knows whether a
   * re-wrap is owed, and a stale replica could show the pre-reset revision and falsely suppress the repair.
   */
  async findByUserIdConsistent(userId: string): Promise<CredentialRow | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { userId },
        ConsistentRead: true,
      }),
    );
    return (r.Item as CredentialRow | undefined) ?? null;
  }

  async upsert(row: CredentialRow): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: row }),
    );
  }

  async deleteByUserId(userId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { userId } }),
    );
  }

  /**
   * Builds the credential-row Put for the change-password commit, conditioned on `expectedRevision` (the session
   * recorded write authority) matching the current revision, so a superseded session fails the commit rather than a
   * preceding read.
   */
  putTransactItem(row: CredentialRow, expectedRevision: string): TransactItem {
    return {
      Put: {
        TableName: this.tableName,
        Item: row,
        ConditionExpression: REVISION_CONDITION_EXPRESSION,
        ExpressionAttributeValues: {
          ':expectedRevision': expectedRevision,
          ':legacyRevision': LEGACY_CREDENTIAL_REVISION,
        },
      },
    };
  }

  /**
   * Builds a ConditionCheck-only item asserting the current revision equals `expectedRevision`: the same
   * write-authority gate as `putTransactItem`, for the password-slot envelope write where the credential row is not
   * itself written.
   */
  conditionCheckRevisionTransactItem(
    userId: string,
    expectedRevision: string,
  ): TransactItem {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: { userId },
        ConditionExpression: REVISION_CONDITION_EXPRESSION,
        ExpressionAttributeValues: {
          ':expectedRevision': expectedRevision,
          ':legacyRevision': LEGACY_CREDENTIAL_REVISION,
        },
      },
    };
  }
}
