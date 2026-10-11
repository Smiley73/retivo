/**
 * Re-issues an email-verification token on demand, with abuse mitigations:
 *
 *   - Per-IP throttle at the controller (NestJS Throttler).
 *   - Per-email cooldown (silent backoff between sends).
 *   - Per-email daily cap (silent backoff after N sends in a UTC day).
 *   - Constant response shape (always 202; success/no-op are
 *     indistinguishable to the caller) so the endpoint is not a
 *     user-existence oracle.
 *
 * On a successful resend the prior EmailVerification row is deleted and
 * a fresh one is written, with the new token stamped on the User row so
 * a future resend can again invalidate it. The signup-expiry window is
 * extended on each successful send.
 *
 * See docs/security.md, "Sign-up".
 */
import {
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DynamoDBDocumentClient,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'node:crypto';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import type { EmailVerificationRow } from '../dynamo/types.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { EmailVerificationService } from './email-verification.service.js';
import { sha256 } from './refresh-token.service.js';
import { emailFingerprint } from '../common/email-fingerprint.js';
import { SIGNUP_EXPIRY_SEC, VERIFICATION_TTL_SEC } from './signup.service.js';

/** Minimum spacing between two resend mails for the same email. */
const RESEND_COOLDOWN_SEC = 60;
/** Hard cap on resends per UTC day per email. */
export const RESEND_DAILY_LIMIT = 5;
/**
 * Constant minimum handler elapsed time. The handler
 * returns early on several branches (unknown email, already-verified,
 * cooldown, daily-cap) whose work is far cheaper than a real send — leaving
 * the response time a user-existence oracle. Holding every branch to a fixed
 * floor measured from handler start (not random jitter, which averages out
 * over repeated probes) makes the timing identical regardless of account
 * state, complementing the already-opaque 202 shape.
 */
export const RESPONSE_TIME_FLOOR_MS = 200;

export interface ResendResult {
  /** Always set so the response shape is identical for hit + no-op. */
  accepted: true;
  /** Returned in dev/test only so the developer can click the link. */
  verificationToken?: string;
}

@Injectable()
export class ResendVerificationService {
  private readonly logger = new Logger(ResendVerificationService.name);
  private readonly emailVerificationTable: string;
  private readonly returnVerificationToken: boolean;

  constructor(
    @Inject(DYNAMO_DOC_CLIENT) private readonly doc: DynamoDBDocumentClient,
    private readonly users: UsersRepository,
    private readonly auth: AuthEventsRepository,
    private readonly verification: EmailVerificationService,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.emailVerificationTable = config.get('TABLE_EMAIL_VERIFICATION', { infer: true });
    // Same gates as `SignupService` — see comment there.
    this.returnVerificationToken =
      config.get('NODE_ENV', { infer: true }) !== 'production' ||
      config.get('EXPOSE_VERIFICATION_TOKEN', { infer: true }) === 'true';
  }

  /**
   * Attempt to resend. Always returns the same shape — internal branches log
   * + skip silently to avoid leaking account state. Wraps the whole handler in
   * a constant minimum elapsed time so every early-return branch
   * takes as long as a real send and the response timing is not a
   * user-existence oracle.
   */
  async resend(args: {
    email: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<ResendResult> {
    const startMs = Date.now();
    try {
      return await this.resendInner(args);
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

  private async resendInner(args: {
    email: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<ResendResult> {
    const emailLowercase = args.email.toLowerCase();
    const user = await this.users.findByEmail(emailLowercase);
    if (!user) {
      // Unknown email. Silent — same response as success.
      return { accepted: true };
    }
    if (user.emailVerifiedAt) {
      // Already verified. Silent — no need to resend.
      return { accepted: true };
    }

    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    if (user.lastVerificationSentAt) {
      const lastMs = Date.parse(user.lastVerificationSentAt);
      if (Number.isFinite(lastMs) && nowMs - lastMs < RESEND_COOLDOWN_SEC * 1000) {
        // Cooldown not elapsed. Silent.
        return { accepted: true };
      }
    }

    const dayKey = Math.floor(nowSec / 86400);
    const sameDay = user.verificationsSentDayKey === dayKey;
    const countToday = sameDay ? (user.verificationsSentToday ?? 0) : 0;
    if (countToday >= RESEND_DAILY_LIMIT) {
      // Daily cap hit. Silent.
      return { accepted: true };
    }

    const newToken = randomBytes(32).toString('base64url');
    // Hash at the service boundary: store only the SHA-256 hash;
    // the raw token rides the email link (and the dev/test response).
    const newTokenHash = sha256(newToken);
    const sentAtIso = new Date(nowMs).toISOString();
    const verification: EmailVerificationRow = {
      verificationToken: newTokenHash,
      userId: user.userId,
      email: user.email,
      createdAt: sentAtIso,
      expiresAt: nowSec + VERIFICATION_TTL_SEC,
      // Stamp the discriminator so the
      // verify-email consume accepts this positively and a change-email
      // confirm rejects it.
      purpose: 'verify_email',
    };

    // Best-effort: invalidate the prior token first so two valid links
    // never co-exist. Failure here is benign — the prior link's TTL
    // still bounds its lifetime.
    if (user.currentVerificationToken) {
      try {
        await this.doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Delete: {
                  TableName: this.emailVerificationTable,
                  Key: { verificationToken: user.currentVerificationToken },
                },
              },
            ],
          }),
        );
      } catch (err) {
        this.logger.warn(
          `Failed to invalidate prior verification token for ${user.userId}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }

    await this.doc.send(
      new PutCommand({ TableName: this.emailVerificationTable, Item: verification }),
    );

    await this.users.applyVerificationSend({
      userId: user.userId,
      newToken: newTokenHash,
      sentAtIso,
      dayKey,
      countToday: countToday + 1,
      signupExpiresAt: nowSec + SIGNUP_EXPIRY_SEC,
    });

    await this.auth.record({
      userId: user.userId,
      eventType: 'email_resend',
      ip: args.ip ?? null,
      userAgent: args.userAgent ?? null,
    });

    try {
      await this.verification.sendVerificationMail(user.email, newToken);
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
        'Resend verification mail dispatch failed',
      );
    }

    return {
      accepted: true,
      ...(this.returnVerificationToken ? { verificationToken: newToken } : {}),
    };
  }
}
