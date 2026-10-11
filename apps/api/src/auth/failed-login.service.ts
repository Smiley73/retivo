/**
 * Per-email exponential-backoff state. The first `GRACE_FAILURES`
 * misses don't trigger any wait — Alice fat-fingering her password
 * three times in a row sees no friction. From the 4th miss onward
 * the wait grows 2 → 4 → 8 → 16 → 32 → 64 s (capped). Counter resets
 * on success or after 24h of inactivity (TTL on the row).
 *
 * Combined with the per-IP rate limit, brute-force is still bounded.
 */
import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { FailedLoginAttemptsRepository } from '../dynamo/failed-login-attempts.repository.js';
import { TrustedDeviceService, type DeviceTrustContext } from './trusted-device.service.js';
import { LoginGuessingNoticeService } from './login-guessing-notice.service.js';

const GRACE_FAILURES = 3;
const MAX_BACKOFF_EXPONENT = 6; // 2^6 = 64 s
const TTL_AFTER_LAST_FAILURE_SEC = 24 * 60 * 60;

/**
 * The backoff delay (seconds) a given running miss count earns. The first
 * `GRACE_FAILURES` misses are free (delay 0); from the 4th on the wait grows
 * 2 → 4 → 8 → 16 → 32 → 64 s and is held at 64 s. Derived purely from the
 * count, so `checkBackoff` never has to trust a separately stored/raced
 * "next attempt after" value.
 */
function backoffDelaySec(consecutiveFailures: number): number {
  const exponent = Math.min(
    Math.max(consecutiveFailures - GRACE_FAILURES, 0),
    MAX_BACKOFF_EXPONENT,
  );
  return exponent === 0 ? 0 : 2 ** exponent;
}

export interface BackoffState {
  /** True if the caller must wait — within the backoff window. */
  blocked: boolean;
  /** Seconds until the next attempt is allowed. Zero when not blocked. */
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
   * When `trust.trusted` is set, the per-address block never applies —
   * the caller already resolved that a valid trusted-device cookie is
   * presented, so the address counter is not what gates this attempt.
   */
  async checkBackoff(
    emailLowercase: string,
    trust?: DeviceTrustContext,
  ): Promise<BackoffState> {
    if (trust?.trusted) return { blocked: false, retryAfterSec: 0 };
    const row = await this.repo.find(emailLowercase);
    if (!row) return { blocked: false, retryAfterSec: 0 };
    // Compute the window from the atomic source-of-truth fields — the running
    // count and the latest-failure timestamp — never a stored `nextAttemptAfter`
    // that a concurrent writer could have raced. A row holding only a
    // guessing-notice stamp (no counter) reads as unblocked.
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
   * Record one failure. A trusted device's miss increments ITS OWN counter
   * instead of the per-address one — crossing the per-device ceiling revokes
   * only that device (`TrustedDeviceService.recordDeviceFailure`), never the
   * account. Otherwise: today's single atomic increment (no read/modify/
   * write), followed by the guessing-notice threshold check on the
   * resulting count.
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

  /** Clear the per-address counter, and the per-device counter too when this
   *  success came from a trusted device (both counters for that identity). */
  async clear(emailLowercase: string, trust?: DeviceTrustContext): Promise<void> {
    await this.repo.clear(emailLowercase);
    if (trust?.trusted) {
      await this.trustedDevices.clearDeviceFailures(trust.userId, trust.deviceId);
    }
  }

  /**
   * Unconditional purge for account-deletion lifecycle cleanup —
   * always removes the
   * `FailedLoginAttempt` row, including any guessing-notice stamp, so a
   * newly registered account reusing this address inherits no
   * notice-suppression state. Distinct from `clear()` (used on a successful
   * login/re-verify), which deliberately preserves the stamp. Only the
   * account-deletion cascade should call this.
   */
  async purgeAddress(emailLowercase: string): Promise<void> {
    await this.repo.deleteRow(emailLowercase);
  }

  /**
   * Password re-verify wrapped with this per-account backoff — the shared
   * primitive behind the destructive step-up flows (`DELETE /auth/account`
   * and `POST /sync/workspace/clear`) and the data-export / password-slot
   * re-wrap purposes of `POST /auth/verify-password`. It checks the backoff
   * window first (a lockout throws `429 LOGIN_BACKOFF` before the password is
   * ever tested — bypassed entirely when `args.trust` is trusted), runs the
   * caller's `verify` primitive, then dispatches on the outcome:
   *   - `verify` resolves `false` (a genuine wrong password) → records one
   *     failure and throws `401 INVALID_CREDENTIALS`;
   *   - `verify` resolves `true` (a match) → clears the counter;
   *   - `verify` THROWS (a backend/transient fault — DynamoDB, argon2) → the
   *     error propagates untouched, WITHOUT recording a failure, so a transient
   *     error after a *correct* password can never lock a legitimate account
   *     out of the flow (the earlier catch-all recorded a failure on any
   *     thrown error).
   * The caller owns any audit around this call: `verify` owns the
   * password-match audit (the clear path routes through `VerifyPasswordService`;
   * the delete path verifies argon2 directly and records none), and the caller
   * layers its own started/failed events. No secret is logged here.
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
    // A thrown error here is a backend/transient fault, NOT an auth failure —
    // it propagates without touching the counter. Only a resolved `false`
    // (a genuine wrong password) records a failure.
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
