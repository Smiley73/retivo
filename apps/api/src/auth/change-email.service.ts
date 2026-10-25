// Self-service email change: `request` re-verifies the password and persists a pending intent, step-up completes a fresh factor,
// `confirm` consumes the token. See docs/security.md, "Emails the app sends about your account".
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

// Change-email verification-link validity.
const CHANGE_EMAIL_TOKEN_TTL_SEC = 15 * 60;
// Logical pending-intent expiry, bounding the request to step-up window.
const PENDING_EMAIL_EXPIRY_SEC = 15 * 60;
const CHANGE_EMAIL_COOLDOWN_SEC = 60;
const CHANGE_EMAIL_DAILY_LIMIT = 5;

export interface ChangeEmailRequestArgs {
  userId: string;
  newEmail: string;
  currentPassword: string;
  ip: string | null;
  userAgent: string | null;
  /** Lets a trusted device bypass the per-address backoff, as in login. */
  deviceId?: string;
  deviceTrustToken?: string;
}

export interface ChangeEmailRequestResult {
  /** True when a fresh MFA factor is still required (`AUTH_MFA_ENFORCED` on). */
  stepUpRequired: boolean;
  methods?: string[];
  recoveryMethods?: string[];
  /** Dev and test only (no step-up path), so a developer can click the link without SES delivery. */
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
    // Same dev trapdoor as signup and reset: local development only, hard-refused at boot on a deployed stack.
    this.returnToken =
      node !== 'production' ||
      config.get('EXPOSE_VERIFICATION_TOKEN', { infer: true }) === 'true';
  }

  /**
   * Starts a verified change: re-verifies the password, pre-checks the new address (409 EMAIL_TAKEN) and persists the
   * pending intent. With `AUTH_MFA_ENFORCED` it returns `{ stepUpRequired: true }` and mints no token; otherwise it
   * mints the token and mails the link.
   */
  async request(args: ChangeEmailRequestArgs): Promise<ChangeEmailRequestResult> {
    const user = await this.users.findById(args.userId);
    if (!user) {
      // The session names a user that no longer exists: a credential failure, without leaking state.
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect.',
      });
    }

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
    // The pre-check is UX feedback; the authoritative race-safe gate is the conditional EmailReservation put in the
    // confirm swap.
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
      // The authenticated session plus the pending intent are the binding; no challenge token is minted. Factors come
      // from the shared step-up computation.
      const factors = await this.stepUpSvc.computeFactors(args.userId);
      return {
        stepUpRequired: true,
        methods: factors.methods,
        recoveryMethods: factors.recoveryMethods,
      };
    }

    // Password-only path (flag off): re-read the user so the freshly stamped pending fields are present.
    const fresh = await this.users.findById(args.userId);
    const token = fresh ? await this.mintAndSendToken(fresh) : null;
    return {
      stepUpRequired: false,
      ...(token && this.returnToken ? { changeEmailToken: token } : {}),
    };
  }

  /**
   * Sends a fresh Email-OTP for the pending step-up, to the current email, via the shared `MfaEmailOtpService`;
   * rejects an expired or absent intent.
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
   * Verifies a fresh MFA factor for the session through `StepUpService.verify`, then mints the token and mails the
   * new address; rejects an expired or absent intent. The pending intent is the per-operation binding, so Email-OTP
   * verifies on the legacy `<userId>` row.
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
   * Consumes the change-email token (clicked from the new inbox, possibly another browser) and runs the
   * single-valid-link swap. After commit it invalidates any pending PasswordReset, mails the old address a notice
   * (best-effort) and audits `email_change`. Throws 400 CHANGE_EMAIL_TOKEN_INVALID, 410 CHANGE_EMAIL_TOKEN_EXPIRED or
   * 409 EMAIL_TAKEN (confirm race).
   */
  async confirm(args: {
    token: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ email: string }> {
    const tokenHash = sha256(args.token);
    const row = await this.verifications.findByToken(tokenHash);
    // A token that is not a change-email token is invalid; do not delete it, since it belongs to the signup flow.
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

    // Post-commit and best-effort, each wrapped so one failure cannot strand the others or surface as a 5xx after
    // the swap committed; a reset link must not mail the old address.
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
          // Error class only, never `err.message`: an SES rejection embeds the recipient address, which `redact` cannot
          // scrub inside a string.
          reason: err instanceof Error ? err.name : 'unknown',
        },
        'Email-change security notice dispatch failed',
      );
    }

    return { email: newEmail };
  }

  // Loads the user and enforces a live pending intent; throws 409 PENDING_EMAIL_CHANGE_EXPIRED when absent or
  // elapsed.
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

  // Mints the `change_email` EmailVerification token, stamps the handle and send bookkeeping under a condition pinned
  // to the pending intent (a superseded request aborts the stale send), then mails the new address. A cooldown or cap
  // breach throws so the client surfaces it.
  private async mintAndSendToken(user: UserRow): Promise<string> {
    const pendingEmail = user.pendingEmail!;
    const pendingEmailLowercase = user.pendingEmailLowercase!;
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    // Per-user cooldown and daily cap; the requester is authenticated, so CHANGE_EMAIL_RATE_LIMITED is no
    // enumeration oracle.
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

    // Invalidate the prior token first so two valid links never co-exist; failure is benign, since its TTL bounds
    // it and confirm pins the newest.
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

    // Advance the bookkeeping under a condition pinned to the pending intent.
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
        // The condition failed: the intent moved or a concurrent send advanced the counters. A duplicate was about to
        // go out, so drop the orphaned token and surface rate-limit semantics.
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
          // Error class only, never `err.message`: an SES rejection embeds the recipient address.
          reason: err instanceof Error ? err.name : 'unknown',
        },
        'Change-email verification mail dispatch failed',
      );
    }
    return rawToken;
  }

  // The single-valid-link confirm transaction: moves the EmailReservation old to new (conditional put for uniqueness)
  // and swaps the User email under `currentPendingEmailToken == sha256(presented)` and the pending address still
  // matching. Any failure aborts the whole transaction: a new-reservation collision is 409 EMAIL_TAKEN, a stale token
  // or moved intent is 400 CHANGE_EMAIL_TOKEN_INVALID.
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
              // Authoritative EMAIL_TAKEN check; fails closed if the address was claimed between request and confirm.
              Put: {
                TableName: this.emailReservationTable,
                Item: reservation,
                ConditionExpression: 'attribute_not_exists(emailLowercase)',
              },
            },
            {
              // Free the old reservation only if it still belongs to this user.
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
        // A ConditionalCheckFailed on the new-reservation Put is EMAIL_TAKEN; anything else is an invalid link.
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

  // Clears `currentResetToken` and the reset counters and best-effort deletes the PasswordReset row on a committed
  // swap, so a reset link cannot mail the old address. A single keyed delete, no Scan.
  private async invalidatePendingReset(user: UserRow): Promise<void> {
    if (!user.currentResetToken) return;
    try {
      await this.resets.deleteToken(user.currentResetToken);
      // Post-commit write, conditioned on the pre-swap token so a reset minted after the swap is not wiped.
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
    // Token in the URL fragment so it never reaches the server, access logs or Referer.
    const link = `${this.webOrigin}/auth/change-email/confirm#token=${encodeURIComponent(token)}`;
    if (!this.sesEnabled) {
      // Log only a non-reversible fingerprint, never the token, link or recipient (CODING_STANDARDS "Never log secrets,
      // tokens, or PII").
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
