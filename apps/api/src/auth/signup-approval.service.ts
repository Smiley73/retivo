/**
 * Owner-approval gate. Three responsibilities:
 *
 *   1. Dispatch the approval mail to APPROVER_EMAIL when somebody other
 *      than the owner finishes verifying their email. Called by
 *      EmailVerificationService.consumeToken once the verification flips.
 *   2. Consume an approval token via approve / decline, each as ONE atomic
 *      transaction. Approve conditionally deletes the token row AND flips
 *      User.approvalStatus pending → approved together. Decline tears the
 *      user-row sub-graph down directly (token + User + Credential +
 *      EmailReservation in one four-item transaction) with no intermediate
 *      'declined' write.
 *   3. Provide a shared `cascadeDeleteUser` for the TTL-expiry cascade (the
 *      decline path runs its own inline transaction and no longer routes
 *      through it). Idempotent — replays after a partial-success retry hit
 *      "row already gone" branches gracefully.
 *
 * The owner is identified by the APPROVER_EMAIL env var, which falls
 * back to SES_FROM_ADDRESS when unset (single-var deployments). Compare
 * is always case-insensitive.
 *
 * See docs/security.md, "Sign-up".
 */
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

/** Approval token TTL — long enough for an owner on vacation. */
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

  /** Lowercase string-compare against APPROVER_EMAIL. */
  isOwnerEmail(email: string): boolean {
    return email.trim().toLowerCase() === this.approverEmail.trim().toLowerCase();
  }

  /**
   * Issue a fresh approval token for a verified-but-pending user and
   * mail the owner. Caller (EmailVerificationService) is responsible for
   * deciding whether the user qualifies — this method is pure issue +
   * dispatch, no policy.
   */
  async requestApproval(args: {
    userId: string;
    email: string;
    firstName?: string;
    lastName?: string;
  }): Promise<{ approvalToken: string }> {
    const approvalToken = randomBytes(32).toString('base64url');
    // Hash at the service boundary:
    // only the SHA-256 digest is stored under the `approvalToken` PK; the raw
    // token rides the owner's mail link (and, in dev/test, the response) and is
    // never persisted or logged. Read access to the table therefore reveals no
    // usable approval link. Mirrors PasswordResetService's hash-at-rest pattern.
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

    // Best-effort SES dispatch — a delivery failure leaves a usable
    // token on the row, and the user / owner can re-request via the
    // resend path (out of scope for v1; today the user re-signs up
    // after the 7d TTL).
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
          // Error class only, never `err.message`: an SES rejection embeds the
          // raw recipient address in its message, which `redact` cannot scrub
          // inside a string value. Matches the `Approved-notification` log.
          reason: err instanceof Error ? err.name : 'unknown',
        },
        'Approval mail dispatch failed',
      );
    }
    return { approvalToken };
  }

  /**
   * Consume a token via the approve path.
   * A single atomic transaction conditionally deletes the presented approval
   * row AND flips an existing `approvalStatus = pending` user to `approved` —
   * both commit or neither does, so a crash/timeout can't approve a user while
   * leaving a live approval link (or vice-versa), and a concurrent approve/
   * decline settles on exactly one terminal state. Post-commit side effects
   * (audit, approved-notification mail) run
   * ONLY after the transaction commits, in their existing order.
   */
  async approve(token: string): Promise<{ userId: string; email: string }> {
    const row = await this.loadAndValidate(token);
    const userUpdate = this.users.approveSignupUpdate(row.userId);
    try {
      await runTransactWrite(
        this.doc,
        [
          {
            // Delete by the stored digest key (`row.approvalToken` is the
            // SHA-256 hash), never the raw presented token.
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
          // A ConditionalCheckFailed on either item: the token was consumed
          // concurrently, or the user is no longer pending (raced with a
          // decline / already approved). Reuse the existing approval-conflict
          // response — no live account is touched.
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

  /**
   * Best-effort "you're approved" notice to the freshly-approved user,
   * with a link to the login page. Wholly self-contained: the user-row
   * lookup (to personalise with the first name) AND the SES send both
   * live inside this method's single try/catch, so neither a DynamoDB
   * read failure nor an SES outage can ever bubble into `approve()` —
   * the approval itself has already committed by the time we get here.
   *
   *   - User row found with a first name → "Hi <firstName>,".
   *   - User row absent (deleted in a race) → generic "Hi," — degraded,
   *     not skipped.
   *   - `findById` throws → caught + logged, no mail sent.
   *
   * The first name is attacker-controlled signup input, so it is always
   * routed through `escapeHtml(...)` before it lands in the HTML body.
   * The catch logs `emailFingerprint(email)` rather than the
   * raw recipient so no PII reaches CloudWatch.
   */
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
   * Consume a token via the decline path.
   * Tears the pending signup down in ONE atomic four-item transaction: the
   * presented approval row plus the User, Credential, and EmailReservation rows
   * are deleted together (the User delete conditioned on `approvalStatus` still
   * being pending/declined). There is NO intermediate `declined` status write —
   * the account is removed directly, so a concurrent approve either wins (this
   * decline's condition then fails → `400 APPROVAL_TOKEN_INVALID`, no live
   * account touched) or loses (its own condition fails). When the user row is
   * already gone (an earlier decline/expiry cascade won), the orphaned approval
   * row is best-effort dropped and the applicant email is returned idempotently.
   * The DynamoDB stream still fires on the approval-row delete; the cascade
   * Lambda filters for TTL-driven deletes only and ignores it.
   */
  async decline(token: string): Promise<{ email: string }> {
    const row = await this.loadAndValidate(token);
    // Strongly-consistent read: a null here takes the early-exit branch
    // that deletes the approval token OUTSIDE the atomic cascade. An
    // eventually-consistent stale miss on a user that actually still exists
    // would drop the only decline/approve retry handle and leave the pending
    // User/Credential/EmailReservation rows orphaned with no TTL-cascade
    // trigger. The consistent lookup makes the absence authoritative.
    const user = await this.users.findByIdConsistent(row.userId);
    if (!user) {
      // The user is already gone (an earlier decline/expiry cascade won). The
      // presented approval row is orphaned — best-effort drop it and report the
      // applicant email idempotently.
      await this.approvals.deleteToken(row.approvalToken).catch(() => undefined);
      return { email: row.email };
    }

    // One atomic transaction: delete the
    // presented approval row plus the pending user, credential, and email
    // reservation together. The user delete is conditioned on the account still
    // being pending/declined, so a concurrent approve settles the state and this
    // decline refuses rather than trashing a live account.
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
          // ConditionalCheckFailed: the account was approved between load and
          // commit (or already swept) — refuse rather than delete a live user.
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

    // Best-effort sweep of any redundant approval rows for this user — the user
    // no longer exists, so they cannot approve or recreate it.
    await this.approvals.deleteAllForUser(row.userId).catch(() => undefined);

    return { email: row.email };
  }

  /**
   * Cascade-delete the user-row sub-graph for an unapproved signup.
   *   - User row (must still be in pending or declined state — guards
   *     against a race where the owner approves on one tab and TTL
   *     fires moments later on another).
   *   - Credential row.
   *   - EmailReservation row.
   *   - Any remaining approval rows for the same user.
   *
   * The TTL-expiry cascade path (apps/api/src/signup-cascade-lambda.ts). The
   * decline endpoint no longer routes through this shared helper — it runs its
   * own inline four-item transaction that also consumes the presented token
   * (see {@link decline}). Idempotent — every Delete is conditional so replays
   * after a partial-success retry don't trip on "row already gone".
   */
  async cascadeDeleteUser(args: {
    userId: string;
    reason: 'declined' | 'expired';
  }): Promise<{ deleted: boolean }> {
    const user = await this.users.findById(args.userId);
    if (!user) {
      // Nothing to cascade — either an earlier replay won, or the user
      // was already swept by /auth/account.
      return { deleted: false };
    }

    // Guard against running over an approved user. If somebody hits the
    // decline link after they've already been approved (link races, owner
    // changes their mind too late), we refuse rather than trash a live
    // account.
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
        // Lost a race against an approve-then-login or another cascade
        // replay. Both are benign.
        return { deleted: false };
      }
      throw err;
    }

    // Best-effort approval-row sweep — any unconsumed token for this
    // user is now meaningless. The trigger record itself is also one
    // of these rows; the cascade Lambda's caller already deleted it.
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

  /**
   * Build the three cascade Delete transaction-item parts for an unapproved
   * signup's user-row sub-graph — the `EmailReservation` (conditioned on it
   * still pointing at this user), the `User` (conditioned on the account still
   * being pending/declined, so a user approved between the caller's `findById`
   * and the commit is never trashed), and the `Credential`. Single-sourced so
   * {@link decline} (which prepends its own approval-row Delete) and
   * {@link cascadeDeleteUser} share one guard expression + table set rather than
   * duplicating them. Mirrors the transaction-item builder pattern in
   * `users.repository.ts` (`approveSignupUpdate` / `markEmailVerifiedUpdate`).
   */
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

  /**
   * Compose + send the approval mail. Token rides in the URL fragment
   * so the SES log + the recipient client never
   * leak it onto the wire. Two clearly-labeled links: approve + decline.
   * The subject + body name the applicant (first + last + email) so the
   * owner can triage at a glance. Birthdate is deliberately NOT included
   * (PII).
   */
  private async sendApprovalMail(
    applicantEmail: string,
    token: string,
    name: { firstName?: string; lastName?: string },
  ): Promise<void> {
    const approveLink = `${this.webOrigin}/auth/approve-signup#token=${encodeURIComponent(token)}`;
    const declineLink = `${this.webOrigin}/auth/decline-signup#token=${encodeURIComponent(token)}`;
    // `Jane Smith <jane@example.com>` when a name is present; bare email
    // otherwise (old client / API-direct signup).
    const fullName = [name.firstName, name.lastName]
      .filter((part): part is string => !!part && part.trim().length > 0)
      .join(' ')
      .trim();
    const applicantLabel = fullName
      ? `${fullName} <${applicantEmail}>`
      : applicantEmail;
    if (!this.sesEnabled) {
      // Dev/test mode: no SES. The approve/decline links each carry a token,
      // and `applicantLabel` carries the applicant's name + email — none of
      // which is redactable inside a message string (`redact` masks by field
      // name, not string content). Drop them all; log a fixed marker only.
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
    // Hash the presented raw token and look up ONLY by its digest: a
    // legacy raw-token row (keyed by the 43-char base64url token itself) can
    // never match a 64-hex-char digest lookup, so legacy links are rejected as
    // invalid and must be reissued.
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
      // Do NOT proactively delete the expired row here. The household-cleanup
      // cascade (apps/api/src/signup-cascade-lambda.ts) only processes REMOVE
      // stream events attributed to DynamoDB's own TTL sweep — it explicitly
      // skips any REMOVE caused by an application-issued DeleteItem
      // (see isTtlDelete() / `if (!isTtlDelete(record)) continue;`). An
      // application delete here would therefore permanently defeat the only
      // cleanup trigger for the associated pending User/Credential/
      // EmailReservation rows, stranding them forever. Leave the row in place
      // and let DynamoDB's TTL sweep remove it via a real TTL-attributed REMOVE
      // event, which the cascade Lambda WILL process. The 410 below is correct
      // regardless of whether the row still physically exists.
      throw new GoneException({
        code: 'APPROVAL_TOKEN_EXPIRED',
        message: 'Approval link has expired.',
      });
    }
    return row;
  }
}
