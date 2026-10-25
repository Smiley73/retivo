// Sends and verifies emailed 6-digit MFA codes: per-email cooldown (60 s) and daily cap (5) on the User row, a 200 ms response
// floor, hash-at-rest, a 5-attempt cap. See docs/security.md, "The second factor".
import { formatMailSource } from './mail-source.js';
import {
  GoneException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { randomInt } from 'node:crypto';
import { DYNAMO_DOC_CLIENT, SES_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import type { MfaEmailOtpRow, UserRow } from '../dynamo/types.js';
import { MfaEmailOtpRepository, stepUpOtpPk } from '../dynamo/mfa-email-otp.repository.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { sha256 } from './refresh-token.service.js';
import { emailFingerprint } from '../common/email-fingerprint.js';
import { escapeHtml } from '../common/escape-html.js';

// Code validity window: 10 minutes.
const MFA_EMAIL_OTP_TTL_SEC = 10 * 60;
const MFA_EMAIL_OTP_COOLDOWN_SEC = 60;
const MFA_EMAIL_OTP_DAILY_LIMIT = 5;
const MFA_EMAIL_OTP_MAX_ATTEMPTS = 5;
// Constant minimum elapsed time for the send handler, so a cooldown or cap no-op is not a timing oracle.
const MFA_EMAIL_OTP_RESPONSE_FLOOR_MS = 200;

interface EmailOtpSendPlan {
  rawCode: string;
  otpRow: MfaEmailOtpRow;
  userUpdate: ReturnType<UsersRepository['mfaEmailOtpSendUpdate']>;
}

// Live-expiry guard: true only for a finite number strictly in the future, so a pre-cutover ISO-string row reads as
// expired and forces a fresh code.
function isLiveEpochSeconds(expiresAt: unknown, nowMs = Date.now()): boolean {
  return (
    typeof expiresAt === 'number' &&
    Number.isFinite(expiresAt) &&
    expiresAt * 1000 > nowMs
  );
}

@Injectable()
export class MfaEmailOtpService {
  private readonly logger = new Logger(MfaEmailOtpService.name);
  private readonly fromAddress: string;
  private readonly sesEnabled: boolean;

  constructor(
    @Inject(DYNAMO_DOC_CLIENT) private readonly doc: DynamoDBDocumentClient,
    @Inject(SES_CLIENT) private readonly ses: SESClient,
    private readonly otps: MfaEmailOtpRepository,
    private readonly users: UsersRepository,
    private readonly auth: AuthEventsRepository,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.fromAddress = config.get('SES_FROM_ADDRESS', { infer: true });
    const node = config.get('NODE_ENV', { infer: true });
    this.sesEnabled =
      node === 'production' || !!config.get('SES_ENDPOINT', { infer: true });
  }

  /**
   * Sends a fresh code (best effort) with 202-shaped semantics that never reveal whether a code exists or the
   * cooldown or cap blocked it. The user is already password-authenticated, so this is no enumeration oracle; the
   * floor defends against a within-account timing probe of the rate-limit state.
   */
  async send(args: {
    userId: string;
    email: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    const startMs = Date.now();
    try {
      await this.sendInner(args);
    } finally {
      await this.enforceResponseFloor(startMs);
    }
  }

  private async enforceResponseFloor(startMs: number): Promise<void> {
    const remainingMs =
      MFA_EMAIL_OTP_RESPONSE_FLOOR_MS - (Date.now() - startMs);
    if (remainingMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
    }
  }

  private async sendInner(args: {
    userId: string;
    email: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    const user = await this.users.findById(args.userId);
    const plan = user ? this.planSend(user) : null;
    if (!plan || !user) return;

    const committed = await this.commitSend(plan);
    if (!committed) return;

    await this.afterSend(args.email, plan.rawCode, args.userId, args.ip, args.userAgent);
  }

  // Evaluates the cooldown and daily cap and, when permitted, builds the send plan: a fresh code, the hashed row to
  // Put, and the User update pinned to the observed rate-limit state. Null on every blocked branch.
  private planSend(user: UserRow): EmailOtpSendPlan | null {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    if (user.mfaEmailOtpLastSentAt) {
      const lastMs = Date.parse(user.mfaEmailOtpLastSentAt);
      if (
        Number.isFinite(lastMs) &&
        nowMs - lastMs < MFA_EMAIL_OTP_COOLDOWN_SEC * 1000
      ) {
        return null; // Cooldown not elapsed.
      }
    }
    const dayKey = Math.floor(nowSec / 86400);
    const countToday =
      user.mfaEmailOtpSentDayKey === dayKey
        ? (user.mfaEmailOtpSentToday ?? 0)
        : 0;
    if (countToday >= MFA_EMAIL_OTP_DAILY_LIMIT) return null; // Daily cap.

    const rawCode = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const sentAtIso = new Date(nowMs).toISOString();
    const otpRow: MfaEmailOtpRow = {
      userId: user.userId,
      codeHash: sha256(rawCode),
      expiresAt: Math.floor(nowMs / 1000) + MFA_EMAIL_OTP_TTL_SEC,
      sentAt: sentAtIso,
      attempts: 0,
    };
    const userUpdate = this.users.mfaEmailOtpSendUpdate({
      userId: user.userId,
      sentAtIso,
      dayKey,
      countToday: countToday + 1,
      observed: {
        mfaEmailOtpLastSentAt: user.mfaEmailOtpLastSentAt,
        mfaEmailOtpSentDayKey: user.mfaEmailOtpSentDayKey,
        mfaEmailOtpSentToday: user.mfaEmailOtpSentToday,
      },
    });
    return { rawCode, otpRow, userUpdate };
  }

  // The conditional User-counter update first (a lost cooldown race aborts here), then the code Put. Deliberately not
  // one cross-table transaction: a simplicity choice matching `PasswordResetService`, not an IAM limit, since a
  // transaction is authorized by the per-item actions already granted. The real boundary is the point-ops action set
  // (no Query or Scan) plus api-role-only access to these secret tables.
  private async commitSend(plan: EmailOtpSendPlan): Promise<boolean> {
    const { userUpdate, otpRow } = plan;
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: userUpdate.TableName,
          Key: userUpdate.Key,
          UpdateExpression: userUpdate.UpdateExpression,
          ConditionExpression: userUpdate.ConditionExpression,
          ExpressionAttributeValues: userUpdate.ExpressionAttributeValues,
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
    // Counter advanced: persist the live code, replacing any prior row.
    await this.otps.put(otpRow);
    return true;
  }

  private async afterSend(
    email: string,
    rawCode: string,
    userId: string,
    ip?: string | null,
    userAgent?: string | null,
  ): Promise<void> {
    await this.auth.record({
      userId,
      eventType: 'mfa_email_otp_sent',
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    try {
      await this.sendCodeMail(email, rawCode);
    } catch (err) {
      this.logger.warn(
        {
          userId,
          emailFingerprint: emailFingerprint(email),
          // Error class only, never `err.message`: an SES rejection embeds the recipient address, which `redact` cannot
          // scrub inside a string.
          reason: err instanceof Error ? err.name : 'unknown',
        },
        'MFA Email-OTP mail dispatch failed',
      );
    }
  }

  /**
   * Verifies a presented code. `{ ok: true }` consumes it; `{ ok: false }` on a wrong guess increments the attempt
   * counter. Throws MFA_CODE_EXPIRED (410) when the TTL elapsed (best-effort delete) and MFA_CODE_INVALID (401) when
   * no live code exists or after the 5th wrong guess (row deleted, forcing a resend). The code is hashed at this
   * boundary.
   */
  async verify(args: {
    userId: string;
    code: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<{ ok: boolean }> {
    const row = await this.otps.get(args.userId);
    if (!row) throw this.invalid();

    // A nonnumeric legacy ISO or elapsed expiry is rejected: the pre-cutover code is invalidated.
    if (!isLiveEpochSeconds(row.expiresAt)) {
      await this.throwExpired(() => this.otps.delete(args.userId), args.userId);
    }

    if (sha256(args.code) === row.codeHash) {
      await this.otps.delete(args.userId);
      await this.auth.record({
        userId: args.userId,
        eventType: 'mfa_email_otp_verified',
        ip: args.ip ?? null,
        userAgent: args.userAgent ?? null,
      });
      return { ok: true };
    }

    // Increment conditioned on the row still being the one read, so a concurrent resend is not clobbered.
    let attempts: number;
    try {
      attempts = await this.otps.incrementAttempts(args.userId, row.sentAt);
    } catch (err) {
      // Row gone or replaced (a concurrent resend): invalid. Rethrow anything else.
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      throw this.invalid();
    }
    await this.auth.record({
      userId: args.userId,
      eventType: 'mfa_email_otp_failed',
      ip: args.ip ?? null,
      userAgent: args.userAgent ?? null,
    });
    // Incident-context warn only; the MfaVerifyFailed metric comes from AuthEventsRepository off the audit event.
    // Never log the code.
    this.logger.warn('MFA verification failed', {
      userId: args.userId,
      factor: 'email_otp',
    });
    if (attempts >= MFA_EMAIL_OTP_MAX_ATTEMPTS) {
      // Hard cap hit: invalidate the code and force a resend.
      await this.otps.delete(args.userId);
      throw this.invalid();
    }
    return { ok: false };
  }

  /**
   * Sends a fresh step-up code bound to `purpose`, on the namespaced `<userId>#stepup` row and the separate step-up
   * budget on the User row, so login and step-up allowances never drain each other. Concurrent different-purpose
   * sends overwrite the single row. Returns `{ committed }`, true only when a code row was persisted, so the caller
   * records `step_up_challenge` only for a challenge that was minted.
   */
  async sendStepUp(args: {
    userId: string;
    email: string;
    purpose: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<{ committed: boolean }> {
    const startMs = Date.now();
    let committed = false;
    try {
      const user = await this.users.findById(args.userId);
      const plan = user ? this.planStepUpSend(user, args.purpose) : null;
      if (plan) {
        committed = await this.commitStepUpSend(plan);
        if (committed) {
          await this.afterSend(args.email, plan.rawCode, args.userId, args.ip, args.userAgent);
        }
      }
    } finally {
      await this.enforceResponseFloor(startMs);
    }
    return { committed };
  }

  private planStepUpSend(user: UserRow, purpose: string): EmailOtpSendPlan | null {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    if (user.stepUpEmailOtpLastSentAt) {
      const lastMs = Date.parse(user.stepUpEmailOtpLastSentAt);
      if (
        Number.isFinite(lastMs) &&
        nowMs - lastMs < MFA_EMAIL_OTP_COOLDOWN_SEC * 1000
      ) {
        return null; // Cooldown not elapsed.
      }
    }
    const dayKey = Math.floor(nowSec / 86400);
    const countToday =
      user.stepUpEmailOtpSentDayKey === dayKey
        ? (user.stepUpEmailOtpSentToday ?? 0)
        : 0;
    if (countToday >= MFA_EMAIL_OTP_DAILY_LIMIT) return null; // Daily cap.

    const rawCode = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const sentAtIso = new Date(nowMs).toISOString();
    const otpRow: MfaEmailOtpRow = {
      userId: stepUpOtpPk(user.userId),
      codeHash: sha256(rawCode),
      expiresAt: Math.floor(nowMs / 1000) + MFA_EMAIL_OTP_TTL_SEC,
      sentAt: sentAtIso,
      attempts: 0,
      purpose,
    };
    const userUpdate = this.users.stepUpMfaEmailOtpSendUpdate({
      userId: user.userId,
      sentAtIso,
      dayKey,
      countToday: countToday + 1,
      observed: {
        stepUpEmailOtpLastSentAt: user.stepUpEmailOtpLastSentAt,
        stepUpEmailOtpSentDayKey: user.stepUpEmailOtpSentDayKey,
        stepUpEmailOtpSentToday: user.stepUpEmailOtpSentToday,
      },
    });
    return { rawCode, otpRow, userUpdate };
  }

  private async commitStepUpSend(plan: EmailOtpSendPlan): Promise<boolean> {
    const { userUpdate, otpRow } = plan;
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: userUpdate.TableName,
          Key: userUpdate.Key,
          UpdateExpression: userUpdate.UpdateExpression,
          ConditionExpression: userUpdate.ConditionExpression,
          ExpressionAttributeValues: userUpdate.ExpressionAttributeValues,
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
    await this.otps.putStepUp(otpRow);
    return true;
  }

  /**
   * Verifies a step-up code bound to `purpose`. As `verify` on the namespaced row, plus a per-operation binding: a
   * right code for another purpose counts as a wrong guess, so a code cannot authorize a different operation.
   */
  async verifyStepUp(args: {
    userId: string;
    code: string;
    purpose: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<{ ok: boolean }> {
    const row = await this.otps.getStepUp(args.userId);
    if (!row) throw this.invalid();

    // A nonnumeric legacy ISO or elapsed expiry is rejected: the pre-cutover code is invalidated.
    if (!isLiveEpochSeconds(row.expiresAt)) {
      await this.throwExpired(
        () => this.otps.deleteStepUp(args.userId),
        args.userId,
      );
    }

    // A right code for the wrong operation is a wrong guess and is never consumed.
    const rightPurpose = row.purpose === args.purpose;
    if (rightPurpose && sha256(args.code) === row.codeHash) {
      await this.otps.deleteStepUp(args.userId);
      await this.auth.record({
        userId: args.userId,
        eventType: 'mfa_email_otp_verified',
        ip: args.ip ?? null,
        userAgent: args.userAgent ?? null,
      });
      return { ok: true };
    }

    let attempts: number;
    try {
      attempts = await this.otps.incrementAttemptsStepUp(args.userId, row.sentAt);
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      throw this.invalid();
    }
    await this.auth.record({
      userId: args.userId,
      eventType: 'mfa_email_otp_failed',
      ip: args.ip ?? null,
      userAgent: args.userAgent ?? null,
    });
    this.logger.warn('MFA verification failed', {
      userId: args.userId,
      factor: 'email_otp',
    });
    if (attempts >= MFA_EMAIL_OTP_MAX_ATTEMPTS) {
      await this.otps.deleteStepUp(args.userId);
      throw this.invalid();
    }
    return { ok: false };
  }

  // Shared expired path: best-effort delete of the stale row via the caller `del`, then throw MFA_CODE_EXPIRED.
  private async throwExpired(
    del: () => Promise<void>,
    userId: string,
  ): Promise<never> {
    await this.bestEffortDeleteExpired(del, userId);
    throw new GoneException({
      code: 'MFA_CODE_EXPIRED',
      message: 'The code has expired. Request a new one.',
    });
  }

  // Best-effort hygiene delete: a transient fault must never block the MFA_CODE_EXPIRED fallback. Never logs the code.
  private async bestEffortDeleteExpired(
    del: () => Promise<void>,
    userId: string,
  ): Promise<void> {
    try {
      await del();
    } catch (err) {
      this.logger.warn('Best-effort expired MFA code delete failed', {
        userId,
        reason: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  private invalid(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'MFA_CODE_INVALID',
      message: 'The code is incorrect or no longer valid.',
    });
  }

  private async sendCodeMail(toAddress: string, code: string): Promise<void> {
    if (!this.sesEnabled) {
      // Local dev: never log the raw code or recipient (CODING_STANDARDS "Never log secrets, tokens, or PII").
      this.logger.log(
        { emailFingerprint: emailFingerprint(toAddress) },
        'MFA Email-OTP code generated (local dev — not logged)',
      );
      return;
    }
    await this.ses.send(
      new SendEmailCommand({
        Source: formatMailSource(this.fromAddress),
        Destination: { ToAddresses: [toAddress] },
        Message: {
          Subject: { Data: 'Your sign-in code' },
          Body: {
            Text: {
              Data:
                `Your sign-in verification code is ${code}. ` +
                `It expires in 10 minutes.\n\n` +
                `If you didn't try to sign in, someone may have your password — ` +
                `change it right away.`,
            },
            Html: {
              Data:
                `<p>Your sign-in verification code is <strong>${escapeHtml(code)}</strong>. ` +
                `It expires in 10 minutes.</p>` +
                `<p>If you didn't try to sign in, someone may have your password — ` +
                `change it right away.</p>`,
            },
          },
        },
      }),
    );
  }
}
