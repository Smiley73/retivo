// Guessing notice mailed to the address owner after 10 consecutive failures, at most once per 24h (atomic stamp). The SES call is not awaited
// and an unknown email takes the same path, so there is no latency or existence oracle.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { SES_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { emailFingerprint } from '../common/email-fingerprint.js';
import { escapeHtml } from '../common/escape-html.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { FailedLoginAttemptsRepository } from '../dynamo/failed-login-attempts.repository.js';
import type { UserRow } from '../dynamo/types.js';
import { formatMailSource } from './mail-source.js';
import { formatUtcTimestamp } from './login-guessing-notice-mail.js';

// By the 10th consecutive failure the derived wait is capped at 64 s: unambiguous guessing.
const GUESSING_NOTICE_THRESHOLD = 10;
// Once-per-24h window, mirroring the `FailedLoginAttempt` row TTL.
const GUESSING_NOTICE_WINDOW_SEC = 24 * 60 * 60;
const SUBJECT = 'Failed sign-in attempts on your Retivo account';

@Injectable()
export class LoginGuessingNoticeService {
  private readonly logger = new Logger(LoginGuessingNoticeService.name);
  private readonly fromAddress: string;
  private readonly sesEnabled: boolean;

  constructor(
    @Inject(SES_CLIENT) private readonly ses: SESClient,
    private readonly repo: FailedLoginAttemptsRepository,
    private readonly users: UsersRepository,
    private readonly auth: AuthEventsRepository,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.fromAddress = config.get('SES_FROM_ADDRESS', { infer: true });
    const node = config.get('NODE_ENV', { infer: true });
    this.sesEnabled = node === 'production' || !!config.get('SES_ENDPOINT', { infer: true });
  }

  /**
   * Called after every per-address increment. Below the threshold it is a no-op; at or above it gates on the atomic
   * 24h stamp, then resolves the account. An unknown email follows the identical shape and resolves to nothing (no
   * mail, no user-linked audit).
   */
  async notifyIfNeeded(
    emailLowercase: string,
    consecutiveFailures: number,
    ip: string | null,
    userAgent: string | null,
  ): Promise<void> {
    if (consecutiveFailures < GUESSING_NOTICE_THRESHOLD) return;
    const stamped = await this.repo.stampGuessingNotice(
      emailLowercase,
      GUESSING_NOTICE_WINDOW_SEC,
    );
    if (!stamped) return;
    const user = await this.users.findByEmail(emailLowercase);
    if (!user) return;
    await this.auth.record({
      userId: user.userId,
      eventType: 'login_guessing_notice_sent',
      ip,
      userAgent,
    });
    // Fire-and-forget so the failed-login response does not wait on SES; its own catch logs a fingerprint and error
    // name only.
    this.dispatchMail(user).catch((err) => {
      this.logger.warn(
        'Guessing-notice mail dispatch failed (best-effort)',
        { emailFingerprint: emailFingerprint(user.email), reason: err instanceof Error ? err.name : 'unknown' },
      );
    });
  }

  private async dispatchMail(user: UserRow): Promise<void> {
    if (!this.sesEnabled) {
      this.logger.log(
        { emailFingerprint: emailFingerprint(user.email) },
        'Guessing notice generated (local dev)',
      );
      return;
    }
    // Composed inline so the HTML mail-escaping regression guard can see this interpolation.
    const when = formatUtcTimestamp(new Date());
    await this.ses.send(
      new SendEmailCommand({
        Source: formatMailSource(this.fromAddress),
        Destination: { ToAddresses: [user.email] },
        Message: {
          Subject: { Data: SUBJECT },
          Body: {
            Text: {
              Data:
                `Someone entered the wrong password for your Retivo account several times. ` +
                `The most recent attempt was on ${when}.\n\n` +
                `If that was you, you can ignore this — signing in with the right password clears it.\n\n` +
                `If it wasn't you, reset your password from the sign-in page ("Forgot your password?") ` +
                `and pick one you use nowhere else. Your saved data stays encrypted either way: a ` +
                `password alone does not unlock it.\n\n` +
                `We send this at most once a day, even if the attempts continue.`,
            },
            Html: {
              Data:
                `<p>Someone entered the wrong password for your Retivo account several times. ` +
                `The most recent attempt was on ${escapeHtml(when)}.</p>` +
                `<p>If that was you, you can ignore this — signing in with the right password clears it.</p>` +
                `<p>If it wasn't you, reset your password from the sign-in page ("Forgot your password?") ` +
                `and pick one you use nowhere else. Your saved data stays encrypted either way: a ` +
                `password alone does not unlock it.</p>` +
                `<p>We send this at most once a day, even if the attempts continue.</p>`,
            },
          },
        },
      }),
    );
  }
}
