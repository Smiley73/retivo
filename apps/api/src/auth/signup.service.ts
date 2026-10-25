// Signup orchestrator: EmailReservation, User, Credential and EmailVerification rows in one TransactWriteItems, so concurrent signups on one
// email cannot both succeed. An expired unverified signup is lazily reclaimed. See docs/security.md, "Sign-up".
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { randomUUID, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import type {
  CredentialRow,
  EmailVerificationRow,
  EmailReservationRow,
  UserRow,
} from '../dynamo/types.js';
import { EmailVerificationService } from './email-verification.service.js';
import { sha256 } from './refresh-token.service.js';
import { SignupApprovalService } from './signup-approval.service.js';
import { SignupApprovalsRepository } from '../dynamo/signup-approvals.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { emailFingerprint } from '../common/email-fingerprint.js';

// Token-link validity, aligned with the SES copy.
export const VERIFICATION_TTL_SEC = 15 * 60;
// Unverified-signup expiry; after this the email can be re-claimed.
export const SIGNUP_EXPIRY_SEC = 24 * 60 * 60;

export interface SignupArgs {
  email: string;
  passwordHash: string;
  firstName?: string;
  lastName?: string;
  birthdate?: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface SignupResult {
  userId: string;
  householdId: string;
  email: string;
  /** Dev and test only; never logged. */
  verificationToken?: string;
}

@Injectable()
export class SignupService {
  private readonly logger = new Logger(SignupService.name);
  private readonly userTable: string;
  private readonly emailReservationTable: string;
  private readonly credentialTable: string;
  private readonly emailVerificationTable: string;
  private readonly returnVerificationToken: boolean;

  constructor(
    @Inject(DYNAMO_DOC_CLIENT) private readonly doc: DynamoDBDocumentClient,
    private readonly verification: EmailVerificationService,
    private readonly approval: SignupApprovalService,
    private readonly approvals: SignupApprovalsRepository,
    private readonly auth: AuthEventsRepository,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.userTable = config.get('TABLE_USER', { infer: true });
    this.emailReservationTable = config.get('TABLE_EMAIL_RESERVATION', { infer: true });
    this.credentialTable = config.get('TABLE_CREDENTIAL', { infer: true });
    this.emailVerificationTable = config.get('TABLE_EMAIL_VERIFICATION', { infer: true });
    // The raw `verificationToken` is returned when NODE_ENV is not production, or when `EXPOSE_VERIFICATION_TOKEN` is
    // true (a local-only trapdoor hard-refused at env validation on any deployed stack, so both gates are false in
    // AWS).
    this.returnVerificationToken =
      config.get('NODE_ENV', { infer: true }) !== 'production' ||
      config.get('EXPOSE_VERIFICATION_TOKEN', { infer: true }) === 'true';
  }

  /** Creates the user atomically; the caller validates the password (PasswordValidatorService) first. */
  async signup(args: SignupArgs): Promise<SignupResult> {
    const result = await this.tryInsert(args);
    if (result) return result;

    // On EMAIL_TAKEN, if the prior signup is unverified and expired, recycle its rows and retry once; anything else
    // is 409.
    const recycled = await this.tryRecycleExpiredSignup(args.email);
    if (!recycled) {
      throw new ConflictException({
        code: 'EMAIL_TAKEN',
        message: 'An account with this email already exists.',
      });
    }
    const second = await this.tryInsert(args);
    if (second) return second;
    // Lost a race against a concurrent recycle or signup.
    throw new ConflictException({
      code: 'EMAIL_TAKEN',
      message: 'An account with this email already exists.',
    });
  }

  private async tryInsert(args: SignupArgs): Promise<SignupResult | null> {
    const { rows, verificationToken, userId, householdId } =
      this.buildSignupRows(args);
    const { reservation, user, credential, verification } = rows;

    const transactItems: NonNullable<
      ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
    > = [
      {
        Put: {
          TableName: this.emailReservationTable,
          Item: reservation,
          ConditionExpression: 'attribute_not_exists(emailLowercase)',
        },
      },
      {
        Put: {
          TableName: this.userTable,
          Item: user,
          ConditionExpression: 'attribute_not_exists(userId)',
        },
      },
      {
        Put: {
          TableName: this.credentialTable,
          Item: credential,
        },
      },
      {
        Put: {
          TableName: this.emailVerificationTable,
          Item: verification,
        },
      },
    ];

    try {
      await this.doc.send(
        new TransactWriteCommand({ TransactItems: transactItems }),
      );
    } catch (err) {
      if (err instanceof TransactionCanceledException) return null;
      throw err;
    }

    await this.auth.record({
      userId,
      eventType: 'signup',
      ip: args.ip,
      userAgent: args.userAgent,
    });

    await this.dispatchVerificationMail(userId, args.email, verificationToken);

    return {
      userId,
      householdId,
      email: args.email,
      ...(this.returnVerificationToken ? { verificationToken } : {}),
    };
  }

  // Assembles the four rows in memory with no I/O: mints the ids and token, hashes the token and stamps the approval
  // status.
  private buildSignupRows(args: SignupArgs): {
    rows: {
      reservation: EmailReservationRow;
      user: UserRow;
      credential: CredentialRow;
      verification: EmailVerificationRow;
    };
    verificationToken: string;
    userId: string;
    householdId: string;
  } {
    const userId = randomUUID();
    const householdId = userId; // 1:1 in v1
    const emailLowercase = args.email.toLowerCase();
    const verificationToken = randomBytes(32).toString('base64url');
    // Hash at the service boundary: only the SHA-256 hash is stored, so an operator reading the table sees no
    // usable token.
    const tokenHash = sha256(verificationToken);
    const now = new Date().toISOString();
    const nowSec = Math.floor(Date.now() / 1000);
    const signupExpiresAt = nowSec + SIGNUP_EXPIRY_SEC;

    // Owner signups are auto-approved; foreign signups are pending until the approval mail fires after email
    // verification.
    const approvalStatus: UserRow['approvalStatus'] = this.approval.isOwnerEmail(args.email)
      ? 'auto_approved'
      : 'pending';

    const user: UserRow = {
      userId,
      email: args.email,
      emailLowercase,
      householdId,
      emailVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
      signupExpiresAt,
      currentVerificationToken: tokenHash,
      lastVerificationSentAt: now,
      verificationsSentDayKey: Math.floor(nowSec / 86400),
      verificationsSentToday: 1,
      approvalStatus,
      // Write all three unconditionally so a recycled-row re-signup never inherits stale values.
      firstName: args.firstName,
      lastName: args.lastName,
      birthdate: args.birthdate,
    };
    const reservation: EmailReservationRow = {
      emailLowercase,
      userId,
      reservedAt: now,
    };
    const credential: CredentialRow = {
      userId,
      argon2Hash: args.passwordHash,
      updatedAt: now,
      // A fresh opaque revision: every credential write mints one.
      credentialRevision: randomUUID(),
    };
    const verification: EmailVerificationRow = {
      verificationToken: tokenHash,
      userId,
      email: args.email,
      createdAt: now,
      expiresAt: nowSec + VERIFICATION_TTL_SEC,
      // The discriminator lets the verify-email consume accept this and a change-email confirm reject it; legacy rows
      // with no purpose are still accepted during rollout.
      purpose: 'verify_email',
    };

    return {
      rows: { reservation, user, credential, verification },
      verificationToken,
      userId,
      householdId,
    };
  }

  // Post-commit mail, best-effort: failures are logged (fingerprint and reason only, never the token); callers can use
  // /auth/resend-verification.
  private async dispatchVerificationMail(
    userId: string,
    email: string,
    verificationToken: string,
  ): Promise<void> {
    try {
      await this.verification.sendVerificationMail(email, verificationToken);
    } catch (err) {
      this.logger.warn(
        {
          userId,
          emailFingerprint: emailFingerprint(email),
          // Error class only, never `err.message`: an SES rejection embeds the recipient address.
          reason: err instanceof Error ? err.name : 'unknown',
        },
        'Verification mail dispatch failed',
      );
    }
  }

  // If the reservation points to an unverified user whose window elapsed, deletes every related row in one transaction.
  // True iff it recycled.
  private async tryRecycleExpiredSignup(email: string): Promise<boolean> {
    const emailLowercase = email.toLowerCase();
    const resGet = await this.doc.send(
      new GetCommand({
        TableName: this.emailReservationTable,
        Key: { emailLowercase },
      }),
    );
    const reservation = resGet.Item as EmailReservationRow | undefined;
    if (!reservation) return false;

    const userGet = await this.doc.send(
      new GetCommand({
        TableName: this.userTable,
        Key: { userId: reservation.userId },
      }),
    );
    const user = userGet.Item as UserRow | undefined;
    if (!user) {
      // Orphaned reservation: drop it so the email frees up.
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.emailReservationTable,
                Key: { emailLowercase },
                ConditionExpression: 'userId = :u',
                ExpressionAttributeValues: { ':u': reservation.userId },
              },
            },
          ],
        }),
      );
      return true;
    }

    if (user.emailVerifiedAt) return false; // verified accounts are never recycled
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = user.signupExpiresAt ?? 0;
    if (expiresAt > nowSec) return false; // still inside the signup window

    const transactItems: NonNullable<
      ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
    > = [
      {
        Delete: {
          TableName: this.emailReservationTable,
          Key: { emailLowercase },
          ConditionExpression: 'userId = :u',
          ExpressionAttributeValues: { ':u': user.userId },
        },
      },
      {
        Delete: {
          TableName: this.userTable,
          Key: { userId: user.userId },
          ConditionExpression: 'attribute_not_exists(emailVerifiedAt) OR emailVerifiedAt = :null',
          ExpressionAttributeValues: { ':null': null },
        },
      },
      {
        Delete: {
          TableName: this.credentialTable,
          Key: { userId: user.userId },
        },
      },
    ];
    if (user.currentVerificationToken) {
      transactItems.push({
        Delete: {
          TableName: this.emailVerificationTable,
          Key: { verificationToken: user.currentVerificationToken },
        },
      });
    }
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: transactItems }));
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        // Lost a race (verified since, or already recycled).
        return false;
      }
      throw err;
    }

    // Defensive sweep of approval rows for the recycled user; recycle only fires on unverified users, so none
    // should exist.
    await this.approvals.deleteAllForUser(user.userId);

    await this.auth.record({
      userId: user.userId,
      eventType: 'signup_expired_cleanup',
    });
    return true;
  }

  static hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }
}
