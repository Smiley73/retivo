/**
 * Self-service account email change. A signed-in user changes their sign-in email through a
 * verified, re-authenticated flow:
 *
 *   - `request` (auth): re-verify the password, pre-check the new address for
 *     uniqueness (`409 EMAIL_TAKEN`), persist the pending intent on the `User`
 *     row (`pendingEmail` + a ~15-min logical `pendingEmailExpiresAt`). When
 *     `AUTH_MFA_ENFORCED` it returns `{ stepUpRequired, methods }` and mints
 *     no token yet — the authenticated session + the pending intent ARE the
 *     binding (no challenge JWT, so nothing to replay across operations).
 *     When the flag is off it goes straight to minting the change-email token
 *     + mailing the link (password-only path).
 *   - `sendStepUpOtp` / `verifyStepUp` (auth): complete a fresh MFA factor for
 *     the authenticated session. Both reject an expired/absent pending intent.
 *     On a valid factor the change-email token is minted (an `EmailVerification`
 *     row with `purpose: 'change_email'`) and the verification link is mailed
 *     to the NEW address.
 *   - `confirm` (public, token-authenticated): consume the change-email token
 *     (rejecting any non-`change_email` purpose) under the single-valid-link
 *     invariant — one `TransactWriteItems` atomically moves the
 *     `EmailReservation` old→new (uniqueness-checked) and swaps
 *     `User.email`/`emailLowercase`, conditioned on
 *     `currentPendingEmailToken == sha256(presented)` AND the pending address
 *     still matching. A superseded/stale token aborts the whole transaction
 *     (no swap, no reservation move). After commit it invalidates any pending
 *     `PasswordReset`, mails a security notice to the OLD address, and audits
 *     `email_change`. The old email stays live until confirm.
 *
 * No new infrastructure: the change-email token reuses the existing
 * `EmailVerification` table (PK `sha256(token)`, existing TTL) with the
 * `purpose` discriminator; the pending fields are additive `User` attributes;
 * the swap reuses the `EmailReservation` table. Mails are best-effort (a SES
 * failure is logged, never rolls back a committed swap).
 *
 * See docs/security.md, "Emails the app sends about your account".
 */
