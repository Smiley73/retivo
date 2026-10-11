/**
 * Signup orchestrator. Writes EmailReservation + User + Credential +
 * EmailVerification (four rows) in a single TransactWriteItems so concurrent
 * signup attempts on the same email cannot both succeed and account creation is
 * atomic. The transaction fails fast with EMAIL_TAKEN if the reservation already
 * exists.
 *
 * Unverified signups expire after `SIGNUP_EXPIRY_SEC`. On EMAIL_TAKEN,
 * if the existing reservation belongs to an unverified user whose
 * `signupExpiresAt` has elapsed, the row set is reclaimed in a single
 * TransactWrite and the new signup is retried once. Lazy cleanup keeps
 * the design infra-free (no scheduled Lambda, no GSI).
 *
 * SES dispatch happens *after* the transaction commits — a SES outage
 * leaves a verifiable user (callers can request another verification
 * mail via `/auth/resend-verification`).
 *
 * See docs/security.md, "Sign-up".
 */
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

/** Token-link validity. Aligned with the SES copy. */
export const VERIFICATION_TTL_SEC = 15 * 60;
/** Unverified-signup expiry. After this the email can be re-claimed. */
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
  /** Token only returned in dev/test contexts; never logged. */
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
    // Return the raw `verificationToken` in the signup response when
    // either gate allows it:
    //   1. NODE_ENV !== 'production' — local `pnpm dev` and Jest.
    //   2. EXPOSE_VERIFICATION_TOKEN === 'true' — the same local-only
    //      trapdoor, opt-in for a local run that sets NODE_ENV=production.
    //      Hard-refused at env validation on any deployed stack, so both
    //      gates are false in AWS (dev included).
    // Matches the gate used in email-verification.service.ts and
    // cookie-config.ts.
    this.returnVerificationToken =
      config.get('NODE_ENV', { infer: true }) !== 'production' ||
      config.get('EXPOSE_VERIFICATION_TOKEN', { infer: true }) === 'true';
  }

  /**
   * Create the user atomically. Caller is responsible for password
   * validation (PasswordValidatorService) before calling this.
   */
  async signup(args: SignupArgs): Promise<SignupResult> {
    const result = await this.tryInsert(args);
    if (result) return result;

    // EMAIL_TAKEN. If the prior signup is unverified + expired, recycle
    // the rows and retry exactly once. Anything else surfaces as 409.
    const recycled = await this.tryRecycleExpiredSignup(args.email);
    if (!recycled) {
      throw new ConflictException({
        code: 'EMAIL_TAKEN',
        message: 'An account with this email already exists.',
      });
    }
    const second = await this.tryInsert(args);
    if (second) return second;
    // Lost a race against a concurrent recycle/signup; surface the conflict.
    throw new ConflictException({
      code: 'EMAIL_TAKEN',
      message: 'An account with this email already exists.',
    });
  }

  /**
   * Single-shot insert. Returns null on transaction-cancel (i.e.
   * EMAIL_TAKEN); all other errors propagate.
   */
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

  /**
   * Assemble the four signup rows in memory — no database or mail I/O. Mints the
   * user/household ids + verification token, hashes the token at the service
   * boundary and stamps the owner-approval status. Returns the rows plus the
   * raw `verificationToken` (for the post-commit mail + the dev/test response)
   * and the minted ids.
   */
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
    // Hash at the service boundary: only the
    // SHA-256 hash is stored (User row + EmailVerification PK); the raw token
    // travels only in the email link (and the dev/test response). An operator
    // reading the table during an active verification window sees the hash,
    // not a usable token.
    const tokenHash = sha256(verificationToken);
    const now = new Date().toISOString();
    const nowSec = Math.floor(Date.now() / 1000);
    const signupExpiresAt = nowSec + SIGNUP_EXPIRY_SEC;

    // Owner-approval gate. Owner-signed-up flows are auto-approved
    // (no second-actor needed). Foreign signups land in 'pending' and
    // wait for the approval mail dispatch that fires once email is
    // verified — see EmailVerificationService.consumeToken.
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
      // Write all three unconditionally (undefined when absent) so a
      // recycled-row re-signup never inherits stale values from the
      // previous attempt.
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
      // Fresh opaque revision — every
      // credential write mints one.
      credentialRevision: randomUUID(),
    };
    const verification: EmailVerificationRow = {
      verificationToken: tokenHash,
      userId,
      email: args.email,
      createdAt: now,
      expiresAt: nowSec + VERIFICATION_TTL_SEC,
      // Stamp the discriminator so the
      // verify-email consume accepts this positively and a change-email
      // confirm rejects it. Legacy absent-purpose rows minted before this
      // field are still accepted by the verify-email consume during rollout.
      purpose: 'verify_email',
    };

    return {
      rows: { reservation, user, credential, verification },
      verificationToken,
      userId,
      householdId,
    };
  }

  /**
   * Post-commit verification mail. Best-effort send — failures are logged
   * (fingerprint + reason only, never the token) but not surfaced; callers
   * can request another mail via /auth/resend-verification.
   */
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
          // Error class only, never `err.message`: an SES rejection embeds the
          // raw recipient address in its message, which `redact` cannot scrub
          // inside a string value.
          reason: err instanceof Error ? err.name : 'unknown',
        },
        'Verification mail dispatch failed',
      );
    }
  }

  /**
   * If the existing reservation for this email points to an unverified
   * user whose signup window has elapsed, delete every related row in a
   * single transaction. Returns true iff the recycle happened.
   */
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
      // Orphaned reservation. Drop it so the email frees up.
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
        // Lost a race (verified-since, or another signup already recycled).
        return false;
      }
      throw err;
    }

    // Sweep any pending approval rows for the recycled user. Recycle
    // only fires on unverified users, which means no approval mail has
    // gone out yet — so this is a defensive no-op in practice. Still
    // worth doing in case the SignupApproval table accumulates stale
    // rows (e.g. a partially-completed prior cascade).
    await this.approvals.deleteAllForUser(user.userId);

    await this.auth.record({
      userId: user.userId,
      eventType: 'signup_expired_cleanup',
    });
    return true;
  }

  /** Helper: hash a plaintext password with argon2id. */
  static hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }
}
