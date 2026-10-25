// Re-issues an email-verification token on demand: per-IP throttle, per-email cooldown and daily cap, and a constant 202 shape so the endpoint
// is no user-existence oracle. See docs/security.md, "Sign-up".
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

const RESEND_COOLDOWN_SEC = 60;
const RESEND_DAILY_LIMIT = 5;
// Constant minimum handler time: early-return branches are far cheaper than a real send, so timing would be a
// user-existence oracle. A fixed floor (not jitter, which averages out) hides it.
const RESPONSE_TIME_FLOOR_MS = 200;

export interface ResendResult {
  /** Always set, so the response shape is identical for a hit and a no-op. */
  accepted: true;
  /** Dev and test only, so a developer can click the link. */
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
    // Same gates as `SignupService`.
    this.returnVerificationToken =
      config.get('NODE_ENV', { infer: true }) !== 'production' ||
      config.get('EXPOSE_VERIFICATION_TOKEN', { infer: true }) === 'true';
  }

  /**
   * Attempts a resend. Always the same shape: internal branches log and skip silently, and a constant minimum elapsed
   * time makes timing a non-oracle.
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

  // Awaits the response floor from `startMs`; fixed, since jitter averages out and would leak timing.
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
      return { accepted: true };
    }
    if (user.emailVerifiedAt) {
      return { accepted: true };
    }

    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    if (user.lastVerificationSentAt) {
      const lastMs = Date.parse(user.lastVerificationSentAt);
      if (Number.isFinite(lastMs) && nowMs - lastMs < RESEND_COOLDOWN_SEC * 1000) {
        return { accepted: true };
      }
    }

    const dayKey = Math.floor(nowSec / 86400);
    const sameDay = user.verificationsSentDayKey === dayKey;
    const countToday = sameDay ? (user.verificationsSentToday ?? 0) : 0;
    if (countToday >= RESEND_DAILY_LIMIT) {
      return { accepted: true };
    }

    const newToken = randomBytes(32).toString('base64url');
    // Hash at the service boundary: store only the SHA-256 hash.
    const newTokenHash = sha256(newToken);
    const sentAtIso = new Date(nowMs).toISOString();
    const verification: EmailVerificationRow = {
      verificationToken: newTokenHash,
      userId: user.userId,
      email: user.email,
      createdAt: sentAtIso,
      expiresAt: nowSec + VERIFICATION_TTL_SEC,
      // The discriminator lets verify-email accept this and a change-email confirm reject it.
      purpose: 'verify_email',
    };

    // Best-effort: invalidate the prior token so two valid links never co-exist; its TTL bounds it if this fails.
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
          // Error class only, never `err.message`: an SES rejection embeds the recipient address.
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
