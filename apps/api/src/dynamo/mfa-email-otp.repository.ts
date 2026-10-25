// Repository for the MfaEmailOtp table (PK userId, TTL ~10 min): the live Email-OTP code hash and attempt counter. Point-ops only;
// the cap counters live on the User row; the raw code is never stored or logged.
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import type { MfaEmailOtpRow } from './types.js';

// PK suffix for a step-up code row (`<userId>#stepup`), distinct from the login code so neither clobbers the other.
const STEP_UP_OTP_PK_SUFFIX = '#stepup';

/** Namespaced PK value for a user's step-up Email-OTP code row. */
export function stepUpOtpPk(userId: string): string {
  return `${userId}${STEP_UP_OTP_PK_SUFFIX}`;
}

@Injectable()
export class MfaEmailOtpRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_MFA_EMAIL_OTP');
  }

  /** The user's live Email-OTP row, or null if none is outstanding. */
  async get(userId: string): Promise<MfaEmailOtpRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { userId } }),
    );
    return (r.Item as MfaEmailOtpRow | undefined) ?? null;
  }

  /** Put (create or replace) the live Email-OTP row. */
  async put(row: MfaEmailOtpRow): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: row }),
    );
  }

  /**
   * Atomically increments the wrong-attempt counter, pinned on `sentAt` so a concurrent resend fresh row is never
   * clobbered; returns the new count. Throws ConditionalCheckFailedException when the row is gone or replaced (the
   * code is no longer valid). The service enforces the 5-attempt cap by deleting the row.
   */
  async incrementAttempts(userId: string, sentAt: string): Promise<number> {
    const r = await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId },
        UpdateExpression: 'SET attempts = attempts + :one',
        ConditionExpression: 'attribute_exists(userId) AND sentAt = :sentAt',
        ExpressionAttributeValues: { ':one': 1, ':sentAt': sentAt },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return (r.Attributes?.attempts as number | undefined) ?? 0;
  }

  /**
   * Keyed delete of the live code (after verify, on resend, on the attempt cap, or in the account-deletion cascade).
   */
  async delete(userId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { userId } }),
    );
  }

  // ---------- Step-up code row ----------
  // Point-ops on the namespaced `<userId>#stepup` key; the callers pass the bare user id and the suffix is applied
  // here.

  /** The user's live step-up Email-OTP row, or null if none is outstanding. */
  async getStepUp(userId: string): Promise<MfaEmailOtpRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { userId: stepUpOtpPk(userId) } }),
    );
    return (r.Item as MfaEmailOtpRow | undefined) ?? null;
  }

  /** Puts the step-up row; `row.userId` must already be namespaced via `stepUpOtpPk`. */
  async putStepUp(row: MfaEmailOtpRow): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: row }),
    );
  }

  /** Increment the step-up code's wrong-attempt counter — see {@link incrementAttempts}. */
  async incrementAttemptsStepUp(userId: string, sentAt: string): Promise<number> {
    const r = await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId: stepUpOtpPk(userId) },
        UpdateExpression: 'SET attempts = attempts + :one',
        ConditionExpression: 'attribute_exists(userId) AND sentAt = :sentAt',
        ExpressionAttributeValues: { ':one': 1, ':sentAt': sentAt },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return (r.Attributes?.attempts as number | undefined) ?? 0;
  }

  /** Keyed delete of the step-up code row (verify success / resend / cap / cascade). */
  async deleteStepUp(userId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { userId: stepUpOtpPk(userId) } }),
    );
  }
}
