// TOTP factor management on the UserMfa row: enroll, verify (RFC-6238 via otplib, +-1 step), disable, status. The secret is never
// logged. See docs/security.md, "The second factor".
import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { generateSecret, generateURI, verify } from 'otplib';
import {
  UserMfaRepository,
  type TotpFailureState,
} from '../dynamo/user-mfa.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { UserMfaRow } from '../dynamo/types.js';
import {
  escalatingBackoffDelaySec,
  escalatingBackoffState,
  type EscalatingBackoffParams,
} from './escalating-backoff.js';

// otpauth issuer label shown in the authenticator app.
const TOTP_ISSUER = 'Retivo';
// Clock-skew tolerance in seconds: one 30 s period either side, i.e. +-1 step.
const TOTP_EPOCH_TOLERANCE_SECONDS = 30;

// Per-account TOTP lock: a six-digit code has ~1-in-333,000 odds per guess, reachable in about a day across enough
// addresses if only the per-IP throttle bounds it. Same escalating shape as the password backoff (3 free misses, then
// 2 s doubling to 64 s) via `escalating-backoff`, without shared state.
const TOTP_LOCK_PARAMS: EscalatingBackoffParams = {
  graceFailures: 3,
  maxExponent: 6, // 2^6 = 64 s
};
// A miss more than this long after the previous one restarts the count. The UserMfa row has no TTL, so this is the
// only decay; without it occasional mistyped codes would accumulate toward a lockout over weeks.
const TOTP_LOCK_DECAY_SEC = 24 * 60 * 60;
// Retries of the reservation swap after losing it to a concurrent attempt. A loser can be beaten at most once per
// free state version before it re-reads a blocked state; one contended further is treated as a burst and refused.
const TOTP_RESERVE_MAX_ATTEMPTS = TOTP_LOCK_PARAMS.graceFailures + 1;

interface TotpReservation {
  totpFailureCount: number;
  totpLastFailureAt: string;
}

