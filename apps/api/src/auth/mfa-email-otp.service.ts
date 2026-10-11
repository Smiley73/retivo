/**
 * Sends + verifies emailed 6-digit MFA codes. Mirrors
 * the `PasswordResetService` rate-limit posture:
 *   - per-email cooldown (60 s) + daily cap (5) — counters on the `User` row so
 *     they survive the `MfaEmailOtp` ~10-min TTL,
 *   - a constant 200 ms response floor so a cooled-down / capped branch is not
 *     a timing oracle,
 *   - hash-at-rest: only `sha256(rawCode)` is stored in `MfaEmailOtpRow`; the
 *     raw 6-digit code is emailed and never persisted or logged,
 *   - a per-code hard attempt cap (5 wrong guesses invalidate the code + force
 *     a resend), tracked as `attempts` on the row,
 *   - a TOCTOU `ConditionExpression` on the User rate-limit state
 *     (`planSend` / `commitSend` / `afterSend` split, like reset).
 *
 * Why the User-counter update and the `MfaEmailOtp` Put are NOT one cross-table
 * transaction: it is a deliberate simplicity/cost choice (matching
 * `PasswordResetService`), not an IAM limitation. DynamoDB has no
 * `TransactWriteItems`-named IAM action to withhold — a transaction is
 * authorized by the per-item `PutItem`/`UpdateItem` actions already granted on
 * each table, so the absence of a transaction here buys nothing IAM-wise. The
 * real isolation boundary is the narrow point-ops action set (no Query/Scan)
 * plus api-role-only access to these secret tables. The conditional User update
 * commits first (winning the cooldown race for at most one sender), then the
 * code row is Put — the same "advance counters under condition, then side
 * effect" ordering reset uses. A lost cooldown race aborts before any code
 * lands.
 *
 * See docs/security.md, "The second factor".
 */
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

/** Code validity window: 10 minutes. */
const MFA_EMAIL_OTP_TTL_SEC = 10 * 60;
/** Minimum spacing between two code sends for the same user. */
const MFA_EMAIL_OTP_COOLDOWN_SEC = 60;
/** Hard cap on Email-OTP sends per UTC day per user. */
export const MFA_EMAIL_OTP_DAILY_LIMIT = 5;
/** Per-code wrong-attempt cap: the 5th wrong guess invalidates the code. */
export const MFA_EMAIL_OTP_MAX_ATTEMPTS = 5;
/**
 * Constant minimum elapsed time for the send handler (anti-timing-oracle).
 * Mirrors `PasswordResetService.RESPONSE_TIME_FLOOR_MS`: the cooldown / cap
 * no-op branches are far cheaper than a real SES dispatch, so hold every branch
 * to a fixed floor measured from handler start.
 */
export const MFA_EMAIL_OTP_RESPONSE_FLOOR_MS = 200;

interface EmailOtpSendPlan {
  rawCode: string;
  otpRow: MfaEmailOtpRow;
  userUpdate: ReturnType<UsersRepository['mfaEmailOtpSendUpdate']>;
}

