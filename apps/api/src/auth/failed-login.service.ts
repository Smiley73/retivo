// Per-email exponential backoff: the first GRACE_FAILURES misses are free, then 2 s doubling to a 64 s cap; the counter resets on success or
// after 24h. With the per-IP limit, brute force stays bounded.
import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { FailedLoginAttemptsRepository } from '../dynamo/failed-login-attempts.repository.js';
import { TrustedDeviceService, type DeviceTrustContext } from './trusted-device.service.js';
import { LoginGuessingNoticeService } from './login-guessing-notice.service.js';

const GRACE_FAILURES = 3;
const MAX_BACKOFF_EXPONENT = 6; // 2^6 = 64 s
const TTL_AFTER_LAST_FAILURE_SEC = 24 * 60 * 60;

// The backoff delay a miss count earns, derived only from the count so `checkBackoff` never trusts a separately
// stored, raceable "next attempt after" value.
function backoffDelaySec(consecutiveFailures: number): number {
  const exponent = Math.min(
    Math.max(consecutiveFailures - GRACE_FAILURES, 0),
    MAX_BACKOFF_EXPONENT,
  );
  return exponent === 0 ? 0 : 2 ** exponent;
}

export interface BackoffState {
  blocked: boolean;
  retryAfterSec: number;
}

@Injectable()
export class FailedLoginService {
  constructor(
    private readonly repo: FailedLoginAttemptsRepository,
    private readonly trustedDevices: TrustedDeviceService,
    private readonly notice: LoginGuessingNoticeService,
  ) {}

  /**
   * When `trust.trusted` is set the per-address block never applies: the caller presented a valid trusted-device
   * cookie, so the address counter does not gate it.
   */
  async checkBackoff(
    emailLowercase: string,
    trust?: DeviceTrustContext,
  ): Promise<BackoffState> {
    if (trust?.trusted) return { blocked: false, retryAfterSec: 0 };
    const row = await this.repo.find(emailLowercase);
    if (!row) return { blocked: false, retryAfterSec: 0 };
    // Window from the atomic count and latest-failure timestamp, never a stored `nextAttemptAfter` a concurrent
    // writer could have raced; a notice-stamp-only row reads unblocked.
    const delaySec = backoffDelaySec(row.consecutiveFailures ?? 0);
    if (delaySec === 0) return { blocked: false, retryAfterSec: 0 };
    const lastMs = Date.parse(row.lastFailedAt ?? '');
    if (!Number.isFinite(lastMs)) return { blocked: false, retryAfterSec: 0 };
    const nowSec = Math.floor(Date.now() / 1000);
    const windowEndSec = Math.floor(lastMs / 1000) + delaySec;
    const retryAfterSec = windowEndSec - nowSec;
    return retryAfterSec > 0
      ? { blocked: true, retryAfterSec }
      : { blocked: false, retryAfterSec: 0 };
  }

  /**
   * Records one failure. A trusted device miss increments its own counter, and crossing the ceiling revokes only that
   * device. Otherwise one atomic increment followed by the guessing-notice threshold check.
   */
  async recordFailure(
    emailLowercase: string,
    ip: string | null = null,
    userAgent: string | null = null,
    trust?: DeviceTrustContext,
  ): Promise<void> {
    if (trust?.trusted) {
      await this.trustedDevices.recordDeviceFailure(trust.userId, trust.deviceId, ip, userAgent);
      return;
    }
    const row = await this.repo.increment(emailLowercase, TTL_AFTER_LAST_FAILURE_SEC);
    await this.notice.notifyIfNeeded(emailLowercase, row.consecutiveFailures ?? 0, ip, userAgent);
  }

  async clear(emailLowercase: string, trust?: DeviceTrustContext): Promise<void> {
    await this.repo.clear(emailLowercase);
    if (trust?.trusted) {
      await this.trustedDevices.clearDeviceFailures(trust.userId, trust.deviceId);
    }
  }

  /**
   * Unconditional purge for account deletion, guessing-notice stamp included, so a newly registered account reusing
   * the address inherits no notice-suppression state. Distinct from `clear()`, which preserves the stamp; only the
   * deletion cascade should call it.
   */
  async purgeAddress(emailLowercase: string): Promise<void> {
    await this.repo.deleteRow(emailLowercase);
  }

  /**
   * Password re-verify under this backoff, the shared primitive behind the destructive step-up flows and
   * `verify-password`. Checks the window first (a lockout is 429 before the password is tested; bypassed for a
   * trusted device), then: `verify` false records one failure and throws 401 INVALID_CREDENTIALS, true clears the
   * counter, and a throw propagates without recording a failure, so a transient fault after a correct password cannot
   * lock the account out. The caller owns the audit; no secret is logged here.
   */
  async verifyWithBackoff(args: {
    emailLowercase: string;
    verify: () => Promise<boolean>;
    ip?: string | null;
    userAgent?: string | null;
    trust?: DeviceTrustContext;
  }): Promise<void> {
    const backoff = await this.checkBackoff(args.emailLowercase, args.trust);
    if (backoff.blocked) {
      throw new HttpException(
        {
          code: 'LOGIN_BACKOFF',
          message: `Invalid password. Try again in ${backoff.retryAfterSec}s.`,
        },
        429,
      );
    }
    // A thrown error is a backend fault, not an auth failure, and leaves the counter untouched; only a resolved
    // false records a failure.
    const matches = await args.verify();
    if (!matches) {
      await this.recordFailure(
        args.emailLowercase,
        args.ip ?? null,
        args.userAgent ?? null,
        args.trust,
      );
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect.',
      });
    }
    await this.clear(args.emailLowercase, args.trust);
  }
}
