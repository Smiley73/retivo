// Session-preserving password re-verification for destructive client-only flows. Not side-effect-free: it shares the per-account login
// backoff, so a stolen session cannot use it as an unthrottled password oracle.
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
   * Re-auth purpose. `data_export` records `data_export` audit events instead of the generic `password_verify` pair;
   * `change_password` and `password_slot_rewrap` keep the generic events. Omitted by import, demo and reset.
   */
  purpose?: 'data_export' | 'change_password' | 'password_slot_rewrap';
  /**
   * The current session refresh-token hash, resolved by the controller. When present, a successful verification
   * updates that session recorded write authority in place (no new session or cookie), granting what a fresh login
   * records. Other callers omit it.
   */
  sessionTokenHash?: string;
  /**
   * Caller device id and trust cookie: a valid trust bypasses the backoff block and a miss counts against that device
   * ceiling. Callers that do not thread device identity keep per-address-only behaviour.
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
   * Re-verifies the caller current password with the centralized backoff: resolves on a match, throws 401
   * INVALID_CREDENTIALS on a wrong password (backoff-counted), or the raw fault on a backend or Argon2 error (never
   * counted). The callback passed to `verifyWithBackoff` must return false on a wrong password, since a thrown error
   * counts as a transient fault; the failed audit is emitted just before returning false. The counter is keyed by the
   * `emailLowercase` resolved from the User row.
   */
  async verify(args: VerifyPasswordArgs): Promise<void> {
    const isExport = args.purpose === 'data_export';

    // Captured on a match so the session-authority update reads the same row, with no second read.
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
      // No account row (a JWT-valid claim whose User row is gone): run the check directly, which fails closed with
      // the failed audit, and throw INVALID_CREDENTIALS.
      if (!(await check())) {
        throw new UnauthorizedException({
          code: 'INVALID_CREDENTIALS',
          message: 'Current password is incorrect.',
        });
      }
    } else {
      // The caller is authenticated, so there is no unknown-identity branch to keep timing-equivalent; resolve trust
      // directly when a device id was threaded.
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
      // `verifyWithBackoff` throws 429 LOGIN_BACKOFF when locked out, records one failure and throws 401 on false,
      // clears the counter on a match; a backend fault propagates uncounted.
      await this.failed.verifyWithBackoff({
        emailLowercase: user.emailLowercase,
        verify: check,
        ip: args.ip,
        userAgent: args.userAgent,
        trust,
      });
    }

    // Grant the session the write authority a login records, in place. Best-effort: it is an additive side write
    // whose only consumer re-checks the authority independently later, so a transient DynamoDB fault must not fail
    // a verification whose argon2 comparison already succeeded. Swallow and log so a persistent failure stays
    // visible.
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