/**
 * Live-expiry guard for the numeric epoch-second TTL. Returns `true` only when `expiresAt` is a
 * finite number strictly in the future. A legacy ISO-string value (`typeof === 'string'`), a
 * NaN/Infinity, or an already-elapsed numeric value all return `false`, so a pre-cutover row is
 * treated as expired and forces a fresh code.
 */
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
   * Send a fresh 6-digit code to `email` for `userId` (best effort). Returns
   * `202`-shaped semantics: the handler never reveals whether a code already
   * exists or whether the cooldown / cap blocked the send. Wrapped in the
   * constant response floor. The user is already password-authenticated at the
   * MFA step (the challenge token names them), so this is not an enumeration
   * oracle — the floor + opaque shape defend against a within-account timing
   * probe of the rate-limit state.
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

  /**
   * Evaluate the per-user cooldown / daily cap and, when permitted, build the
   * send plan: a fresh 6-digit code, the `MfaEmailOtp` row to Put (code hashed),
   * and the conditional User update pinned to the observed rate-limit state.
   * Returns `null` on every blocked branch (silent no-op).
   */
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

    // 6-digit, uniformly random over 000000..999999 (leading zeros kept).
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

  /**
   * Commit the send: the conditional User-counter update first (TOCTOU guard —
   * a lost cooldown race aborts here), then Put the code row. Returns `true` on
   * commit; `false` when a concurrent send won the cooldown window. Not one
   * cross-table transaction — a deliberate simplicity/cost choice, not an IAM
   * limitation (see file header): the User update is a plain conditional
   * `UpdateItem`; the code Put follows only on success.
   */
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
    // Counter advanced — now persist the live code (replaces any prior row).
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
          // Error class only, never `err.message`: an SES rejection embeds the
          // raw recipient address in its message (e.g. "Email address is not
          // verified: user@example.com"), which `redact` cannot scrub inside a
          // string value. Matches the `Approved-notification` failure log.
          reason: err instanceof Error ? err.name : 'unknown',
        },
        'MFA Email-OTP mail dispatch failed',
      );
    }
  }

  /**
   * Verify a presented code for `userId`. Returns `{ ok: true }` on match
   * (consumes the code) and `{ ok: false }` on a wrong guess (increments the
   * per-code attempt counter). Throws:
   *   - `MFA_CODE_EXPIRED` (410) when the code's TTL has elapsed (best-effort
   *     delete of the stale row),
   *   - `MFA_CODE_INVALID` (401) when no live code exists, or after the 5th
   *     wrong guess (the code is invalidated + the row deleted, forcing a
   *     resend).
   * The raw code is hashed at this boundary and compared hash-to-hash; the raw
   * value never touches DynamoDB or logs.
   */
  async verify(args: {
    userId: string;
    code: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<{ ok: boolean }> {
    const row = await this.otps.get(args.userId);
    if (!row) throw this.invalid();

    // Numeric epoch-second TTL. A nonnumeric (legacy ISO) or elapsed
    // value is rejected here — the pre-cutover code is invalidated.
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

    // Wrong guess — increment the per-code attempt counter (conditional on the
    // row still being the one we read, so a concurrent resend isn't clobbered).
    let attempts: number;
    try {
      attempts = await this.otps.incrementAttempts(args.userId, row.sentAt);
    } catch (err) {
      // Row gone or replaced under us (concurrent resend) → treat as invalid.
      // Re-throw anything else (network error, throughput error, SDK error).
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      throw this.invalid();
    }
    await this.auth.record({
      userId: args.userId,
      eventType: 'mfa_email_otp_failed',
      ip: args.ip ?? null,
      userAgent: args.userAgent ?? null,
    });
    // Incident-context warn only. The `MfaVerifyFailed` metric is now emitted
    // as direct EMF from AuthEventsRepository off the `mfa_email_otp_failed`
    // AuthEvent — this log is NOT its source. Never log the code.
    this.logger.warn('MFA verification failed', {
      userId: args.userId,
      factor: 'email_otp',
    });
    if (attempts >= MFA_EMAIL_OTP_MAX_ATTEMPTS) {
      // Hard cap hit — invalidate the code, force a resend.
      await this.otps.delete(args.userId);
      throw this.invalid();
    }
    return { ok: false };
  }

  /**
   * Send a fresh 6-digit step-up code to `email` for `userId`, bound to `purpose`.
   * Same opaque/floored posture as {@link send},
   * but writes the namespaced `<userId>#stepup` code row (carrying `purpose`) and
   * draws on the SEPARATE step-up daily-cap/cooldown budget on the `User` row, so
   * a step-up user's allowance is never drained by login sends (and vice versa).
   * Concurrent different-purpose sends overwrite the single step-up row
   * (last-write-wins — the superseded op simply re-requests).
   *
   * Returns `{ committed }`: `true` only when a code row was actually persisted
   * (and the mail dispatched). A cooldown / daily-cap / lost-race no-op returns
   * `false` so the caller does NOT record a `step_up_challenge` audit event for a
   * challenge that was never minted (the opaque 202 shape + response floor still
   * hide which branch ran from the client).
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

  /** Step-up analogue of {@link planSend}, on the step-up budget + namespaced row. */
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

  /** Step-up analogue of {@link commitSend}: conditional User update, then the namespaced Put. */
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
   * Verify a presented step-up code for `userId` bound to `purpose`. Same lifecycle as {@link
   * verify} on the namespaced `<userId>#stepup` row, plus a per-op binding check: a code whose
   * stored `purpose` does not match the presented one is rejected as `MFA_CODE_INVALID` (a wrong
   * guess against it), so a code minted for one op can never authorize another. Returns `{ ok: true
   * }` on a matching, correct, unexpired, right-purpose code (consumed); `{ ok: false }` on a wrong
   * guess.
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

    // Numeric epoch-second TTL. A nonnumeric (legacy ISO) or elapsed
    // value is rejected here — the pre-cutover code is invalidated.
    if (!isLiveEpochSeconds(row.expiresAt)) {
      await this.throwExpired(
        () => this.otps.deleteStepUp(args.userId),
        args.userId,
      );
    }

    // Per-op binding: a right code for the wrong op counts as a wrong guess
    // (never consumed for the mismatched op), so a code cannot cross operations.
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

  /**
   * Shared expired/legacy-code path for {@link verify} and {@link verifyStepUp}:
   * best-effort delete the stale row (via the caller's `del`, so each verifier
   * targets its own — login vs step-up — row), then throw the typed
   * `MFA_CODE_EXPIRED`. Never returns normally (`Promise<never>`).
   */
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

  /**
   * Best-effort hygiene delete of an expired/legacy code row. A transient
   * DynamoDB fault on this delete must NEVER prevent the caller's normal
   * fallback (throwing `MFA_CODE_EXPIRED`) — swallow + warn, then let the
   * caller throw the typed error. Never logs the code.
   */
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
      // Local dev: never log the raw code or recipient email (CODING_STANDARDS
      // "Never log secrets, tokens, or PII"). The integration test suite reads
      // the code from the stored row's known plaintext, not a log line.
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
