// Owner-approval gate: dispatches the approval mail, and consumes approve and decline tokens each in one atomic transaction;
// `cascadeDeleteUser` serves the TTL cascade. See docs/security.md, "Sign-up".
import { formatMailSource } from './mail-source.js';
import {
  BadRequestException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { randomBytes } from 'node:crypto';
import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { runTransactWrite, TransientTransactionError } from '../dynamo/transact-write.js';
import { DYNAMO_DOC_CLIENT, SES_CLIENT } from '../aws/aws.module.js';
import { SignupApprovalsRepository } from '../dynamo/signup-approvals.repository.js';
import { sha256 } from './refresh-token.service.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { EnvConfig } from '../common/env.config.js';
import type { SignupApprovalRow } from '../dynamo/types.js';
import { emailFingerprint } from '../common/email-fingerprint.js';
import { escapeHtml } from '../common/escape-html.js';

// Long enough for an owner on vacation.
const APPROVAL_TTL_SEC = 7 * 24 * 60 * 60;

@Injectable()
export class SignupApprovalService {
  private readonly logger = new Logger(SignupApprovalService.name);
  private readonly fromAddress: string;
  private readonly approverEmail: string;
  private readonly webOrigin: string;
  private readonly sesEnabled: boolean;
  private readonly userTable: string;
  private readonly credentialTable: string;
  private readonly emailReservationTable: string;
  private readonly approvalTable: string;

  constructor(
    @Inject(SES_CLIENT) private readonly ses: SESClient,
    @Inject(DYNAMO_DOC_CLIENT) private readonly doc: DynamoDBDocumentClient,
    private readonly approvals: SignupApprovalsRepository,
    private readonly users: UsersRepository,
    private readonly auth: AuthEventsRepository,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.fromAddress = config.get('SES_FROM_ADDRESS', { infer: true });
    this.approverEmail =
      config.get('APPROVER_EMAIL', { infer: true }) ?? this.fromAddress;
    this.webOrigin = config.get('WEB_ORIGIN', { infer: true });
    const node = config.get('NODE_ENV', { infer: true });
    this.sesEnabled =
      node === 'production' || !!config.get('SES_ENDPOINT', { infer: true });
    this.userTable = config.get('TABLE_USER', { infer: true });
    this.credentialTable = config.get('TABLE_CREDENTIAL', { infer: true });
    this.emailReservationTable = config.get('TABLE_EMAIL_RESERVATION', { infer: true });
    this.approvalTable = config.get('TABLE_SIGNUP_APPROVAL', { infer: true });
  }

  isOwnerEmail(email: string): boolean {
    return email.trim().toLowerCase() === this.approverEmail.trim().toLowerCase();
  }

  /**
   * Issues a fresh approval token for a verified-but-pending user and mails the owner; pure issue and dispatch, with
   * the policy decided by the caller.
   */
  async requestApproval(args: {
    userId: string;
    email: string;
    firstName?: string;
    lastName?: string;
  }): Promise<{ approvalToken: string }> {
    const approvalToken = randomBytes(32).toString('base64url');
    // Hash at the service boundary: only the SHA-256 digest is stored under the PK, so table read access reveals no
    // usable approval link.
    const approvalTokenHash = sha256(approvalToken);
    const now = new Date().toISOString();
    const nowSec = Math.floor(Date.now() / 1000);
    const row: SignupApprovalRow = {
      approvalToken: approvalTokenHash,
      userId: args.userId,
      email: args.email,
      createdAt: now,
      expiresAt: nowSec + APPROVAL_TTL_SEC,
    };
    await this.approvals.insert(row);

    await this.auth.record({
      userId: args.userId,
      eventType: 'signup_approval_requested',
    });

    // Best-effort SES dispatch: a failure leaves a usable token on the row.
    try {
      await this.sendApprovalMail(args.email, approvalToken, {
        firstName: args.firstName,
        lastName: args.lastName,
      });
    } catch (err) {
      this.logger.warn(
        {
          userId: args.userId,
          emailFingerprint: emailFingerprint(args.email),
          // Error class only, never `err.message`: an SES rejection embeds the recipient address, which `redact` cannot
          // scrub inside a string.
          reason: err instanceof Error ? err.name : 'unknown',
        },
        'Approval mail dispatch failed',
      );
    }
    return { approvalToken };
  }

  /**
   * Consumes a token via approve: one transaction conditionally deletes the approval row and flips an existing
   * pending user to approved, so a crash cannot approve a user while leaving a live link and a concurrent approve and
   * decline settle on one terminal state. Audit and the notification mail run only after commit.
   */
  async approve(token: string): Promise<{ userId: string; email: string }> {
    const row = await this.loadAndValidate(token);
    const userUpdate = this.users.approveSignupUpdate(row.userId);
    try {
      await runTransactWrite(
        this.doc,
        [
          {
            // Delete by the stored digest key, never the raw presented token.
            Delete: {
              TableName: this.approvalTable,
              Key: { approvalToken: row.approvalToken },
              ConditionExpression: 'attribute_exists(approvalToken)',
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
        () => {
          // The token was consumed concurrently or the user is no longer pending: reuse the approval-conflict response;
          // no live account is touched.
          throw new BadRequestException({
            code: 'APPROVAL_TOKEN_INVALID',
            message: 'Approval link is invalid or has already been used.',
          });
        },
      );
    } catch (err) {
      if (err instanceof TransientTransactionError) {
        throw new ServiceUnavailableException({
          code: 'APPROVAL_WRITE_CONFLICT',
          message: 'Could not process the approval right now. Try again.',
        });
      }
      throw err;
    }
    await this.auth.record({
      userId: row.userId,
      eventType: 'signup_approved',
    });
    await this.sendApprovedNotificationMail(row.userId, row.email);
    return { userId: row.userId, email: row.email };
  }

  // Best-effort "you are approved" notice. The user lookup and the SES send share one try/catch, so neither a read
  // failure nor an SES outage can bubble into `approve()`, which has already committed. The first name is
  // attacker-controlled signup input, so it always goes through `escapeHtml`; the catch logs
  // `emailFingerprint(email)`, not the recipient.
  private async sendApprovedNotificationMail(
    userId: string,
    recipientEmail: string,
  ): Promise<void> {
    const loginLink = `${this.webOrigin}/login`;
    try {
      const user = await this.users.findById(userId);
      const firstName = user?.firstName?.trim();
      const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

      if (!this.sesEnabled) {
        this.logger.log(
          { emailFingerprint: emailFingerprint(recipientEmail), loginLink },
          'Approved-notification generated (local dev)',
        );
        return;
      }

      await this.ses.send(
        new SendEmailCommand({
          Source: formatMailSource(this.fromAddress),
          Destination: { ToAddresses: [recipientEmail] },
          Message: {
            Subject: { Data: 'Your Retivo account is approved' },
            Body: {
              Text: {
                Data:
                  `${greeting}\n\n` +
                  `Your account has been approved — you can now sign in to ` +
                  `Retivo.\n\n` +
                  `Sign in:\n${loginLink}\n`,
              },
              Html: {
                Data:
                  `<p>${escapeHtml(greeting)}</p>` +
                  `<p>Your account has been approved — you can now sign in to ` +
                  `Retivo.</p>` +
                  `<p><a href="${escapeHtml(loginLink)}">Sign in</a></p>`,
              },
            },
          },
        }),
      );
    } catch (err) {
      this.logger.warn(
        {
          userId,
          emailFingerprint: emailFingerprint(recipientEmail),
          reason: err instanceof Error ? err.name : 'unknown',
        },
        'Approved-notification mail dispatch failed',
      );
    }
  }

  /**
   * Consumes a token via decline: one four-item transaction deletes the approval row, User, Credential and
   * EmailReservation (the User delete conditioned on pending or declined), with no intermediate declined write. A
   * concurrent approve either wins (this decline fails with 400 APPROVAL_TOKEN_INVALID, no live account touched) or
   * loses. If the user is already gone, the orphaned approval row is dropped and the email returned idempotently. The
   * cascade Lambda ignores the stream event, since it handles TTL deletes only.
   */
  async decline(token: string): Promise<{ email: string }> {
    const row = await this.loadAndValidate(token);
    // Strongly consistent: a stale null here takes the early exit that deletes the approval token outside the
    // cascade, orphaning the pending rows with no retry handle and no TTL-cascade trigger.
    const user = await this.users.findByIdConsistent(row.userId);
    if (!user) {
      // Already gone (an earlier decline or expiry cascade won): drop the orphaned approval row and report the email
      // idempotently.
      await this.approvals.deleteToken(row.approvalToken).catch(() => undefined);
      return { email: row.email };
    }

    // The user delete is conditioned on pending or declined, so a concurrent approve settles the state and this
    // decline refuses rather than trash a live account.
    try {
      await runTransactWrite(
        this.doc,
        [
          {
            Delete: {
              TableName: this.approvalTable,
              Key: { approvalToken: row.approvalToken },
              ConditionExpression: 'attribute_exists(approvalToken)',
            },
          },
          ...this.cascadeDeleteItems(user),
        ],
        () => {
          // Approved between load and commit (or already swept): refuse rather than delete a live user.
          throw new BadRequestException({
            code: 'APPROVAL_TOKEN_INVALID',
            message: 'Approval link is invalid or has already been used.',
          });
        },
      );
    } catch (err) {
      if (err instanceof TransientTransactionError) {
        throw new ServiceUnavailableException({
          code: 'APPROVAL_WRITE_CONFLICT',
          message: 'Could not process the decline right now. Try again.',
        });
      }
      throw err;
    }

    await this.auth.record({
      userId: row.userId,
      eventType: 'signup_declined',
      metadata: { householdId: user.householdId },
    });

    // Best-effort sweep of redundant approval rows for the now-nonexistent user.
    await this.approvals.deleteAllForUser(row.userId).catch(() => undefined);

    return { email: row.email };
  }

  /**
   * Cascade-deletes the unapproved signup sub-graph (User, Credential, EmailReservation, remaining approval rows) for
   * the TTL-expiry cascade in `signup-cascade-lambda.ts`. The User delete requires pending or declined, so an owner
   * approval racing the TTL cannot lose the account. Every Delete is conditional, so replays are idempotent.
   */
  async cascadeDeleteUser(args: {
    userId: string;
    reason: 'declined' | 'expired';
  }): Promise<{ deleted: boolean }> {
    const user = await this.users.findById(args.userId);
    if (!user) {
      // Nothing to cascade: an earlier replay won or /auth/account swept it.
      return { deleted: false };
    }

    // Refuse to run over an approved user rather than trash a live account.
    const status = user.approvalStatus ?? null;
    if (status !== 'pending' && status !== 'declined') {
      return { deleted: false };
    }

    const transactItems = this.cascadeDeleteItems(user);

    try {
      await this.doc.send(
        new TransactWriteCommand({ TransactItems: transactItems }),
      );
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        // Lost a race against an approve-then-login or another replay; benign.
        return { deleted: false };
      }
      throw err;
    }

    // Any unconsumed token is now meaningless; the trigger record was already deleted by the cascade Lambda caller.
    await this.approvals.deleteAllForUser(args.userId);

    await this.auth.record({
      userId: args.userId,
      eventType:
        args.reason === 'declined'
          ? 'signup_declined'
          : 'signup_approval_expired',
      metadata: { householdId: user.householdId },
    });
    return { deleted: true };
  }

  // The three cascade Deletes (EmailReservation still pointing at the user, User still pending or declined,
  // Credential), shared by `decline` and `cascadeDeleteUser` so there is one guard expression.
  private cascadeDeleteItems(user: {
    userId: string;
    emailLowercase: string;
  }): NonNullable<
    ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
  > {
    return [
      {
        Delete: {
          TableName: this.emailReservationTable,
          Key: { emailLowercase: user.emailLowercase },
          ConditionExpression: 'userId = :u',
          ExpressionAttributeValues: { ':u': user.userId },
        },
      },
      {
        Delete: {
          TableName: this.userTable,
          Key: { userId: user.userId },
          ConditionExpression:
            'attribute_exists(userId) AND (approvalStatus = :pending OR approvalStatus = :declined)',
          ExpressionAttributeValues: {
            ':pending': 'pending',
            ':declined': 'declined',
          },
        },
      },
      {
        Delete: {
          TableName: this.credentialTable,
          Key: { userId: user.userId },
        },
      },
    ];
  }

  // Composes and sends the approval mail; the token rides the URL fragment so it never reaches the SES log or the
  // recipient client. The owner sees the applicant name and email; the birthdate is deliberately omitted (PII).
  private async sendApprovalMail(
    applicantEmail: string,
    token: string,
    name: { firstName?: string; lastName?: string },
  ): Promise<void> {
    const approveLink = `${this.webOrigin}/auth/approve-signup#token=${encodeURIComponent(token)}`;
    const declineLink = `${this.webOrigin}/auth/decline-signup#token=${encodeURIComponent(token)}`;
    // `Jane Smith <jane@example.com>` when a name is present, else the bare email.
    const fullName = [name.firstName, name.lastName]
      .filter((part): part is string => !!part && part.trim().length > 0)
      .join(' ')
      .trim();
    const applicantLabel = fullName
      ? `${fullName} <${applicantEmail}>`
      : applicantEmail;
    if (!this.sesEnabled) {
      // Dev and test: no SES. The links and applicant label are not redactable inside a message string, so log a
      // fixed marker only.
      this.logger.log('approval_link_dev_mode_sent');
      return;
    }
    await this.ses.send(
      new SendEmailCommand({
        Source: formatMailSource(this.fromAddress),
        Destination: { ToAddresses: [this.approverEmail] },
        Message: {
          Subject: { Data: `Approve new account: ${applicantLabel}` },
          Body: {
            Text: {
              Data:
                `A new sign-up wants access to Retivo.\n\n` +
                `Applicant: ${applicantLabel}\n\n` +
                `Approve  (allow sign-in):\n${approveLink}\n\n` +
                `Decline  (delete the pending account):\n${declineLink}\n\n` +
                `If you do nothing, the request expires after 7 days and the ` +
                `pending account is deleted automatically.`,
            },
            Html: {
              Data:
                `<p>A new sign-up wants access to Retivo.</p>` +
                `<p><strong>Applicant:</strong> ${escapeHtml(applicantLabel)}</p>` +
                `<p><a href="${escapeHtml(approveLink)}">Approve (allow sign-in)</a></p>` +
                `<p><a href="${escapeHtml(declineLink)}">Decline (delete the pending account)</a></p>` +
                `<p>If you do nothing, the request expires after 7 days and the ` +
                `pending account is deleted automatically.</p>`,
            },
          },
        },
      }),
    );
  }

  private async loadAndValidate(token: string): Promise<SignupApprovalRow> {
    // Look up only by the digest: a legacy raw-token row never matches a 64-hex digest, so legacy links are
    // rejected and must be reissued.
    const tokenHash = sha256(token);
    const row = await this.approvals.findByToken(tokenHash);
    if (!row) {
      throw new BadRequestException({
        code: 'APPROVAL_TOKEN_INVALID',
        message: 'Approval link is invalid or has already been used.',
      });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (row.expiresAt < nowSec) {
      // Do not delete the expired row here: the cascade Lambda only processes TTL-attributed REMOVE events
      // (`isTtlDelete`) and skips application deletes, so deleting would permanently defeat the only cleanup trigger
      // for the pending User, Credential and EmailReservation. Leave it for the real TTL REMOVE; the 410 is correct
      // either way.
      throw new GoneException({
        code: 'APPROVAL_TOKEN_EXPIRED',
        message: 'Approval link has expired.',
      });
    }
    return row;
  }
}
