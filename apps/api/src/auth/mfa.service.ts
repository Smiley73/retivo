/**
 * TOTP factor management. Owns the `UserMfa`
 * row: enrollment (start → confirm), verification (±1 window), disable, and
 * factor status.
 *
 * The TOTP secret is SSE-protected at rest on the dedicated `UserMfa` table
 * (no separate KMS CMK) and is NEVER logged.
 * RFC-6238 verification (and the ±1 step tolerance for clock skew) is delegated
 * to `otplib`'s functional TOTP API, with the skew expressed as a ±1-period
 * `epochTolerance` on each verify.
 *
 * Step-up password re-auth for `disable` is enforced by the controller (via
 * `VerifyPasswordService`); this service only clears the underlying material.
 *
 * See docs/security.md, "The second factor".
 */
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

/** otpauth issuer label rendered in the authenticator app / QR. */
const TOTP_ISSUER = 'Retivo';
/**
 * Clock-skew tolerance for TOTP verification, in seconds. One default 30 s
 * period either side reproduces otplib v12's `{ window: 1 }` (±1 step) behaviour.
 * `epochTolerance` is symmetric (past + future) when given as a number.
 */
const TOTP_EPOCH_TOLERANCE_SECONDS = 30;

/**
 * Per-account TOTP lock. A six-digit code has roughly
 * 1-in-333,000 odds per guess with the ±1-step tolerance — reachable in about
 * a day across enough source addresses if only the per-IP `@Throttle` bounds
 * it. Mirrors the password backoff's escalating-delay shape (3 free misses,
 * then 2 s → 4 s → ... → 64 s, held) via the shared `escalating-backoff`
 * module, so the two controls behave alike without sharing state.
 */
const TOTP_LOCK_PARAMS: EscalatingBackoffParams = {
  graceFailures: 3,
  maxExponent: 6, // 2^6 = 64 s
};
/**
 * Quiet-period decay: a miss landing more than this long after the previous
 * one resets the running count rather than continuing it. The `UserMfa` row
 * carries no TTL (unlike `FailedLoginAttempt`), so this is the only decay
 * mechanism — without it an honest person's occasional mistyped code would
 * accumulate toward a lockout over weeks.
 */
const TOTP_LOCK_DECAY_SEC = 24 * 60 * 60;
/**
 * How many times one attempt re-tries the reservation swap after losing it to
 * a concurrent attempt (see {@link MfaService.reserveTotpAttempt}). A loser
 * can be beaten at most once per free state version — count 0 → 1 → 2 → 3,
 * then the crossing write — before it is guaranteed to re-read a blocked
 * state and be refused by the pre-check; only a run of concurrent successful
 * clears could keep it losing past that, and a request contended that hard is
 * treated as the burst it is (refused, nothing written).
 */
const TOTP_RESERVE_MAX_ATTEMPTS = TOTP_LOCK_PARAMS.graceFailures + 1;

/**
 * A won reservation (see {@link MfaService.reserveTotpAttempt}): the
 * provisional post-swap failure state this attempt is being compared under.
 */
interface TotpReservation {
  totpFailureCount: number;
  totpLastFailureAt: string;
}

