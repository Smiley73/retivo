/**
 * Self-service password reset. Two responsibilities, mirroring the
 * email-verification + resend posture:
 *
 *   - `request`: opaque-202 anti-enumeration. Only an existing, verified
 *     account that is past the per-email cooldown and under the daily cap
 *     gets a fresh single-use token mailed as a URL-fragment link. Unknown
 *     / unverified / cooled-down / capped emails are silent no-ops with the
 *     identical response shape (no token, no audit) so the endpoint is not
 *     a user-existence oracle.
 *   - `consume`: token-gated credential rotation. One `TransactWriteItems`
 *     conditionally deletes the PasswordReset row, writes the new argon2id
 *     credential, and clears the User reset state under
 *     `currentResetToken == :presentedToken` — so a reused or
 *     superseded token can never rotate the password twice. After the
 *     transaction commits we revoke every session, clear the
 *     per-email failed-login backoff, audit (`password_reset`), and
 *     send a best-effort completion notice.
 *
 * Zero-knowledge note: a reset rotates only the login
 * credential. It cannot unwrap the `password` key-envelope slot, so the
 * user regains *login*, not *decryption* — they re-key the slot client-side
 * after a recovery-key / passkey unlock. This service touches no key
 * material.
 *
 * See docs/security.md, "Password change, password reset".
 */
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
 * Reset-link validity. Mirrors the verification-token TTL. Exported so
 * `factor-restriction.ts` can bound how long a pending, unconsumed reset request keeps the
 * post-reset factor-restriction window open — the same TTL this token itself uses.
 */
export const RESET_TTL_SEC = 15 * 60;
/** Minimum spacing between two reset mails for the same email. */
const RESET_COOLDOWN_SEC = 60;
/** Hard cap on reset mails per UTC day per email. */
export const RESET_DAILY_LIMIT = 5;
/**
 * Constant minimum elapsed time for the request-reset handler. `request` returns early on several branches (unknown email,
 * unverified, cooldown, daily-cap) whose work is far cheaper than a real send
 * + SES dispatch — leaving the response time a user-existence oracle. Holding
 * every branch to a fixed floor measured from handler start (not random
 * jitter, which averages out over repeated probes) makes the timing identical
 * regardless of account state, complementing the already-opaque 202 shape.
 */
export const RESPONSE_TIME_FLOOR_MS = 200;

export interface RequestResetResult {
  /** Always set so the response shape is identical for hit + no-op. */
  accepted: true;
  /** Returned in dev/test only, and only on a real send. */
  resetToken?: string;
}

