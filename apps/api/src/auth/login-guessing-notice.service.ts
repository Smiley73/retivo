/**
 * Per-address guessing notice — the mail sent to the address's owner after
 * repeated failed sign-ins. Injected into `FailedLoginService` (the shared backoff primitive) so
 * every consumer of the per-address counter inherits it, but kept as its own
 * small service (owning SES + a users lookup + config) so the primitive
 * itself stays lean, mirroring `FactorNoticeService`.
 *
 * Threshold: 10 consecutive per-address failures — by then the derived wait
 * is already at its 64s cap, so it is unambiguous guessing, not a typo
 * streak. At most one notice per 24h, enforced by
 * `FailedLoginAttemptsRepository.stampGuessingNotice`'s atomic conditional
 * write (never a TOCTOU read-then-write here).
 *
 * Enumeration/latency: the notice
 * only ever sends for a real account, so the SES call is dispatched WITHOUT
 * being awaited — a real address must not become measurably slower at the
 * crossing attempt than an unknown one. An unknown email still pays the same
 * stamp-check + user-lookup shape before returning, so the code path is
 * identical up to that point.
 */
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

/** By the 10th consecutive per-address failure the derived wait is already
 *  capped at 64s — unambiguous guessing. */
const GUESSING_NOTICE_THRESHOLD = 10;
/** Once-per-24h window, mirroring the `FailedLoginAttempt` row's own TTL. */
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
   * Called from `FailedLoginService.recordFailure` after every per-address
   * increment. Below the threshold: no-op. At/above it: gate on the 24h
   * stamp (atomic — never sends twice for a race), then resolve the account.
   * An unknown email follows the identical stamp-check + lookup shape and
   * simply resolves to nothing (no mail, no user-linked audit record).
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
    // Fire-and-forget: the caller (the failed-login response) must not wait
    // on SES latency. Its own catch logs a fingerprint + error name only.
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
    // Composed INLINE (not via a separate builder) so the repo's HTML
    // mail-escaping regression guard can see this interpolation.
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