/** Status of a user's MFA factors (no secret material). */
export interface MfaStatus {
  totpEnabled: boolean;
  enrolledAt?: string;
  lastVerifiedAt?: string;
  /** True while the TOTP factor is restricted post-reset — omitted (not `false`) when not
   * restricted. */
  totpRestrictedPostReset?: boolean;
}

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly userMfa: UserMfaRepository,
    private readonly auth: AuthEventsRepository,
  ) {}

  /**
   * RFC-6238 verify of `code` against `secret` with a ±1 step (±30 s) tolerance
   * for clock skew. Delegates to otplib v13's functional `verify` (async;
   * default `@noble` crypto + `@scure` base32 plugins) and collapses its result
   * object to the boolean the call sites expect.
   *
   * v13's `verify` runs token guardrails that THROW `TokenFormatError` /
   * `TokenLengthError` for malformed input (non-digit, or not exactly 6 digits),
   * where v12's `check` simply returned `false`. The TOTP DTOs accept arbitrary
   * <=64-char strings, so a typo'd code would otherwise surface as a 500 instead
   * of the documented `401 MFA_CODE_INVALID`. Prevalidate the 6-digit shape here
   * and treat anything else as a plain failed verification.
   */
  private async verifyTotpCode(code: string, secret: string): Promise<boolean> {
    const { valid } = await this.verifyTotpStep(code, secret);
    return valid;
  }

  /**
   * Shared RFC-6238 verify that also surfaces the matched RFC-6238 time step
   * (`VerifyResult.timeStep`), so step-up callers can commit it for single-use.
   * `afterTimeStep`, when supplied, makes otplib reject any token whose
   * `timeStep <= afterTimeStep` in-library ("rejects reused steps"), seeded from
   * the stored `lastUsedTotpStepStepUp`. The login path calls this without
   * `afterTimeStep` (no consume). Prevalidates the 6-digit shape so a
   * typo surfaces as a plain failed verify, not a v13 `TokenFormatError` 500.
   */
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
    // otplib's functional `verify` is generic over TOTP/HOTP; `timeStep` lives
    // only on the TOTP result. We always call it with a TOTP secret, so narrow
    // via the property presence to read the matched step for single-use.
    return 'timeStep' in result
      ? { valid: true, timeStep: result.timeStep }
      : { valid: true };
  }

  /** Current per-account TOTP lock state derived from the stored counter +
   * last-failure timestamp. */
  private totpLockState(state: TotpFailureState) {
    return escalatingBackoffState(
      state.totpFailureCount ?? 0,
      state.totpLastFailureAt,
      TOTP_LOCK_PARAMS,
    );
  }

  /**
   * Cheap pre-check against already-read state: refuse with the SAME
   * `ThrottlerException` the route's per-IP `@Throttle` raises (429,
   * `RATE_LIMITED`) when the state read a moment ago already shows the
   * per-account TOTP window open — before paying for a reservation write.
   * Reusing the exact exception class, rather than a bespoke
   * one, means the response is byte-identical to ordinary rate limiting: no
   * oracle about account state, and no new user-facing wording (the client
   * renders `err.error.message` verbatim). A refusal here writes nothing, so
   * it can never extend the window it is refusing under.
   *
   * This alone is check-then-act and does not bound genuinely concurrent
   * requests racing the same open window — {@link reserveTotpAttempt} closes
   * that half by swapping against exactly the state this check passed on.
   */
  private assertTotpNotLocked(state: TotpFailureState): void {
    if (this.totpLockState(state).blocked) {
      throw new ThrottlerException();
    }
  }

  /**
   * Reserve this verification attempt against the per-account TOTP lock BEFORE the code is compared:
   * a compare-and-swap on exactly the failure state `row` was read with.
   * Admission is decided from that OBSERVED state — already shown open by {@link
   * assertTotpNotLocked} — never from the post-write count, so an attempt arriving after a window
   * has elapsed is compared rather than re-locked. Exactly one of N concurrent attempts that read
   * the same state wins the swap; a loser re-reads (consistently) and re-decides against what the
   * winner left behind: blocked → refused with nothing written; still open → tries again, up to
   * {@link TOTP_RESERVE_MAX_ATTEMPTS}, then fails closed as the burst it is. That is what bounds a
   * burst — the winner's stamp is what its racers see as blocked — without letting a refused
   * attempt inflate the count or restart the window (the earlier unconditional `ADD` on
   * every attempt did both, so past three misses no code was ever compared again until 24 h of
   * silence). The replica-staleness half is separately closed by `getConsistent`.
   *
   * The won reservation is provisional: a correct code undoes it via
   * `clearTotpFailure`, a genuine miss keeps it as the miss record. Normal
   * sequential use therefore never accumulates a lock.
   */
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
      // Lost the swap: a concurrent attempt moved the state between our read
      // and our write. Re-read what it left behind and re-decide against that.
      observed = (await this.userMfa.getConsistent(userId)) ?? {};
      this.assertTotpNotLocked(observed);
    }
    throw new ThrottlerException();
  }

  /**
   * Audit a genuine TOTP miss: `mfa_totp_failed` always, plus
   * `mfa_totp_locked` exactly once per lock — when THIS miss is the one that
   * carried the account across the grace threshold (the count it was
   * reserved under earned no delay; the count it left behind does). Mapped
   * onto the existing `MfaVerifyFailed` metric. A miss that lands after
   * an earlier lock's window elapsed extends that lock without re-auditing
   * it, and a refusal never audits anything — so the event fires once per
   * lock, not once per refused request. Never logs the code/secret.
   */
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
    // Incident-context warn only. The `MfaVerifyFailed` metric is emitted as
    // direct EMF from AuthEventsRepository off the `mfa_totp_failed` AuthEvent
    // recorded above — this log is NOT its source, so the message is
    // deliberately not a metric-filter marker.
    this.logger.warn('MFA verification failed', { userId, factor: 'totp' });
  }

  /**
   * Begin TOTP enrollment: mint a fresh base32 secret, stash it as
   * `pendingTotpSecret` (held until `enrollConfirm` proves a live code), and
   * return the secret + otpauth URL for the QR. Does NOT enable TOTP — the
   * factor only goes live on confirm. A re-start overwrites any prior pending
   * secret (abandoned enrollment).
   *
   * Returns `null` (no state change) when TOTP is already enabled — an
   * enroll-over-enabled would silently retain the live secret alongside a
   * pending replacement, and `enrollConfirm`'s promotion would then overwrite
   * the still-in-use live secret while only ever emitting a `totp_add`
   * notice for the replacement, losing the displaced factor with no
   * corresponding undo/removal notice. Replacing an enabled factor goes
   * through the existing disable-then-add flow instead.
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
   * Read-only check of `code` against the CURRENT pending secret — no
   * mutation, no audit. `mfaTotpEnrollConfirm` calls this BEFORE running the
   * fresh-proof gate that consumes the caller's single-use step-up factor
   * (an Email-OTP code or passkey assertion): without it, a wrong/mistyped
   * TOTP code still burned that proof (the gate ran unconditionally first),
   * so a corrected retry — even with the right code — failed with the same
   * `MFA_CODE_INVALID`, because the resubmitted proof had already been spent.
   * Returns `false` (never throws) when there is no pending secret or the
   * code doesn't match. `enrollConfirm` still performs the authoritative
   * check + mutation once the gate has run — this is a courtesy pre-check
   * only, not a replacement for it.
   */
  async verifyPendingCode(userId: string, code: string): Promise<boolean> {
    const row = await this.userMfa.get(userId);
    if (!row?.pendingTotpSecret) return false;
    return this.verifyTotpCode(code, row.pendingTotpSecret);
  }

  /**
   * Confirm TOTP enrollment: verify `code` against the pending secret (±1
   * window), then atomically promote it to `totpSecret`, set
   * `totpEnabled = true`, stamp `enrolledAt`, and clear `pendingTotpSecret`.
   * Returns `false` (no state change) when there is no pending secret, TOTP
   * is already enabled (closes the race between a legitimate `enrollStart`
   * and a concurrent enable — see `enrollStart`'s doc comment for why an
   * enroll-over-enabled must never promote), the code is wrong, or the
   * promotion's own condition (still-disabled + the pending secret unchanged
   * since this read) loses a race against a concurrent confirm; `true` on
   * success. Audits `mfa_totp_enrolled` on success (carries the
   * caller's `ip`/`userAgent` like the login/step-up events already do). The
   * read-time check above is a fast path only —
   * `UserMfaRepository.confirmTotpEnrollment`'s conditional write is what
   * actually closes the TOCTOU between this read and the promotion. No
   * per-account lock here: the pending secret was minted for and returned to
   * the caller's own authenticated session, so there is nothing to guess —
   * enrolment confirm keeps only its existing `@Throttle`.
   *
   * `restricted`: the caller (`MfaController`)
   * resolves whether this write lands inside an open password-reset window
   * via `resolveOpenResetWindow` and passes the result through so the
   * promoted row is stamped restricted — or explicitly un-stamped — in the
   * SAME write as the promotion.
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
    // Promote the pending secret to the live one and REMOVE the pending
    // attribute in one update (the repo's `update` SETs the live fields and
    // REMOVEs `pendingTotpSecret` so a stale pending secret can't be
    // re-confirmed), conditioned on the state read above still holding.
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
   * Verify a live TOTP `code` for `userId` (±1 window). Consults the
   * per-account TOTP lock BEFORE verifying: while the
   * window is open, refuses with the shared 429 shape — even a correct code —
   * so the lock can never be mistaken for a wrong code. Once the window has
   * elapsed the next attempt is compared again. The attempt is reserved
   * against the lock (see {@link reserveTotpAttempt}) before the code is ever
   * compared, so a burst of concurrent requests cannot all slip through on
   * the same pre-attempt read. On success stamps
   * `lastVerifiedAt`, clears the lock state (undoing its own reservation),
   * and audits `mfa_totp_verified`; on a genuine miss the reservation stands
   * as the miss record and {@link auditTotpMiss} audits it. Returns the
   * boolean result. No-op `false` when the user has no enabled TOTP factor
   * (no lock check either — nothing to guess against).
   */
  async verifyTotp(
    userId: string,
    code: string,
    ip?: string | null,
    userAgent?: string | null,
  ): Promise<boolean> {
    // Consistent read: the
    // lock decision below must never see a replica that hasn't yet observed
    // the previous attempt's `reserveTotpAttempt` write.
    const row = await this.userMfa.getConsistent(userId);
    // A restricted factor is treated exactly like
    // "no enabled factor" here — the same silent `false`, no distinct audit —
    // so a login-MFA attempt naming it directly is refused without a new
    // existence oracle. `computeFactors` / `buildChallenge` already stop
    // OFFERING it; this is the belt-and-suspenders refusal for a method the
    // caller names explicitly.
    if (!row?.totpEnabled || !row.totpSecret || row.totpRestrictedPostReset) return false;
    this.assertTotpNotLocked(row);
    const reserved = await this.reserveTotpAttempt(userId, row);
    const ok = await this.verifyTotpCode(code, row.totpSecret);
    if (ok) {
      await this.userMfa.update(userId, {
        lastVerifiedAt: new Date().toISOString(),
      });
      await this.userMfa.clearTotpFailure(userId);
      await this.auth.record({
        userId,
        eventType: 'mfa_totp_verified',
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
    } else {
      await this.auditTotpMiss(userId, reserved, ip ?? null, userAgent ?? null);
    }
    return ok;
  }

  /**
   * Verify a live TOTP `code` for a **step-up** re-auth. Unlike {@link verifyTotp} (the pure
   * login-MFA path), the matched time step is single-use per user: the verify passes
   * `afterTimeStep` seeded from `lastUsedTotpStepStepUp` so otplib rejects a reused step, and on a
   * fresh match the step is committed via a conditional `UpdateItem` that also closes the
   * concurrent-double-use TOCTOU (a lost race returns `false`). Stamps `lastVerifiedAt` + audits
   * `mfa_totp_verified` on success, `mfa_totp_failed` otherwise. Returns `false` (no state change)
   * when the user has no enabled TOTP factor, the code is wrong, or the step was already consumed.
   * Shares the SAME per-account TOTP lock state as {@link verifyTotp} — checked and reserved before
   * any step verification, refusing with the shared 429 shape while the window is open, so a
   * distributed guesser can't route around the login-MFA lock via the step-up path.
   */
  async verifyTotpForStepUp(
    userId: string,
    code: string,
    ip?: string | null,
    userAgent?: string | null,
  ): Promise<boolean> {
    // Consistent read: see
    // {@link verifyTotp} for why the lock check needs the stronger read.
    const row = await this.userMfa.getConsistent(userId);
    // A restricted factor must refuse a step-up
    // proof — checked here, where the factor is resolved, not by filtering
    // `computeFactors`: a caller can name `method: 'totp'` directly.
    if (!row?.totpEnabled || !row.totpSecret || row.totpRestrictedPostReset) return false;
    this.assertTotpNotLocked(row);
    const reserved = await this.reserveTotpAttempt(userId, row);
    const { valid, timeStep } = await this.verifyTotpStep(
      code,
      row.totpSecret,
      row.lastUsedTotpStepStepUp ?? undefined,
    );
    // A fresh, not-yet-consumed step must win the conditional commit; a reused
    // step (rejected by `afterTimeStep`) or a concurrent double-use (lost the
    // conditional write) both fail here.
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
   * Disable TOTP: clear `totpSecret` / `totpEnabled`. Step-up
   * password re-auth is enforced by the controller (via `VerifyPasswordService`),
   * so this method performs no code check. Returns `false` (no change) when
   * there is no enabled factor; `true` on an actual clear. Audits
   * `mfa_totp_disabled` only on an actual change (carries the caller's
   * `ip`/`userAgent` like the login/step-up events already do).
   */
  async disable(
    userId: string,
    ip?: string | null,
    userAgent?: string | null,
  ): Promise<boolean> {
    const row = await this.userMfa.get(userId);
    // Gate only on `totpEnabled` (not also `totpSecret`): a corrupt/legacy row
    // with the flag set but the secret absent must still be clearable so the
    // broken factor can be cleared + re-enrolled, not no-op stuck.
    if (!row?.totpEnabled) return false;

    // Replace the row with a cleared one (a partial `update` can't REMOVE the
    // optional secret attributes — a Put with the fields absent does). This
    // also drops any per-account TOTP lock state — a disabled
    // factor has nothing left to guess.
    const cleared: UserMfaRow = {
      userId,
      totpEnabled: false,
      updatedAt: new Date().toISOString(),
    };
    await this.userMfa.put(cleared);
    // Audit write is best-effort: if auth.record throws, the factor is already
    // cleared; a retry hits the idempotent guard above. The put is intentionally
    // unconditional (convergent — two concurrent disables produce identical
    // cleared rows; the throttle prevents audit spam).
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
