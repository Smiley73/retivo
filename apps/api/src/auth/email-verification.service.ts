/**
 * Email verification flow. Two responsibilities: dispatching the
 * verification mail via SES and consuming the token to flip
 * `User.emailVerifiedAt`.
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
    // Local dev / test: skip the actual send. SES_ENDPOINT being set
    // signals we want to talk to a local emulator instead.
    const node = config.get('NODE_ENV', { infer: true });
    this.sesEnabled = node === 'production' || !!config.get('SES_ENDPOINT', { infer: true });
    // Same trapdoor used by signup / resend-verification. Local development only — refused at boot
    // on any deployed stack, which all run NODE_ENV=production.
    this.devShortcutEnabled =
      node !== 'production' ||
      config.get('EXPOSE_VERIFICATION_TOKEN', { infer: true }) === 'true';
  }

  async sendVerificationMail(toAddress: string, token: string): Promise<void> {
    // Token lives in the URL fragment (#) so it never leaves the
    // browser — fragments are not sent in HTTP requests, never logged
    // by API Gateway / CloudFront, and never appear in Referer headers
    // on subsequent navigation.
    const link = `${this.webOrigin}/auth/verify-email#token=${encodeURIComponent(token)}`;
    if (!this.sesEnabled) {
      // Dev/test mode: no SES. The raw token + recipient email must never be
      // interpolated into a log message — `redact` masks by field name, not
      // message-string content, so a value baked into the string can't be
      // masked. `devShortcutEnabled` already returns the same token in the API
      // response for local click-through, so the link here is redundant. Log a
      // fixed, argument-free marker only.
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
    // The URL carries the raw token; the table stores its SHA-256 hash. Hash once at the boundary
    // and use the hash for every DynamoDB key (lookup + both cleanup deletes).
    const tokenHash = sha256(token);
    const row = await this.verifications.findByToken(tokenHash);
    if (!row) {
      throw new BadRequestException({
        code: 'VERIFICATION_TOKEN_INVALID',
        message: 'Verification token is invalid or already used.',
      });
    }
    // Purpose discriminator: signup
    // verify-email accepts `verify_email` and legacy absent-purpose rows, but
    // must reject a `change_email` token so the two flows never cross-consume.
    // A `change_email` token presented here is treated as invalid (do NOT
    // delete it — it still belongs to the live change-email flow).
    if (row.purpose === 'change_email') {
      throw new BadRequestException({
        code: 'VERIFICATION_TOKEN_INVALID',
        message: 'Verification token is invalid or already used.',
      });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (row.expiresAt < nowSec) {
      // Best-effort cleanup; TTL handles eventual consistency too.
      await this.verifications.deleteToken(tokenHash);
      throw new GoneException({
        code: 'VERIFICATION_TOKEN_EXPIRED',
        message: 'Verification token has expired. Request a new one.',
      });
    }
    const verifiedAt = new Date().toISOString();
    // Atomic single-use consume: one
    // transaction conditionally deletes the hashed token row AND marks the
    // still-unverified user whose `currentVerificationToken` exactly matches
    // the presented digest — both commit or neither does. A stale/superseded
    // token (the handle already rotated or removed) fails the condition and
    // writes nothing. Post-commit side effects (audit, approval
    // request) run only after the transaction commits.
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
          // ConditionalCheckFailed: a superseded/already-consumed token, or the
          // user's verification handle moved. Reuse the existing stale-token
          // response with no writes.
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

    // Owner-approval gate: load the user fresh and, if they're still in
    // 'pending', dispatch the approval mail to APPROVER_EMAIL. Failure
    // here is logged inside the service and doesn't fail the verify
    // call — the user has done their part; the owner will get a fresh
    // mail next time the token is regenerated, or the lazy-recycle path
    // will reclaim the row.
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
            // Error class only, never `err.message`: an SES rejection embeds the
            // raw recipient address in its message, which `redact` cannot scrub
            // inside a string value.
            reason: err instanceof Error ? err.name : 'unknown',
          },
          'Approval-mail request failed',
        );
      }
    }
    return {
      userId: row.userId,
      // Surface the raw approvalToken in the response only when the same
      // dev trapdoor that returns the verification token is on
      // (`EXPOSE_VERIFICATION_TOKEN=true`, local development only —
      // refused at boot on any deployed stack). Lets the SPA's
      // VerifyEmailPage offer a "Dev
      // shortcut: approve" link so local dev works without a real SES
      // delivery to APPROVER_EMAIL.
      ...(approvalToken && this.devShortcutEnabled
        ? { approvalToken }
        : {}),
    };
  }
}
