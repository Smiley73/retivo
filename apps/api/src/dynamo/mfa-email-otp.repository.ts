/**
 * Repository for the `MfaEmailOtp` table (PK `userId`, TTL on `expiresAt` ~10 min) — the live
 * Email-OTP code hash for a user. Holds only the SHA-256 code hash + attempt counter; the daily-cap
 * + cooldown counters live on the `User` row (see UserRow) so the cap survives this table's short
 * TTL.
 *
 * Point-ops only (the api-role grant on this table is Get/Put/Update/Delete —
 * no Query, no Scan): every access is keyed by `userId`. The raw code is
 * NEVER stored or logged.
 */
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

/**
 * PK-value suffix for a step-up Email-OTP code row. The step-up code lives at `<userId>#stepup`, a
 * distinct row from the login / change-email `<userId>` code so a step-up send never clobbers (or
 * is clobbered by) the login code, and vice versa. Same single-attribute PK — a namespaced VALUE
 * only, no key-schema change.
 */
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
   * Atomically increment the wrong-attempt counter for the live code,
   * conditional on the row still being the one the caller read (`sentAt`
   * pin) so a concurrent resend's fresh row is never clobbered. Returns the
   * post-increment `attempts` value. Throws the AWS SDK
   * `ConditionalCheckFailedException` when the row is gone or was replaced (the
   * caller treats that as "code no longer valid").
   *
   * The per-code hard cap (5 wrong → invalidate + force resend) is enforced by
   * the service: it increments here, and when the returned count reaches the
   * cap it deletes the row.
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
   * Keyed delete — drops the live code (after a successful verify, on a
   * resend, on the per-code attempt-cap invalidation, or via the
   * account-deletion cascade).
   */
  async delete(userId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { userId } }),
    );
  }

  // ---------- Step-up code row ----------
  // The step-up code lives at `<userId>#stepup` and carries a `purpose`; these
  // helpers mirror the login-code point-ops on the namespaced key so the two
  // rows never collide. `userId` args are the bare user id; the suffix is
  // applied here.

  /** The user's live step-up Email-OTP row, or null if none is outstanding. */
  async getStepUp(userId: string): Promise<MfaEmailOtpRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { userId: stepUpOtpPk(userId) } }),
    );
    return (r.Item as MfaEmailOtpRow | undefined) ?? null;
  }

  /**
   * Put (create or replace) the live step-up Email-OTP row. `row.userId` MUST
   * already be the namespaced value (built via {@link stepUpOtpPk}).
   */
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
