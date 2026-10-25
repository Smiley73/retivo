// Email verification flow: dispatches the verification mail via SES and consumes the token to set `User.emailVerifiedAt`. See
// docs/security.md, "Sign-up".
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
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { EmailVerificationsRepository } from '../dynamo/email-verifications.repository.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { runTransactWrite, TransientTransactionError } from '../dynamo/transact-write.js';
import { DYNAMO_DOC_CLIENT, SES_CLIENT } from '../aws/aws.module.js';
import { sha256 } from './refresh-token.service.js';
import { SignupApprovalService } from './signup-approval.service.js';
import type { EnvConfig } from '../common/env.config.js';
import { emailFingerprint } from '../common/email-fingerprint.js';
import { escapeHtml } from '../common/escape-html.js';

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);
  private readonly fromAddress: string;
  private readonly webOrigin: string;
  private readonly sesEnabled: boolean;
  private readonly devShortcutEnabled: boolean;
  private readonly emailVerificationTable: string;

  constructor(
    @Inject(SES_CLIENT) private readonly ses: SESClient,
    @Inject(DYNAMO_DOC_CLIENT) private readonly doc: DynamoDBDocumentClient,
    private readonly verifications: EmailVerificationsRepository,
    private readonly users: UsersRepository,
    private readonly auth: AuthEventsRepository,
    private readonly approval: SignupApprovalService,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.fromAddress = config.get('SES_FROM_ADDRESS', { infer: true });
    this.webOrigin = config.get('WEB_ORIGIN', { infer: true });
    this.emailVerificationTable = config.get('TABLE_EMAIL_VERIFICATION', { infer: true });
    // Local dev and test skip the send; a set SES_ENDPOINT means a local emulator.
    const node = config.get('NODE_ENV', { infer: true });
    this.sesEnabled = node === 'production' || !!config.get('SES_ENDPOINT', { infer: true });
    // Same trapdoor as signup: local development only, refused at boot on a deployed stack.
    this.devShortcutEnabled =
      node !== 'production' ||
      config.get('EXPOSE_VERIFICATION_TOKEN', { infer: true }) === 'true';
  }

  async sendVerificationMail(toAddress: string, token: string): Promise<void> {
    // Token in the URL fragment, so it never reaches the server, access logs or Referer.
    const link = `${this.webOrigin}/auth/verify-email#token=${encodeURIComponent(token)}`;
    if (!this.sesEnabled) {
      // Dev and test: never interpolate the token or recipient into a log message, since `redact` masks by field
      // name, not string content. Log a fixed marker.
      this.logger.log('verification_link_dev_mode_sent');
      return;
    }
    await this.ses.send(
      new SendEmailCommand({
        Source: formatMailSource(this.fromAddress),
        Destination: { ToAddresses: [toAddress] },
        Message: {
          Subject: { Data: 'Verify your email' },
          Body: {
            Text: {
              Data:
                `Welcome! Please verify your email by visiting the link below ` +
                `(valid for 15 minutes):\n\n${link}\n\n` +
                `If the link expires before you click it, request a new one ` +
                `from the sign-in page.\n\nIf you didn't sign up, ignore this message.`,
            },
            Html: {
              Data:
                `<p>Welcome! Please verify your email by visiting the link below ` +
                `(valid for 15 minutes):</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` +
                `<p>If the link expires before you click it, request a new one ` +
                `from the sign-in page.</p>` +
                `<p>If you didn't sign up, ignore this message.</p>`,
            },
          },
        },
      }),
    );
  }

  async consumeToken(
    token: string,
  ): Promise<{ userId: string; approvalToken?: string }> {
    // Hash once at the boundary and use the hash for every DynamoDB key.
    const tokenHash = sha256(token);
    const row = await this.verifications.findByToken(tokenHash);
    if (!row) {
      throw new BadRequestException({
        code: 'VERIFICATION_TOKEN_INVALID',
        message: 'Verification token is invalid or already used.',
      });
    }
    // Reject a `change_email` token here so the flows never cross-consume; do not delete it, it belongs to the live
    // change-email flow.
    if (row.purpose === 'change_email') {
      throw new BadRequestException({
        code: 'VERIFICATION_TOKEN_INVALID',
        message: 'Verification token is invalid or already used.',
      });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (row.expiresAt < nowSec) {
      await this.verifications.deleteToken(tokenHash);
      throw new GoneException({
        code: 'VERIFICATION_TOKEN_EXPIRED',
        message: 'Verification token has expired. Request a new one.',
      });
    }
    const verifiedAt = new Date().toISOString();
    // Atomic single-use consume: one transaction deletes the hashed token row and marks the user whose
    // `currentVerificationToken` matches, so a superseded token writes nothing. Audit and approval request run
    // after commit.
    const userUpdate = this.users.markEmailVerifiedUpdate(row.userId, verifiedAt, tokenHash);
    try {
      await runTransactWrite(
        this.doc,
        [
          {
            Delete: {
              TableName: this.emailVerificationTable,
              Key: { verificationToken: tokenHash },
              ConditionExpression: 'attribute_exists(verificationToken)',
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
          // A superseded or consumed token, or a moved handle: reuse the stale-token response with no writes.
          throw new BadRequestException({
            code: 'VERIFICATION_TOKEN_INVALID',
            message: 'Verification token is invalid or already used.',
          });
        },
      );
    } catch (err) {
      if (err instanceof TransientTransactionError) {
        throw new ServiceUnavailableException({
          code: 'VERIFICATION_WRITE_CONFLICT',
          message: 'Could not verify your email right now. Try again.',
        });
      }
      throw err;
    }
    await this.auth.record({
      userId: row.userId,
      eventType: 'email_verify',
    });

    // Load the user fresh and, if still pending, dispatch the approval mail. A failure is logged in the service and
    // does not fail the verify.
    const user = await this.users.findById(row.userId);

    let approvalToken: string | undefined;
    if (user && user.approvalStatus === 'pending') {
      try {
        const issued = await this.approval.requestApproval({
          userId: row.userId,
          email: row.email,
          firstName: user.firstName,
          lastName: user.lastName,
        });
        approvalToken = issued.approvalToken;
      } catch (err) {
        this.logger.warn(
          {
            userId: row.userId,
            emailFingerprint: emailFingerprint(row.email),
            // Error class only, never `err.message`: an SES rejection embeds the recipient address.
            reason: err instanceof Error ? err.name : 'unknown',
          },
          'Approval-mail request failed',
        );
      }
    }
    return {
      userId: row.userId,
      // The raw approvalToken is surfaced only under the dev trapdoor (`EXPOSE_VERIFICATION_TOKEN`, local only), so
      // VerifyEmailPage can offer an approve shortcut.
      ...(approvalToken && this.devShortcutEnabled
        ? { approvalToken }
        : {}),
    };
  }
}