/**
 * The computed send plan for an eligible reset request: the fresh token, the
 * PasswordReset row to Put, and the conditional User update pinned to the
 * observed rate-limit state. Produced by `planSend`, consumed by `commitSend`.
 */
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
    // SES posture mirrors EmailVerificationService: a local endpoint
    // signals the emulator; otherwise production sends for real.
    this.sesEnabled = node === 'production' || !!config.get('SES_ENDPOINT', { infer: true });
    // Same dev trapdoor gate as signup / resend-verification — local
    // development only, hard-refused at boot on any deployed stack.
    // The opaque-202 anti-oracle holds: the raw token is returned only on a
    // real send, never on a no-op branch and never on a deployed stack.
    this.returnResetToken =
      node !== 'production' ||
      config.get('EXPOSE_VERIFICATION_TOKEN', { infer: true }) === 'true';
  }

  /**
   * Attempt to issue a reset link. Always returns the same opaque shape —
   * every internal branch logs + skips silently so the response leaks no
   * account state. A real send (and only a real send) appends a
   * `password_reset_requested` AuthEvent and, in non-prod, the raw token.
   * Wrapped in a constant minimum elapsed time so every
   * early-return branch takes as long as a real send and the response timing
   * is not a user-existence oracle.
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

  /**
   * Await until the handler has run for at least RESPONSE_TIME_FLOOR_MS,
   * measured from `startMs`. A fixed deadline (not random jitter) so the floor
   * is constant across every branch and probe — jitter averages out
   * statistically and would still leak the underlying timing.
   */
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
    // Eligibility / rate-limit gate. Any miss is a silent no-op with the
    // identical opaque shape so the endpoint is not a user-existence oracle.
    const plan = user ? this.planSend(user) : null;
    if (!plan) return { accepted: true };

    // Atomically Put the new PasswordReset row + advance the User counters.
    // A lost cooldown race aborts the transaction → same opaque no-op 202.
    const committed = await this.commitSend(user!, plan);
    if (!committed) return { accepted: true };

    // Post-commit side effects (real send only): prior-token hygiene delete,
    // audit, and the SES mail. The mail is sent only after the commit so a
    // send failure never strands a token the consume would honor.
    await this.afterSend(user!, plan.newToken, args.ip, args.userAgent);

    return {
      accepted: true,
      ...(this.returnResetToken ? { resetToken: plan.newToken } : {}),
    };
  }

  /**
   * Evaluate reset eligibility + the per-email cooldown / daily cap and, when
   * the user is eligible, return the send plan (fresh token, timestamps, and
   * the conditional User update pinned to the observed rate-limit state for
   * the TOCTOU guard). Returns `null` for every silent-no-op branch.
   */
  private planSend(user: UserRow): ResetSendPlan | null {
    if (!user.emailVerifiedAt) {
      // Unverified accounts use resend-verification, not reset. Silent.
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
    // Hash at the service boundary: only the SHA-256 hash is stored
    // (PasswordReset PK + User.currentResetToken); the raw token rides the
    // email link (and, in dev/test, the API response).
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
      // Pin the write to the rate-limit state we read above so a concurrent
      // request can't pass the same cooldown / daily-cap pre-check and commit
      // a second send (TOCTOU — CODING_STANDARDS "Check-and-mutate requires a
      // transaction").
      observed: {
        lastResetSentAt: user.lastResetSentAt,
        resetsSentDayKey: user.resetsSentDayKey,
        resetsSentToday: user.resetsSentToday,
      },
    });
    return { newToken, resetRow, userUpdate };
  }

  /**
   * Commit the single-valid-link transaction: Put the new PasswordReset
   * row + conditionally Update the User counters + (when a prior token
   * exists) Delete the prior PasswordReset row, all atomically. Folding the
   * prior-row delete into this same `TransactWriteItems` (rather than a
   * separate best-effort `DeleteCommand` after commit — the previous
   * behaviour, whose failure silently stranded the prior row for the rest of
   * its TTL, unreachable by the export's `currentResetToken`-only read path)
   * guarantees the export is never incomplete because of a transient delete
   * failure: either all three writes land, or none do. Returns `true` on
   * commit; `false` when a concurrent request won the cooldown window and
   * this losing write aborted (`TransactionCanceledException`).
   */
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

  /**
   * Post-commit side effects of a real send: append the
   * `password_reset_requested` audit and dispatch the SES mail (a send
   * failure is logged, not raised). Dropping the prior dangling reset row is
   * now handled atomically inside `commitSend`'s transaction, not here — see
   * that method's doc comment.
   */
  private async afterSend(
    user: UserRow,
    newToken: string,
    ip?: string | null,
    userAgent?: string | null,
  ): Promise<void> {
    // Real send → audit. Always a real, verified userId.
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
          // Error class only, never `err.message`: an SES rejection embeds the
          // raw recipient address in its message, which `redact` cannot scrub
          // inside a string value.
          reason: err instanceof Error ? err.name : 'unknown',
        },
        'Password-reset mail dispatch failed',
      );
    }
  }

  /**
   * Consume a reset token: rotate the credential and clear reset state in
   * one atomic transaction, then revoke sessions, clear backoff, audit,
   * and notify. Throws `RESET_TOKEN_EXPIRED` (410) for an expired token
   * and `RESET_TOKEN_INVALID` (400) for an unknown / already-consumed /
   * superseded token.
   */
  async consume(args: {
    token: string;
    newPassword: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    // The URL carries the raw token; the table stores its SHA-256 hash. Hash once at the boundary
    // and use the hash for every DynamoDB key (lookup, expiry cleanup, the consume Delete, and the
    // `currentResetToken == :tok` condition).
    const tokenHash = sha256(args.token);

    // Validate the token (existence + expiry) and the new password against the
    // policy BEFORE the transaction so a policy failure surfaces as the policy
    // error code and leaves the token consumable for a retry.
    const { row } = await this.loadValidResetRow(tokenHash);
    await this.passwords.validate(args.newPassword);

    const now = new Date().toISOString();
    await this.commitConsume(row, tokenHash, args.newPassword, now);

    await this.afterConsume(row, args.ip, args.userAgent);
  }

  /**
   * Look up the PasswordReset row and enforce existence + expiry. `tokenHash`
   * is the SHA-256 of the raw URL token — the table PK stores the
   * hash. Throws `RESET_TOKEN_INVALID` (400) for an unknown / already-consumed
   * token and `RESET_TOKEN_EXPIRED` (410) for an expired one (best-effort
   * cleanup of the expired row; TTL handles eventual consistency too).
   */
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

  /**
   * The single-use consume transaction: conditional Delete on the
   * PasswordReset row (a reused token → row gone → cond fails), Put the new
   * argon2id credential, and clear the User reset state under
   * `currentResetToken == :presentedToken` (a superseded token → cond fails).
   * Either failure aborts the whole transaction, so the password can never
   * rotate twice; a `TransactionCanceledException` surfaces as
   * `RESET_TOKEN_INVALID` (400). `tokenHash` is the SHA-256 of the raw URL
   * token: the PasswordReset PK and the stored `currentResetToken`
   * are both hashes, so the Delete key and the `currentResetToken == :tok`
   * condition compare hash-to-hash.
   */
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
      // Fresh opaque revision (the one narrow
      // exception): every credential write mints one. Nothing else about the
      // reset consume changes and nothing observable reflects this.
      credentialRevision: randomUUID(),
    };
    const userUpdate = this.users.resetConsumeUpdate({
      userId: row.userId,
      presentedToken: tokenHash,
      // The consumed PasswordReset row's own request instant — the transaction's `currentResetToken
      // == :tok` condition guarantees `row` is still the User's active reset, so this is the
      // correct request instant to pair with the completion even though a newer request could
      // overwrite `passwordResetRequestOpenedAt` later.
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

  /**
   * Post-commit side effects of a successful consume (variable-size work
   * that can exceed the 100-item transaction limit, so it runs separately,
   * mirroring change-password): nuke all sessions, clear the per-email
   * failed-login backoff, audit (`password_reset`), and send a
   * best-effort completion notice (a send failure is logged, not raised).
   */
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
          // Error class only, never `err.message`: an SES rejection embeds the
          // raw recipient address in its message, which `redact` cannot scrub
          // inside a string value.
          reason: err instanceof Error ? err.name : 'unknown',
        },
        'Password-reset completion mail dispatch failed',
      );
    }
  }

  private async sendResetMail(toAddress: string, token: string): Promise<void> {
    if (!this.sesEnabled) {
      // Local dev: do NOT log the token-bearing link or the raw recipient
      // email (CODING_STANDARDS "Never log secrets, tokens, or PII"). The dev
      // shortcut is already served by the `returnResetToken` API response
      // (EXPOSE_VERIFICATION_TOKEN), so the link log was redundant. Log only a
      // non-reversible email fingerprint and no token/link.
      this.logger.log(
        { emailFingerprint: emailFingerprint(toAddress) },
        'Password-reset link generated (local dev — token in API response)',
      );
      return;
    }
    // URL fragment (#) so the token never reaches the server, never lands
    // in API-GW / CloudFront access logs, and never leaks via Referer on
    // subsequent navigation.
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
      // Local dev: log only a non-reversible email fingerprint, never the raw
      // recipient address (CODING_STANDARDS "Never log secrets, tokens, or PII").
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
