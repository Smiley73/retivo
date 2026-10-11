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

/** One item of a `TransactWriteCommand`'s `TransactItems` array. */
type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

/**
 * The write-authority condition shared by the credential Put (change-password
 * commit) and the standalone ConditionCheck (envelope-write path):
 * `expectedRevision` must equal the row's stored `credentialRevision`, or the
 * row must carry none AND `expectedRevision` be the legacy sentinel.
 * A session that resolved to
 * `NO_SESSION_REVISION_SENTINEL` (dynamo/types.ts) can satisfy neither branch,
 * so the condition always fails for a session with no recorded authority.
 */
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
   * Strongly-consistent variant of {@link findByUserId}. `GET
   * /auth/key-envelopes` echoes this row's revision as `currentCredentialRevision` so the client
   * can decide whether a password-slot re-wrap is owed; an eventually-consistent replica read there
   * can still see the PRE-reset revision for a moment after a reset commits revision B elsewhere,
   * which would falsely read as "already reconciled" and suppress the repair. Only that read needs
   * the stronger (costlier) read; every other caller here keeps the cheaper default.
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
   * Build the credential-row `Put` transact item for the atomic
   * change-password commit, conditioned on the caller-supplied
   * `expectedRevision` — the session's recorded write authority — matching
   * the row's CURRENT revision at commit time. A superseded session (one
   * whose sign-in predates a credential rotation that has since landed) or a
   * session carrying no revision at all therefore fails this condition rather
   * than a preceding read, closing the read-then-write race in miniature.
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
   * Build a `ConditionCheck`-only transact item asserting the credential
   * row's CURRENT revision equals `expectedRevision`, without writing it.
   * Used on the ordinary password-slot
   * envelope-write path, where the credential row is not itself part of the
   * write — the same write-authority gate as {@link putTransactItem}, applied
   * as a condition of the slot's own commit.
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