/** Status of a user's MFA factors (no secret material). */
export interface MfaStatus {
  totpEnabled: boolean;
  enrolledAt?: string;
  lastVerifiedAt?: string;
  /** Omitted (not false) when the factor is not restricted. */
  totpRestrictedPostReset?: boolean;
}

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly userMfa: UserMfaRepository,
    private readonly auth: AuthEventsRepository,
  ) {}

  // RFC-6238 verify with +-1 step tolerance. otplib v13 throws TokenFormatError or TokenLengthError on malformed input,
  // which the DTOs allow (any string up to 64 characters) and would surface as a 500 instead of 401 MFA_CODE_INVALID,
  // so the 6-digit shape is prevalidated and anything else is a failed verify.
  private async verifyTotpCode(code: string, secret: string): Promise<boolean> {
    const { valid } = await this.verifyTotpStep(code, secret);
    return valid;
  }

  // Verify that also returns the matched time step so live-factor callers can commit it for single use;
  // `afterTimeStep` makes otplib reject reused steps. Enrollment passes none (it does not consume).
  private async verifyTotpStep(
    code: string,
    secret: string,
    afterTimeStep?: number,
  ): Promise<{ valid: boolean; timeStep?: number }> {
    if (!/^\d{6}$/.test(code)) return { valid: false };
    const result = await verify({
      secret,
      token: code,
      epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS,
      ...(afterTimeStep !== undefined ? { afterTimeStep } : {}),
    });
    if (!result.valid) return { valid: false };
    // `timeStep` exists only on the TOTP result of the generic verify; this is always called with a TOTP secret.
    return 'timeStep' in result
      ? { valid: true, timeStep: result.timeStep }
      : { valid: true };
  }

  private totpLockState(state: TotpFailureState) {
    return escalatingBackoffState(
      state.totpFailureCount ?? 0,
      state.totpLastFailureAt,
      TOTP_LOCK_PARAMS,
    );
  }

  // Cheap pre-check: refuses with the same ThrottlerException as the per-IP @Throttle (429 RATE_LIMITED) when the
  // already-read state shows the window open, so the response is byte-identical to ordinary rate limiting and leaks no
  // account-state oracle. A refusal writes nothing, so it cannot extend the window. It is check-then-act;
  // `reserveTotpAttempt` closes the concurrent half.
  private assertTotpNotLocked(state: TotpFailureState): void {
    if (this.totpLockState(state).blocked) {
      throw new ThrottlerException();
    }
  }

  // Reserves the attempt before the code is compared, as a compare-and-swap on the exact failure state read. Admission
  // comes from the observed state, never the post-write count, so an attempt after the window elapsed is compared, not
  // re-locked. Of N concurrent attempts one wins; a loser re-reads consistently and is refused if blocked, retries up
  // to TOTP_RESERVE_MAX_ATTEMPTS, then fails closed. A refused attempt can neither inflate the count nor restart the
  // window. The reservation is provisional: a correct code undoes it via `clearTotpFailure`.
  private async reserveTotpAttempt(
    userId: string,
    row: UserMfaRow,
  ): Promise<TotpReservation> {
    let observed: TotpFailureState = row;
    for (let attempt = 0; attempt < TOTP_RESERVE_MAX_ATTEMPTS; attempt++) {
      const reserved = await this.userMfa.reserveTotpAttempt(
        userId,
        observed,
        TOTP_LOCK_DECAY_SEC,
      );
      if (reserved) return reserved;
      // Lost the swap to a concurrent attempt: re-read what it left and re-decide.
      observed = (await this.userMfa.getConsistent(userId)) ?? {};
      this.assertTotpNotLocked(observed);
    }
    throw new ThrottlerException();
  }

  // Audits a genuine miss: `mfa_totp_failed` always, plus `mfa_totp_locked` exactly once per lock, on the miss that
  // crossed the grace threshold. A refusal audits nothing. Never logs the code or secret.
  private async auditTotpMiss(
    userId: string,
    reserved: TotpReservation,
    ip: string | null,
    userAgent: string | null,
  ): Promise<void> {
    await this.auth.record({ userId, eventType: 'mfa_totp_failed', ip, userAgent });
    const crossedThreshold =
      escalatingBackoffDelaySec(reserved.totpFailureCount - 1, TOTP_LOCK_PARAMS) === 0 &&
      escalatingBackoffDelaySec(reserved.totpFailureCount, TOTP_LOCK_PARAMS) > 0;
    if (crossedThreshold) {
      await this.auth.record({ userId, eventType: 'mfa_totp_locked', ip, userAgent });
    }
    // Incident-context warn only; the MfaVerifyFailed metric comes from AuthEventsRepository off the audit event, so
    // this is deliberately not a metric-filter marker.
    this.logger.warn('MFA verification failed', { userId, factor: 'totp' });
  }

  /**
   * Begins enrollment: mints a fresh secret into `pendingTotpSecret` (a re-start overwrites an abandoned one) and
   * returns it with the otpauth URL. Does not enable TOTP. Returns null when TOTP is already enabled:
   * enroll-over-enabled would let the later promotion overwrite the in-use secret with no removal notice for the
   * displaced factor; replacing a factor goes through disable then add.
   */
  async enrollStart(
    userId: string,
    accountLabel: string,
  ): Promise<{ secret: string; otpauthUrl: string } | null> {
    const existing = await this.userMfa.get(userId);
    if (existing?.totpEnabled) return null;
    const secret = generateSecret();
    if (existing) {
      await this.userMfa.update(userId, { pendingTotpSecret: secret });
    } else {
      const row: UserMfaRow = {
        userId,
        totpEnabled: false,
        pendingTotpSecret: secret,
        updatedAt: new Date().toISOString(),
      };
      await this.userMfa.put(row);
    }
    const otpauthUrl = generateURI({
      issuer: TOTP_ISSUER,
      label: accountLabel,
      secret,
    });
    return { secret, otpauthUrl };
  }

  /**
   * Read-only check of `code` against the pending secret, run before the fresh-proof gate that consumes the
   * single-use step-up factor: otherwise a mistyped TOTP code burned the proof and a corrected retry failed. Returns
   * false when there is no pending secret or the code is wrong; `enrollConfirm` stays authoritative.
   */
  async verifyPendingCode(userId: string, code: string): Promise<boolean> {
    const row = await this.userMfa.get(userId);
    if (!row?.pendingTotpSecret) return false;
    return this.verifyTotpCode(code, row.pendingTotpSecret);
  }

  /**
   * Confirms enrollment: verifies `code` against the pending secret and atomically promotes it. Returns false when
   * there is no pending secret, TOTP is already enabled, the code is wrong, or the conditional promotion loses a race
   * (the read-time check is a fast path; the conditional write closes the TOCTOU). No per-account lock: the pending
   * secret went to the caller own session, so there is nothing to guess. `restricted` is resolved by the controller
   * via `resolveOpenResetWindow` and stamped (or un-stamped) in the same write.
   */
  async enrollConfirm(
    userId: string,
    code: string,
    restricted: { requestedAt: string } | null,
    ip?: string | null,
    userAgent?: string | null,
  ): Promise<boolean> {
    const row = await this.userMfa.get(userId);
    if (!row?.pendingTotpSecret || row.totpEnabled) return false;
    if (!(await this.verifyTotpCode(code, row.pendingTotpSecret))) return false;

    const now = new Date().toISOString();
    // Promote and REMOVE the pending secret in one conditional update, so a stale pending secret cannot be
    // re-confirmed.
    const confirmed = await this.userMfa.confirmTotpEnrollment(userId, {
      totpSecret: row.pendingTotpSecret,
      enrolledAt: now,
      lastVerifiedAt: now,
      expectedPendingSecret: row.pendingTotpSecret,
      restricted,
    });
    if (!confirmed) return false;
    await this.auth.record({
      userId,
      eventType: 'mfa_totp_enrolled',
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return true;
  }

  /**
   * Verifies a live TOTP `code` (+-1 step) for sign-in or step-up. The matched time step is single-use across both:
   * `afterTimeStep` is seeded from the stored step and a fresh match is committed by a conditional update that closes
   * the concurrent-double-use TOCTOU. The per-account lock is consulted first: while the window is open even a correct
   * code gets the shared 429, so the lock cannot be mistaken for a wrong code. The attempt is reserved before
   * comparison so a concurrent burst cannot slip through one read. A reused step or lost conditional write is a miss
   * and the reservation stands; on success it stamps `lastVerifiedAt`, undoes its reservation and audits. Returns
   * false with no enabled factor (nothing to guess).
   */
  async verifyTotp(
    userId: string,
    code: string,
    ip?: string | null,
    userAgent?: string | null,
  ): Promise<boolean> {
    // Consistent read: the lock decision must not see a replica behind the previous reservation.
    const row = await this.userMfa.getConsistent(userId);
    // A restricted factor is treated as no enabled factor, the same silent false with no distinct audit, so naming it
    // directly (a caller can name `method: totp`) leaks no existence oracle.
    if (!row?.totpEnabled || !row.totpSecret || row.totpRestrictedPostReset) return false;
    this.assertTotpNotLocked(row);
    const reserved = await this.reserveTotpAttempt(userId, row);
    const { valid, timeStep } = await this.verifyTotpStep(
      code,
      row.totpSecret,
      row.lastUsedTotpStepStepUp ?? undefined,
    );
    const consumed =
      valid && timeStep !== undefined
        ? await this.userMfa.consumeTotpStepUpStep(userId, timeStep)
        : false;
    if (!consumed) {
      await this.auditTotpMiss(userId, reserved, ip ?? null, userAgent ?? null);
      return false;
    }
    await this.userMfa.update(userId, { lastVerifiedAt: new Date().toISOString() });
    await this.userMfa.clearTotpFailure(userId);
    await this.auth.record({
      userId,
      eventType: 'mfa_totp_verified',
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return true;
  }

  /**
   * Disables TOTP. Step-up password re-auth is enforced by the controller, so there is no code check. Returns false
   * with no enabled factor; audits `mfa_totp_disabled` only on an actual change.
   */
  async disable(
    userId: string,
    ip?: string | null,
    userAgent?: string | null,
  ): Promise<boolean> {
    const row = await this.userMfa.get(userId);
    // Gate on `totpEnabled` only: a corrupt row with the flag set and the secret absent must still be clearable.
    if (!row?.totpEnabled) return false;

    // A Put with the secret fields absent, because a partial update cannot REMOVE them; it also drops the lock state.
    const cleared: UserMfaRow = {
      userId,
      totpEnabled: false,
      updatedAt: new Date().toISOString(),
    };
    await this.userMfa.put(cleared);
    // Best-effort audit: the factor is already cleared and a retry hits the idempotent guard. The put is
    // unconditional (two concurrent disables write identical rows).
    await this.auth.record({
      userId,
      eventType: 'mfa_totp_disabled',
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return true;
  }

  /** Factor status for the management UI (no secret material). */
  async getStatus(userId: string): Promise<MfaStatus> {
    const row = await this.userMfa.get(userId);
    if (!row) {
      return { totpEnabled: false };
    }
    return {
      totpEnabled: row.totpEnabled,
      enrolledAt: row.enrolledAt,
      lastVerifiedAt: row.lastVerifiedAt,
      ...(row.totpRestrictedPostReset ? { totpRestrictedPostReset: true } : {}),
    };
  }
}
