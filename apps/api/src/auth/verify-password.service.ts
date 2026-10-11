/**
 * Session-preserving password re-verification. Used by destructive
 * client-only flows (e.g. Profile-page data import) that need explicit
 * knowledge-factor proof without rotating tokens, cookies, or sessions.
 * It is NOT side-effect-free: `verify()` shares the centralized per-account
 * login backoff (reads + increments the `FailedLoginAttempt` counter on a
 * wrong password, clears it on success) so a stolen session cannot use this
 * endpoint as an unthrottled password oracle.
 */
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { CredentialsRepository } from '../dynamo/credentials.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { RefreshTokensRepository } from '../dynamo/refresh-tokens.repository.js';
import { resolveCredentialRevision, type CredentialRow } from '../dynamo/types.js';
import { FailedLoginService } from './failed-login.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';

export interface VerifyPasswordArgs {
  userId: string;
  currentPassword: string;
  ip: string | null;
  userAgent: string | null;
  /**
   * Re-auth purpose. When `'data_export'`, the recorded audit event is
   * `data_export` / `data_export_failed` instead of the generic
   * `password_verify` / `password_verify_failed`. `'change_password'` and
   * `'password_slot_rewrap'` are accepted and keep the generic audit event;
   * the web sends them with the change-password session-authority repair call
   * and the derived
   * post-reset re-wrap prompt's answer.
   * Omitted by import/demo/reset.
   */
  purpose?: 'data_export' | 'change_password' | 'password_slot_rewrap';
  /**
   * The CURRENT session's refresh-token hash,
   * resolved by the `POST /auth/verify-password` controller from the refresh
   * cookie. When present, a successful verification updates that session's
   * recorded write authority IN PLACE — no token exchange, no new session, no
   * cookie — granting it the same authority a fresh login records. Every
   * other caller of this shared service (change-email, TOTP disable, passkey
   * removal, encrypted-workspace reset) omits it and is unaffected.
   */
  sessionTokenHash?: string;
  /**
   * The caller's device id + device-trust cookie value —
   * when both are present, a valid trust bypasses the backoff block and a
   * miss counts against that device's ceiling instead of the per-address
   * counter (see `FailedLoginService`). Omitted by callers that don't thread
   * device identity through (change-email, TOTP disable, passkey removal,
   * encrypted-workspace reset) — they keep today's per-address-only behavior.
   */
  deviceId?: string;
  deviceTrustToken?: string;
}

@Injectable()
export class VerifyPasswordService {
  private readonly logger = new Logger(VerifyPasswordService.name);

  constructor(
    private readonly credentials: CredentialsRepository,
    private readonly auth: AuthEventsRepository,
    private readonly users: UsersRepository,
    private readonly failed: FailedLoginService,
    private readonly refreshTokens: RefreshTokensRepository,
    private readonly trustedDevices: TrustedDeviceService,
  ) {}

  /**
   * Re-verify the caller's current password. Backoff is now centralized HERE:
   * every sensitive password-proof
   * endpoint that calls `verify()` inherits the same per-account backoff as the
   * login path — a stolen session can no longer use these endpoints as an
   * unthrottled password oracle. The EXTERNAL contract is unchanged: `verify()`
   * still resolves on a match and still throws `401 INVALID_CREDENTIALS` on a
   * wrong password (now backoff-counted first) or the raw fault on a
   * backend/Argon2 error (never counted), so its callers need no code change.
   *
   * The Argon2 comparison is wrapped in `FailedLoginService.verifyWithBackoff`,
   * whose callback must RETURN `false` on a wrong password (a THROWN error is
   * treated as a transient fault and skips recording a failure). The
   * `password_verify_failed` / `data_export_failed` audit is emitted inside the
   * callback immediately before returning `false`, preserving today's audit
   * behavior. The backoff counter is keyed by the caller's `emailLowercase`,
   * resolved from the User row (mirroring the destructive-op services).
   */
  async verify(args: VerifyPasswordArgs): Promise<void> {
    const isExport = args.purpose === 'data_export';

    // Captured by `check()` on a match, so the session-authority update below
    // reads the SAME row the verification just matched against, with no
    // second read.
    let matchedCredential: CredentialRow | null = null;

    const check = async (): Promise<boolean> => {
      const credential = await this.credentials.findByUserId(args.userId);
      const matches =
        credential !== null &&
        (await argon2.verify(credential.argon2Hash, args.currentPassword));
      if (!matches) {
        await this.auth.record({
          userId: args.userId,
          eventType: isExport ? 'data_export_failed' : 'password_verify_failed',
          ip: args.ip,
          userAgent: args.userAgent,
        });
        return false;
      }
      matchedCredential = credential;
      return true;
    };

    const user = await this.users.findById(args.userId);
    if (!user) {
      // No account row to key backoff against (a JWT-valid claim whose User row
      // is gone). Run the check directly — it will fail closed (no credential)
      // and emit the failed audit — and throw INVALID_CREDENTIALS without a
      // counter to touch. Matches today's behavior for a missing user.
      if (!(await check())) {
        throw new UnauthorizedException({
          code: 'INVALID_CREDENTIALS',
          message: 'Current password is incorrect.',
        });
      }
    } else {
      // Already-authenticated caller: `userId` is real, so — unlike login —
      // there is no unknown-identity branch to keep timing-equivalent with.
      // Resolve trust directly when the controller threaded a device id;
      // omitted callers get `undefined`, i.e. today's
      // unchanged per-address-only behavior.
      const trust = args.deviceId
        ? {
            trusted: await this.trustedDevices.verify(
              args.userId,
              args.deviceId,
              args.deviceTrustToken,
            ),
            userId: args.userId,
            deviceId: args.deviceId,
          }
        : undefined;
      // verifyWithBackoff throws 429 LOGIN_BACKOFF when locked out, records one
      // failure + throws 401 INVALID_CREDENTIALS on a `false`, and clears the
      // counter on a match. A thrown backend fault propagates uncounted.
      await this.failed.verifyWithBackoff({
        emailLowercase: user.emailLowercase,
        verify: check,
        ip: args.ip,
        userAgent: args.userAgent,
        trust,
      });
    }

    // Grant the current session the write authority a fresh login records —
    // updated IN PLACE, no token exchange, no
    // new session, no cookie. Only runs when the controller resolved a
    // session to update; every other purpose/caller is unaffected.
    //
    // Best-effort: this is a purely additive side write
    // whose only consumer is a LATER key-envelope password write, which
    // re-derives and re-checks the session's authority independently at that
    // point. A transient DynamoDB fault here (throttling, a network blip)
    // must never fail the whole `verify()` call — the argon2 comparison
    // already succeeded and the caller's actual purpose (data export, TOTP
    // disable, workspace clear, import, …) has nothing to do with password-
    // slot write authority. `updateCredentialRevision` already swallows a
    // `ConditionalCheckFailedException` (a concurrent logout raced this
    // update); swallow anything else here too, logging it so a persistent
    // failure is still visible.
    if (args.sessionTokenHash !== undefined) {
      try {
        await this.refreshTokens.updateCredentialRevision(
          args.userId,
          args.sessionTokenHash,
          resolveCredentialRevision(matchedCredential),
        );
      } catch (err) {
        this.logger.warn(
          'Failed to stamp session write authority after password verification (best-effort)',
          { userId: args.userId, reason: err instanceof Error ? err.name : 'unknown' },
        );
      }
    }

    await this.auth.record({
      userId: args.userId,
      eventType: isExport ? 'data_export' : 'password_verify',
      ip: args.ip,
      userAgent: args.userAgent,
    });
  }
}
