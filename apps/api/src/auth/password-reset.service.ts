// Self-service password reset: `request` is an opaque-202 no-op unless the account is eligible; `consume` rotates the credential
// under the single-use token. See docs/security.md, "Password change, password reset".
import { formatMailSource } from './mail-source.js';
import {
  BadRequestException,
  GoneException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { DYNAMO_DOC_CLIENT, SES_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import type { CredentialRow, PasswordResetRow, UserRow } from '../dynamo/types.js';
import { PasswordResetsRepository } from '../dynamo/password-resets.repository.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { CredentialsRepository } from '../dynamo/credentials.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { FailedLoginService } from './failed-login.service.js';
import { PasswordValidatorService } from './password-validator.service.js';
import { sha256 } from './refresh-token.service.js';
import { emailFingerprint } from '../common/email-fingerprint.js';
import { escapeHtml } from '../common/escape-html.js';
import { SessionRevocationService } from './session-revocation.service.js';

/**
 * Reset-link validity; exported so `factor-restriction.ts` bounds how long an unconsumed request keeps the post-reset
 * restriction window open.
 */
export const RESET_TTL_SEC = 15 * 60;
const RESET_COOLDOWN_SEC = 60;
const RESET_DAILY_LIMIT = 5;
// Constant minimum elapsed time for the request handler: early-return branches are far cheaper than a real send, so
// timing would be a user-existence oracle. A fixed floor (not jitter, which averages out) hides it.
const RESPONSE_TIME_FLOOR_MS = 200;

export interface RequestResetResult {
  /** Always set, so the response shape is identical for a hit and a no-op. */
  accepted: true;
  /** Dev and test only, and only on a real send. */
  resetToken?: string;
}

// Send plan for an eligible request: the fresh token, the PasswordReset row, and the User update pinned to the
// observed rate-limit state.
interface ResetSendPlan {
  newToken: string;
  resetRow: PasswordResetRow;
  userUpdate: ReturnType<UsersRepository['resetSendUpdate']>;
}

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly fromAddress: string;
  private readonly webOrigin: string;
  private readonly passwordResetTable: string;
  private readonly credentialTable: string;
  private readonly sesEnabled: boolean;
  private readonly returnResetToken: boolean;

  constructor(
    @Inject(DYNAMO_DOC_CLIENT) private readonly doc: DynamoDBDocumentClient,
    @Inject(SES_CLIENT) private readonly ses: SESClient,
    private readonly resets: PasswordResetsRepository,
    private readonly users: UsersRepository,
    private readonly credentials: CredentialsRepository,
    private readonly sessions: SessionRevocationService,
    private readonly auth: AuthEventsRepository,
    private readonly failed: FailedLoginService,
    private readonly passwords: PasswordValidatorService,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.fromAddress = config.get('SES_FROM_ADDRESS', { infer: true });
    this.webOrigin = config.get('WEB_ORIGIN', { infer: true });
    this.passwordResetTable = config.get('TABLE_PASSWORD_RESET', { infer: true });
    this.credentialTable = config.get('TABLE_CREDENTIAL', { infer: true });
    const node = config.get('NODE_ENV', { infer: true });
    // A local endpoint signals the emulator; otherwise production sends for real.
    this.sesEnabled = node === 'production' || !!config.get('SES_ENDPOINT', { infer: true });
    // Same dev trapdoor gate as signup: local development only, hard-refused at boot on a deployed stack. The raw
    // token is returned only on a real send, never on a no-op.
    this.returnResetToken =
      node !== 'production' ||
      config.get('EXPOSE_VERIFICATION_TOKEN', { infer: true }) === 'true';
  }

  /**
   * Attempts to issue a reset link. Always returns the same opaque shape: every branch skips silently, and only a
   * real send appends `password_reset_requested` and, in non-prod, the raw token. A minimum elapsed time holds every
   * branch to a real send timing.
   */
  async request(args: {
    email: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<RequestResetResult> {
    const startMs = Date.now();
    try {
      return await this.requestInner(args);
    } finally {
      await this.enforceResponseFloor(startMs);
    }
  }

  // Awaits the response-time floor from `startMs`; a fixed deadline, since jitter averages out and would still leak
  // timing.
  private async enforceResponseFloor(startMs: number): Promise<void> {
    const remainingMs = RESPONSE_TIME_FLOOR_MS - (Date.now() - startMs);
    if (remainingMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
    }
  }

  private async requestInner(args: {
    email: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<RequestResetResult> {
    const user = await this.users.findByEmail(args.email.toLowerCase());
    // Any miss is a silent no-op with the identical opaque shape.
    const plan = user ? this.planSend(user) : null;
    if (!plan) return { accepted: true };

    // A lost cooldown race aborts the transaction: the same opaque no-op 202.
    const committed = await this.commitSend(user!, plan);
    if (!committed) return { accepted: true };

    // Post-commit side effects of a real send: the mail is sent only after commit, so a failure never strands a
    // token the consume would honour.
    await this.afterSend(user!, plan.newToken, args.ip, args.userAgent);

    return {
      accepted: true,
      ...(this.returnResetToken ? { resetToken: plan.newToken } : {}),
    };
  }

  // Evaluates eligibility and the per-email cooldown and daily cap, returning the send plan (with the TOCTOU-pinned
  // User update) or null for every silent no-op.
  private planSend(user: UserRow): ResetSendPlan | null {
    if (!user.emailVerifiedAt) {
      // Unverified accounts use resend-verification. Silent.
      return null;
    }
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    if (user.lastResetSentAt) {
      const lastMs = Date.parse(user.lastResetSentAt);
      if (Number.isFinite(lastMs) && nowMs - lastMs < RESET_COOLDOWN_SEC * 1000) {
        return null; // Cooldown not elapsed. Silent.
      }
    }
    const dayKey = Math.floor(nowSec / 86400);
    const countToday = user.resetsSentDayKey === dayKey ? (user.resetsSentToday ?? 0) : 0;
    if (countToday >= RESET_DAILY_LIMIT) return null; // Daily cap hit. Silent.

    const newToken = randomBytes(32).toString('base64url');
    // Hash at the service boundary: only the SHA-256 hash is stored; the raw token rides the email link.
    const newTokenHash = sha256(newToken);
    const sentAtIso = new Date(nowMs).toISOString();
    const resetRow: PasswordResetRow = {
      resetToken: newTokenHash,
      userId: user.userId,
      email: user.email,
      createdAt: sentAtIso,
      expiresAt: nowSec + RESET_TTL_SEC,
    };
    const userUpdate = this.users.resetSendUpdate({
      userId: user.userId,
      newToken: newTokenHash,
      sentAtIso,
      dayKey,
      countToday: countToday + 1,
      // Pin the write to the rate-limit state read above, so a concurrent request cannot pass the same pre-check and
      // commit a second send (CODING_STANDARDS "Check-and-mutate requires a transaction").
      observed: {
        lastResetSentAt: user.lastResetSentAt,
        resetsSentDayKey: user.resetsSentDayKey,
        resetsSentToday: user.resetsSentToday,
      },
    });
    return { newToken, resetRow, userUpdate };
  }

  // Commits the single-valid-link transaction: Put the new PasswordReset row, conditionally Update the User counters,
  // and Delete the prior row, atomically, so a transient delete failure cannot strand a prior row the export cannot
  // reach. Returns false when a concurrent request won the cooldown window.
  private async commitSend(user: UserRow, plan: ResetSendPlan): Promise<boolean> {
    const { resetRow, userUpdate } = plan;
    const priorToken =
      user.currentResetToken && user.currentResetToken !== plan.newToken
        ? user.currentResetToken
        : null;
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: this.passwordResetTable, Item: resetRow } },
            {
              Update: {
                TableName: userUpdate.tableName,
                Key: userUpdate.key,
                UpdateExpression: userUpdate.update.UpdateExpression,
                ConditionExpression: userUpdate.update.ConditionExpression,
                ExpressionAttributeValues: userUpdate.update.ExpressionAttributeValues,
              },
            },
            ...(priorToken
              ? [
                  {
                    Delete: {
                      TableName: this.passwordResetTable,
                      Key: { resetToken: priorToken },
                    },
                  },
                ]
              : []),
          ],
        }),
      );
    } catch (err) {
      if (err instanceof TransactionCanceledException) return false;
      throw err;
    }
    return true;
  }

  // Post-commit side effects of a real send: the `password_reset_requested` audit and the SES mail (a failure is
  // logged, not raised).
  private async afterSend(
    user: UserRow,
    newToken: string,
    ip?: string | null,
    userAgent?: string | null,
  ): Promise<void> {
    // A real send is audited with a real, verified userId.
    await this.auth.record({
      userId: user.userId,
      eventType: 'password_reset_requested',
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });

    try {
      await this.sendResetMail(user.email, newToken);
    } catch (err) {
      this.logger.warn(
        {
          userId: user.userId,
          emailFingerprint: emailFingerprint(user.email),
          // Error class only, never `err.message`: an SES rejection embeds the recipient address.
          reason: err instanceof Error ? err.name : 'unknown',
        },
        'Password-reset mail dispatch failed',
      );
    }
  }

  /**
   * Consumes a reset token: rotates the credential and clears reset state in one transaction, then revokes sessions,
   * clears backoff, audits and notifies. 410 RESET_TOKEN_EXPIRED for an expired token, 400 RESET_TOKEN_INVALID for an
   * unknown, consumed or superseded one.
   */
  async consume(args: {
    token: string;
    newPassword: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    // The URL carries the raw token; hash once and use the hash for every DynamoDB key and the `currentResetToken
    // == :tok` condition.
    const tokenHash = sha256(args.token);

    // Validate the token and the new password against the policy before the transaction, so a policy failure leaves
    // the token consumable for a retry.
    const { row } = await this.loadValidResetRow(tokenHash);
    await this.passwords.validate(args.newPassword);

    const now = new Date().toISOString();
    await this.commitConsume(row, tokenHash, args.newPassword, now);

    await this.afterConsume(row, args.ip, args.userAgent);
  }

  // Looks up the PasswordReset row by token hash and enforces existence and expiry; best-effort cleanup of an expired
  // row.
  private async loadValidResetRow(
    tokenHash: string,
  ): Promise<{ row: PasswordResetRow; nowSec: number }> {
    const row = await this.resets.findByToken(tokenHash);
    if (!row) {
      throw new BadRequestException({
        code: 'RESET_TOKEN_INVALID',
        message: 'Password-reset link is invalid or already used.',
      });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (row.expiresAt < nowSec) {
      await this.resets.deleteToken(tokenHash);
      throw new GoneException({
        code: 'RESET_TOKEN_EXPIRED',
        message: 'Password-reset link has expired. Request a new one.',
      });
    }
    return { row, nowSec };
  }

  // The single-use consume transaction: conditional Delete of the PasswordReset row (a reused token fails), Put the new
  // credential, and clear the User reset state under `currentResetToken == :presentedToken` (a superseded token fails).
  // Either failure aborts it, so the password cannot rotate twice; the cancel surfaces as RESET_TOKEN_INVALID.
  private async commitConsume(
    row: PasswordResetRow,
    tokenHash: string,
    newPassword: string,
    now: string,
  ): Promise<void> {
    const newHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    const credential: CredentialRow = {
      userId: row.userId,
      argon2Hash: newHash,
      updatedAt: now,
      // A fresh opaque revision: every credential write mints one.
      credentialRevision: randomUUID(),
    };
    const userUpdate = this.users.resetConsumeUpdate({
      userId: row.userId,
      presentedToken: tokenHash,
      // The consumed row own request instant; the `currentResetToken` condition guarantees it is the active reset, so
      // it pairs correctly with the completion even if a newer request later overwrites
      // `passwordResetRequestOpenedAt`.
      requestedAt: row.createdAt,
      now,
    });
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.passwordResetTable,
                Key: { resetToken: tokenHash },
                ConditionExpression: 'attribute_exists(resetToken)',
              },
            },
            { Put: { TableName: this.credentialTable, Item: credential } },
            {
              Update: {
                TableName: userUpdate.tableName,
                Key: userUpdate.key,
                UpdateExpression: userUpdate.update.UpdateExpression,
                ConditionExpression: userUpdate.update.ConditionExpression,
                ExpressionAttributeValues: userUpdate.update.ExpressionAttributeValues,
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        throw new BadRequestException({
          code: 'RESET_TOKEN_INVALID',
          message: 'Password-reset link is invalid or already used.',
        });
      }
      throw err;
    }
  }

  // Post-commit work (it can exceed the 100-item transaction limit): revoke all sessions, clear the failed-login
  // backoff, audit `password_reset`, and send a best-effort completion notice.
  private async afterConsume(
    row: PasswordResetRow,
    ip?: string | null,
    userAgent?: string | null,
  ): Promise<void> {
    await this.sessions.revokeAll({ userId: row.userId });
    await this.failed.clear(row.email.toLowerCase());

    await this.auth.record({
      userId: row.userId,
      eventType: 'password_reset',
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });

    try {
      await this.sendCompletionMail(row.email);
    } catch (err) {
      this.logger.warn(
        {
          userId: row.userId,
          emailFingerprint: emailFingerprint(row.email),
          // Error class only, never `err.message`: an SES rejection embeds the recipient address.
          reason: err instanceof Error ? err.name : 'unknown',
        },
        'Password-reset completion mail dispatch failed',
      );
    }
  }

  private async sendResetMail(toAddress: string, token: string): Promise<void> {
    if (!this.sesEnabled) {
      // Local dev: log only a non-reversible email fingerprint, never the token-bearing link or recipient
      // (CODING_STANDARDS "Never log secrets, tokens, or PII"); the dev shortcut is the `returnResetToken` response.
      this.logger.log(
        { emailFingerprint: emailFingerprint(toAddress) },
        'Password-reset link generated (local dev — token in API response)',
      );
      return;
    }
    // URL fragment, so the token never reaches the server, access logs or Referer.
    const link = `${this.webOrigin}/auth/reset-password#token=${encodeURIComponent(token)}`;
    await this.ses.send(
      new SendEmailCommand({
        Source: formatMailSource(this.fromAddress),
        Destination: { ToAddresses: [toAddress] },
        Message: {
          Subject: { Data: 'Reset your password' },
          Body: {
            Text: {
              Data:
                `Someone requested a password reset for your account. ` +
                `Set a new password using the link below (valid for 15 minutes):\n\n${link}\n\n` +
                `After resetting, you'll need your saved recovery key (or an ` +
                `enrolled passkey) to unlock your encrypted data — a password ` +
                `reset restores sign-in, not data access.\n\n` +
                `If you didn't request this, you can ignore this message; your ` +
                `password has not changed.`,
            },
            Html: {
              Data:
                `<p>Someone requested a password reset for your account. ` +
                `Set a new password using the link below (valid for 15 minutes):</p>` +
                `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` +
                `<p>After resetting, you'll need your saved recovery key (or an ` +
                `enrolled passkey) to unlock your encrypted data — a password ` +
                `reset restores sign-in, not data access.</p>` +
                `<p>If you didn't request this, you can ignore this message; your ` +
                `password has not changed.</p>`,
            },
          },
        },
      }),
    );
  }

  private async sendCompletionMail(toAddress: string): Promise<void> {
    if (!this.sesEnabled) {
      // Local dev: log only a non-reversible email fingerprint (CODING_STANDARDS "Never log secrets, tokens, or
      // PII").
      this.logger.log(
        { emailFingerprint: emailFingerprint(toAddress) },
        'Password-reset completion notice generated (local dev)',
      );
      return;
    }
    await this.ses.send(
      new SendEmailCommand({
        Source: formatMailSource(this.fromAddress),
        Destination: { ToAddresses: [toAddress] },
        Message: {
          Subject: { Data: 'Your password was changed' },
          Body: {
            Text: {
              Data:
                `Your account password was just changed via a password reset. ` +
                `If this was you, no action is needed.\n\n` +
                `If this wasn't you, request another reset right away to lock ` +
                `out whoever has access, and review your saved recovery key.`,
            },
            Html: {
              Data:
                `<p>Your account password was just changed via a password reset. ` +
                `If this was you, no action is needed.</p>` +
                `<p>If this wasn't you, request another reset right away to lock ` +
                `out whoever has access, and review your saved recovery key.</p>`,
            },
          },
        },
      }),
    );
  }
}