import { formatMailSource } from './mail-source.js';
import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import {
  DynamoDBDocumentClient,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { randomBytes } from 'node:crypto';
import { DYNAMO_DOC_CLIENT, SES_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import type {
  EmailReservationRow,
  EmailVerificationRow,
  UserRow,
} from '../dynamo/types.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { EmailVerificationsRepository } from '../dynamo/email-verifications.repository.js';
import { PasswordResetsRepository } from '../dynamo/password-resets.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { VerifyPasswordService } from './verify-password.service.js';
import { MfaEmailOtpService } from './mfa-email-otp.service.js';
import { StepUpService, type StepUpMethod } from './step-up.service.js';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { sha256 } from './refresh-token.service.js';
import { emailFingerprint } from '../common/email-fingerprint.js';
import { escapeHtml } from '../common/escape-html.js';

/** Change-email verification-link validity (mirrors VERIFICATION_TTL_SEC). */
const CHANGE_EMAIL_TOKEN_TTL_SEC = 15 * 60;
/** Logical pending-intent expiry (~15 min): bounds the request→step-up window. */
const PENDING_EMAIL_EXPIRY_SEC = 15 * 60;
/** Minimum spacing between two change-email verification mails for one user. */
const CHANGE_EMAIL_COOLDOWN_SEC = 60;
/** Hard cap on change-email verification mails per UTC day per user. */
const CHANGE_EMAIL_DAILY_LIMIT = 5;

export interface ChangeEmailRequestArgs {
  userId: string;
  newEmail: string;
  currentPassword: string;
  ip: string | null;
  userAgent: string | null;
  /** Device identity — lets a trusted
   *  device's password re-verify bypass the per-address backoff, mirroring
   *  login/delete-account. */
  deviceId?: string;
  deviceTrustToken?: string;
}

export interface ChangeEmailRequestResult {
  /** True when a fresh MFA factor is still required (AUTH_MFA_ENFORCED on). */
  stepUpRequired: boolean;
  /** Routine factor options when step-up is required (`['totp']` / `['email_otp']`). */
  methods?: string[];
  /** Recovery factor options when step-up is required. */
  recoveryMethods?: string[];
  /** Returned in dev/test only (no step-up path) so the developer can click
   * the link without a real SES delivery. */
  changeEmailToken?: string;
}

export interface ChangeEmailStepArgs {
  userId: string;
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class ChangeEmailService {
  private readonly logger = new Logger(ChangeEmailService.name);
  private readonly fromAddress: string;
  private readonly webOrigin: string;
  private readonly emailReservationTable: string;
  private readonly emailVerificationTable: string;
  private readonly userTable: string;
  private readonly mfaEnforced: boolean;
  private readonly sesEnabled: boolean;
  private readonly returnToken: boolean;

  constructor(
    @Inject(DYNAMO_DOC_CLIENT) private readonly doc: DynamoDBDocumentClient,
    @Inject(SES_CLIENT) private readonly ses: SESClient,
    private readonly users: UsersRepository,
    private readonly verifications: EmailVerificationsRepository,
    private readonly resets: PasswordResetsRepository,
    private readonly auth: AuthEventsRepository,
    private readonly verifyPasswordSvc: VerifyPasswordService,
    private readonly mfaEmailOtpSvc: MfaEmailOtpService,
    private readonly stepUpSvc: StepUpService,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.fromAddress = config.get('SES_FROM_ADDRESS', { infer: true });
    this.webOrigin = config.get('WEB_ORIGIN', { infer: true });
    this.emailReservationTable = config.get('TABLE_EMAIL_RESERVATION', { infer: true });
    this.emailVerificationTable = config.get('TABLE_EMAIL_VERIFICATION', { infer: true });
    this.userTable = config.get('TABLE_USER', { infer: true });
    this.mfaEnforced = config.get('AUTH_MFA_ENFORCED', { infer: true }) === 'true';
    const node = config.get('NODE_ENV', { infer: true });
    this.sesEnabled = node === 'production' || !!config.get('SES_ENDPOINT', { infer: true });
    // Same dev trapdoor as signup / reset — returns the raw change-email token
    // in the response on the password-only path so the SPA / tests can click
    // through without a real SES delivery. Local development only —
    // hard-refused at boot on any deployed stack.
    this.returnToken =
      node !== 'production' ||
      config.get('EXPOSE_VERIFICATION_TOKEN', { infer: true }) === 'true';
  }

  /**
   * Start a verified email change. Re-verifies the password (a wrong password
   * throws `401 INVALID_CREDENTIALS` via VerifyPasswordService), pre-checks the
   * new address for uniqueness (`409 EMAIL_TAKEN`), and persists the pending
   * intent. When `AUTH_MFA_ENFORCED` it returns `{ stepUpRequired: true }` and
   * mints no token; otherwise it mints the change-email token + mails the link
   * straight away (password-only path).
   */
  async request(args: ChangeEmailRequestArgs): Promise<ChangeEmailRequestResult> {
    const user = await this.users.findById(args.userId);
    if (!user) {
      // The session names a user that no longer exists. Treat as a credential
      // failure rather than leaking the state.
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect.',
      });
    }

    // Password re-auth (records a `password_verify` AuthEvent; a wrong password
    // throws 401 INVALID_CREDENTIALS + the failure event).
    await this.verifyPasswordSvc.verify({
      userId: args.userId,
      currentPassword: args.currentPassword,
      ip: args.ip,
      userAgent: args.userAgent,
      deviceId: args.deviceId,
      deviceTrustToken: args.deviceTrustToken,
    });

    const newEmailLowercase = args.newEmail.toLowerCase();
    if (newEmailLowercase === user.emailLowercase) {
      throw new BadRequestException({
        code: 'EMAIL_SAME_AS_CURRENT',
        message: 'The new email is the same as your current email.',
      });
    }
    // Pre-check uniqueness: immediate UX feedback on the common
    // typo/duplicate case. The authoritative race-safe gate is the conditional
    // EmailReservation put inside the confirm-time swap.
    const existing = await this.users.findByEmail(newEmailLowercase);
    if (existing) {
      throw new ConflictException({
        code: 'EMAIL_TAKEN',
        message: 'An account with this email already exists.',
      });
    }

    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const now = new Date(nowMs).toISOString();
    await this.users.setPendingEmail({
      userId: args.userId,
      pendingEmail: args.newEmail,
      pendingEmailLowercase: newEmailLowercase,
      expiresAt: nowSec + PENDING_EMAIL_EXPIRY_SEC,
      now,
    });

    await this.auth.record({
      userId: args.userId,
      eventType: 'email_change_requested',
      ip: args.ip,
      userAgent: args.userAgent,
    });

    if (this.mfaEnforced) {
      // Fresh-factor step-up required. The authenticated session + the pending intent are the
      // binding — no challenge token is minted. The client completes send-otp / passkey-options +
      // verify-step-up. The eligible factors come from the shared step-up computation, so passkey
      // is offered alongside TOTP / Email-OTP.
      const factors = await this.stepUpSvc.computeFactors(args.userId);
      return {
        stepUpRequired: true,
        methods: factors.methods,
        recoveryMethods: factors.recoveryMethods,
      };
    }

    // Password-only path (AUTH_MFA_ENFORCED off — local-dev default): mint the
    // token + mail the link directly. Re-read the user so the freshly-stamped
    // pending fields are present.
    const fresh = await this.users.findById(args.userId);
    const token = fresh ? await this.mintAndSendToken(fresh) : null;
    return {
      stepUpRequired: false,
      ...(token && this.returnToken ? { changeEmailToken: token } : {}),
    };
  }

  /**
   * Send a fresh Email-OTP for the pending change-email step-up. Rejects an expired/absent pending
   * intent (the user must restart with a fresh password re-auth). Delegates to the shared
   * `MfaEmailOtpService` (one `userId`-keyed code row + the cooldown/daily-cap counters shared with
   * the login OTP path) — sent to the CURRENT email.
   */
  async sendStepUpOtp(args: ChangeEmailStepArgs): Promise<void> {
    const user = await this.requirePendingIntent(args.userId);
    await this.mfaEmailOtpSvc.send({
      userId: args.userId,
      email: user.email,
      ip: args.ip,
      userAgent: args.userAgent,
    });
  }

  /**
   * Verify a fresh MFA factor for the authenticated session, delegating to
   * the shared `StepUpService.verify`. Rejects an
   * expired/absent pending intent. On a valid factor mints the change-email
   * token + mails the verification link to the new address. TOTP / passkey need
   * no prior send; Email-OTP requires a prior `sendStepUpOtp`.
   *
   * The pending-email intent (`requirePendingIntent`) is the per-op binding here,
   * so Email-OTP verifies on the LEGACY `<userId>` row (`emailOtpSource:
   * 'legacy'`) — change-email keeps its own `send-otp` on that row, unchanged.
   * Passkey is newly accepted. `StepUpService.verify` throws
   * `MFA_CODE_INVALID` (or a passkey-specific code) on a failed factor, so the
   * wire contract is identical to the prior inline implementation.
   */
  async verifyStepUp(
    args: ChangeEmailStepArgs & {
      method: StepUpMethod;
      code?: string;
      assertion?: AuthenticationResponseJSON;
    },
  ): Promise<{ changeEmailToken?: string }> {
    const user = await this.requirePendingIntent(args.userId);

    await this.stepUpSvc.verify({
      userId: args.userId,
      purpose: 'change_email',
      method: args.method,
      code: args.code,
      assertion: args.assertion,
      emailOtpSource: 'legacy',
      ip: args.ip,
      userAgent: args.userAgent,
    });

    const token = await this.mintAndSendToken(user);
    return this.returnToken ? { changeEmailToken: token } : {};
  }

  /**
   * Consume the change-email verification token (clicked from the new inbox,
   * possibly another browser — public + token-authenticated). Rejects a
   * non-`change_email` purpose, an unknown/expired token, then runs the
   * single-valid-link atomic swap. After commit invalidates any pending
   * `PasswordReset`, mails the old-address security notice (best-effort), and
   * audits `email_change`. Throws `400 CHANGE_EMAIL_TOKEN_INVALID` /
   * `410 CHANGE_EMAIL_TOKEN_EXPIRED` / `409 EMAIL_TAKEN` (confirm-race).
   */
  async confirm(args: {
    token: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ email: string }> {
    const tokenHash = sha256(args.token);
    const row = await this.verifications.findByToken(tokenHash);
    // A missing row, or a token that is not a change-email token, is invalid.
    // Do NOT delete a non-`change_email` row — it belongs to the signup flow.
    if (!row || row.purpose !== 'change_email') {
      throw new BadRequestException({
        code: 'CHANGE_EMAIL_TOKEN_INVALID',
        message: 'Email-change link is invalid or already used.',
      });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (row.expiresAt < nowSec) {
      await this.verifications.deleteToken(tokenHash);
      throw new GoneException({
        code: 'CHANGE_EMAIL_TOKEN_EXPIRED',
        message: 'Email-change link has expired. Request a new one.',
      });
    }

    const newEmail = row.email; // the NEW (pending) address for a change_email row
    const newEmailLowercase = newEmail.toLowerCase();
    const user = await this.users.findById(row.userId);
    if (!user) {
      // Orphaned token (user gone). Best-effort cleanup + invalid.
      await this.verifications.deleteToken(tokenHash);
      throw new BadRequestException({
        code: 'CHANGE_EMAIL_TOKEN_INVALID',
        message: 'Email-change link is invalid or already used.',
      });
    }
    const oldEmail = user.email;
    const oldEmailLowercase = user.emailLowercase;

    await this.commitSwap({
      user,
      tokenHash,
      newEmail,
      newEmailLowercase,
      oldEmailLowercase,
    });

    // Post-commit side effects (variable-size / best-effort; never roll back a
    // committed swap). Drop the consumed token, invalidate any pending reset
    // (a reset link must not mail the old address after the swap), notify
    // the old address, and audit. Each is individually wrapped so a failure in
    // one can't strand the others or surface as a 5xx after the swap committed.
    try {
      await this.verifications.deleteToken(tokenHash);
    } catch (err) {
      this.logger.warn(
        { userId: user.userId, reason: err instanceof Error ? err.message : 'unknown' },
        'Post-swap token cleanup failed (benign — token already consumed)',
      );
    }
    await this.invalidatePendingReset(user);

    try {
      await this.auth.record({
        userId: user.userId,
        eventType: 'email_change',
        ip: args.ip,
        userAgent: args.userAgent,
      });
    } catch (err) {
      this.logger.warn(
        { userId: user.userId, reason: err instanceof Error ? err.message : 'unknown' },
        'Post-swap audit record failed (benign — email already changed)',
      );
    }

    try {
      await this.sendSecurityNotice(oldEmail, newEmail);
    } catch (err) {
      this.logger.warn(
        {
          userId: user.userId,
          emailFingerprint: emailFingerprint(oldEmail),
          // Error class only, never `err.message`: an SES rejection embeds the
          // raw recipient address in its message, which `redact` cannot scrub
          // inside a string value.
          reason: err instanceof Error ? err.name : 'unknown',
        },
        'Email-change security notice dispatch failed',
      );
    }

    return { email: newEmail };
  }

  /**
   * Load the user + enforce a live pending email-change intent. Throws
   * `409 PENDING_EMAIL_CHANGE_EXPIRED` when there is no pending intent or it
   * has elapsed `pendingEmailExpiresAt` — the user must restart with a fresh
   * password re-auth. Returns the user when the intent is valid.
   */
  private async requirePendingIntent(userId: string): Promise<UserRow> {
    const user = await this.users.findById(userId);
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      !user ||
      !user.pendingEmailLowercase ||
      !user.pendingEmail ||
      (user.pendingEmailExpiresAt ?? 0) < nowSec
    ) {
      throw new ConflictException({
        code: 'PENDING_EMAIL_CHANGE_EXPIRED',
        message: 'No active email change, or it expired. Start over.',
      });
    }
    return user;
  }

  /**
   * Mint the change-email `EmailVerification` token (`purpose: 'change_email'`,
   * `email` = the pending NEW address), stamp the token handle + send
   * bookkeeping on the User row under a TOCTOU condition pinned to the pending
   * intent (a superseded request aborts the stale send), then mail the
   * verification link to the new address (best-effort). Returns the raw token
   * (the caller decides whether to surface it in dev). Silently no-ops the
   * mail floor / cooldown is left to the per-user counters; a cooldown / cap
   * breach throws so the client surfaces it.
   */
  private async mintAndSendToken(user: UserRow): Promise<string> {
    const pendingEmail = user.pendingEmail!;
    const pendingEmailLowercase = user.pendingEmailLowercase!;
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    // Per-user cooldown + daily cap on the change-email send (mirrors the
    // verify-email counters). A breach throws CHANGE_EMAIL_RATE_LIMITED — the
    // requester is already authenticated, so this is not an enumeration oracle.
    if (user.lastPendingEmailSentAt) {
      const lastMs = Date.parse(user.lastPendingEmailSentAt);
      if (Number.isFinite(lastMs) && nowMs - lastMs < CHANGE_EMAIL_COOLDOWN_SEC * 1000) {
        throw new ConflictException({
          code: 'CHANGE_EMAIL_RATE_LIMITED',
          message: 'A verification email was just sent. Wait a moment before retrying.',
        });
      }
    }
    const dayKey = Math.floor(nowSec / 86400);
    const countToday =
      user.pendingEmailSentDayKey === dayKey ? (user.pendingEmailSentToday ?? 0) : 0;
    if (countToday >= CHANGE_EMAIL_DAILY_LIMIT) {
      throw new ConflictException({
        code: 'CHANGE_EMAIL_RATE_LIMITED',
        message: 'Too many email-change attempts today. Try again tomorrow.',
      });
    }

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = sha256(rawToken);
    const sentAtIso = new Date(nowMs).toISOString();
    const verification: EmailVerificationRow = {
      verificationToken: tokenHash,
      userId: user.userId,
      email: pendingEmail,
      createdAt: sentAtIso,
      expiresAt: nowSec + CHANGE_EMAIL_TOKEN_TTL_SEC,
      purpose: 'change_email',
    };

    // Best-effort: invalidate the prior change-email token first so two valid
    // links never co-exist. Failure is benign — the prior link's TTL bounds it
    // and the confirm pins the newest token.
    if (user.currentPendingEmailToken) {
      try {
        await this.verifications.deleteToken(user.currentPendingEmailToken);
      } catch (err) {
        this.logger.warn(
          `Failed to drop prior change-email token for ${user.userId}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }

    await this.doc.send(
      new PutCommand({ TableName: this.emailVerificationTable, Item: verification }),
    );

    // Advance the User send bookkeeping under a condition pinned to the pending
    // intent (a newer request for a different address supersedes this one).
    const upd = this.users.pendingEmailSendUpdate({
      userId: user.userId,
      pendingEmailLowercase,
      newToken: tokenHash,
      sentAtIso,
      dayKey,
      countToday: countToday + 1,
      observed: {
        lastPendingEmailSentAt: user.lastPendingEmailSentAt ?? null,
        pendingEmailSentDayKey: user.pendingEmailSentDayKey ?? null,
        pendingEmailSentToday: user.pendingEmailSentToday ?? null,
      },
    });
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: upd.tableName,
                Key: upd.key,
                UpdateExpression: upd.update.UpdateExpression,
                ConditionExpression: upd.update.ConditionExpression,
                ExpressionAttributeValues: upd.update.ExpressionAttributeValues,
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        // The condition failed: either the pending intent moved under us (a
        // newer request superseded this one) OR a concurrent send already
        // advanced the rate-limit counters the handler read (TOCTOU loser).
        // Either way a duplicate was about to go out — drop the orphaned token
        // row and surface rate-limit semantics so the client backs off.
        await this.verifications.deleteToken(tokenHash);
        throw new ConflictException({
          code: 'CHANGE_EMAIL_RATE_LIMITED',
          message: 'A verification email was just sent. Wait a moment before retrying.',
        });
      }
      throw err;
    }

    try {
      await this.sendVerificationMail(pendingEmail, rawToken);
    } catch (err) {
      this.logger.warn(
        {
          userId: user.userId,
          emailFingerprint: emailFingerprint(pendingEmail),
          // Error class only, never `err.message`: an SES rejection embeds the
          // raw recipient address in its message, which `redact` cannot scrub
          // inside a string value.
          reason: err instanceof Error ? err.name : 'unknown',
        },
        'Change-email verification mail dispatch failed',
      );
    }
    return rawToken;
  }

  /**
   * The single-valid-link confirm transaction: move the `EmailReservation`
   * old→new (conditional put on the new lowercased address for uniqueness;
   * delete the old) AND swap `User.email`/`emailLowercase` under
   * `currentPendingEmailToken == sha256(presented)` AND the pending address
   * still matching. Any failure aborts the WHOLE transaction. A
   * uniqueness-collision on the new reservation surfaces as `409 EMAIL_TAKEN`
   * (confirm-race); a superseded/stale token or a moved pending intent
   * surfaces as `400 CHANGE_EMAIL_TOKEN_INVALID` with no swap.
   */
  private async commitSwap(args: {
    user: UserRow;
    tokenHash: string;
    newEmail: string;
    newEmailLowercase: string;
    oldEmailLowercase: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const reservation: EmailReservationRow = {
      emailLowercase: args.newEmailLowercase,
      userId: args.user.userId,
      reservedAt: now,
    };
    const userUpdate = this.users.swapEmailUpdate({
      userId: args.user.userId,
      newEmail: args.newEmail,
      newEmailLowercase: args.newEmailLowercase,
      presentedToken: args.tokenHash,
      now,
    });
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              // New-address uniqueness gate (race-safe): the authoritative
              // EMAIL_TAKEN check. Fails closed if the address was claimed
              // between request and confirm.
              Put: {
                TableName: this.emailReservationTable,
                Item: reservation,
                ConditionExpression: 'attribute_not_exists(emailLowercase)',
              },
            },
            {
              // Free the old reservation, but only if it still belongs to this
              // user (defensive — a concurrent recycle shouldn't drop it).
              Delete: {
                TableName: this.emailReservationTable,
                Key: { emailLowercase: args.oldEmailLowercase },
                ConditionExpression: 'userId = :u',
                ExpressionAttributeValues: { ':u': args.user.userId },
              },
            },
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
        // Disambiguate the two failure modes from the cancellation reasons:
        // a ConditionalCheckFailed on the new-reservation Put = EMAIL_TAKEN;
        // anything else (stale token / moved pending intent) = invalid link.
        const reasons = err.CancellationReasons ?? [];
        const reservationClash = reasons[0]?.Code === 'ConditionalCheckFailed';
        if (reservationClash) {
          throw new ConflictException({
            code: 'EMAIL_TAKEN',
            message: 'An account with this email already exists.',
          });
        }
        throw new BadRequestException({
          code: 'CHANGE_EMAIL_TOKEN_INVALID',
          message: 'Email-change link is invalid or already used.',
        });
      }
      throw err;
    }
  }

  /**
   * Invalidate any pending password reset on a committed swap: clear
   * `User.currentResetToken` + the reset counters and best-effort delete the
   * `PasswordReset` row so a reset link can't mail the (now-old) address. A
   * single keyed delete by the stored handle — no Scan. Best-effort: a failure
   * is logged, never rolls back the committed swap.
   */
  private async invalidatePendingReset(user: UserRow): Promise<void> {
    if (!user.currentResetToken) return;
    try {
      await this.resets.deleteToken(user.currentResetToken);
      // Clear the handle on the User row so a stale row can't be honored.
      // (The swap update already bumped updatedAt; this is a separate write
      // because the swap is conditioned on token/pending fields, not reset
      // fields, and runs post-commit.) Conditioned on the pre-swap token so a
      // fresh reset minted AFTER the swap (before this cleanup) isn't wiped.
      await this.users.clearPendingResetHandle(user.userId, user.currentResetToken ?? undefined);
    } catch (err) {
      this.logger.warn(
        {
          userId: user.userId,
          reason: err instanceof Error ? err.message : 'unknown',
        },
        'Pending-reset invalidation after email change failed',
      );
    }
  }

  private async sendVerificationMail(toAddress: string, token: string): Promise<void> {
    // Token in the URL fragment (#) so it never reaches the server, never lands
    // in API-GW / CloudFront access logs, and never leaks via Referer.
    const link = `${this.webOrigin}/auth/change-email/confirm#token=${encodeURIComponent(token)}`;
    if (!this.sesEnabled) {
      // Local dev: log only a non-reversible fingerprint, never the token/link
      // or recipient (CODING_STANDARDS "Never log secrets, tokens, or PII").
      // The dev shortcut is served by the `returnToken` API response.
      this.logger.log(
        { emailFingerprint: emailFingerprint(toAddress) },
        'Change-email verification link generated (local dev — token in API response)',
      );
      return;
    }
    await this.ses.send(
      new SendEmailCommand({
        Source: formatMailSource(this.fromAddress),
        Destination: { ToAddresses: [toAddress] },
        Message: {
          Subject: { Data: 'Confirm your new email address' },
          Body: {
            Text: {
              Data:
                `You asked to change the email on your account to this address. ` +
                `Confirm the change using the link below (valid for 15 minutes):\n\n${link}\n\n` +
                `Your current email keeps working until you confirm. ` +
                `If you didn't request this, you can ignore this message.`,
            },
            Html: {
              Data:
                `<p>You asked to change the email on your account to this address. ` +
                `Confirm the change using the link below (valid for 15 minutes):</p>` +
                `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` +
                `<p>Your current email keeps working until you confirm.</p>` +
                `<p>If you didn't request this, you can ignore this message.</p>`,
            },
          },
        },
      }),
    );
  }

  private async sendSecurityNotice(oldAddress: string, newEmail: string): Promise<void> {
    if (!this.sesEnabled) {
      this.logger.log(
        { emailFingerprint: emailFingerprint(oldAddress) },
        'Email-change security notice generated (local dev)',
      );
      return;
    }
    await this.ses.send(
      new SendEmailCommand({
        Source: formatMailSource(this.fromAddress),
        Destination: { ToAddresses: [oldAddress] },
        Message: {
          Subject: { Data: 'Your account email was changed' },
          Body: {
            Text: {
              Data:
                `The email on your account was just changed to ${newEmail}. ` +
                `If this was you, no action is needed.\n\n` +
                `If this wasn't you, someone may have access to your account — ` +
                `reset your password right away and review your security settings.`,
            },
            Html: {
              Data:
                `<p>The email on your account was just changed to ` +
                `<strong>${escapeHtml(newEmail)}</strong>. If this was you, no action is needed.</p>` +
                `<p>If this wasn't you, someone may have access to your account — ` +
                `reset your password right away and review your security settings.</p>`,
            },
          },
        },
      }),
    );
  }
}
