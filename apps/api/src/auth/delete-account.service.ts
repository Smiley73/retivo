/**
 * Account deletion orchestrator. Verifies the caller's password, then
 * hard-deletes every S3 snapshot + household-scoped row + auth row for
 * the user. Hard delete on confirm — no soft-delete window in v1. See
 * docs/security.md, "Deleting and exporting your data".
 *
 * Cascade order (purge-first):
 * password verify → audit initiated → revoke sessions → S3 snapshot
 * purge (delegated to the dedicated AccountSnapshotPurgeService /
 * least-privilege purge Lambda) → shared DynamoDB household sweep
 * (HouseholdSweepService) → HouseholdKeyEnvelope sweep →
 * auth-state sweep → audit completed. The snapshot purge runs BEFORE the
 * irreversible DynamoDB / auth sweeps so a purge failure leaves the account
 * fully intact (only sessions revoked, recoverable by re-login). The
 * key-envelope rows are deleted alongside the household sync rows so a deleted
 * account leaves no wrapped key material behind (zero-knowledge cascade).
 *
 * The household-row sweep + session revocation are extracted into the
 * shared HouseholdSweepService so the encrypted-workspace
 * reset reuses the exact same audited path — no second BatchWriteItem
 * code path.
 *
 * The api-role IAM widening this needs (BatchWriteItem on
 * MutationLog/IdempotencyKey/AggregateVersion/DeviceRegistry +
 * lambda:InvokeFunction on the purge Lambda) now serves both the
 * DELETE /auth/account cascade and the encrypted-workspace reset via the
 * shared sweep. The api role no longer holds bucket-wide s3:DeleteObject.
 */
import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { EnvConfig } from '../common/env.config.js';
import { AccountSnapshotPurgeService } from './account-snapshot-purge.service.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { CredentialsRepository } from '../dynamo/credentials.repository.js';
import { EmailReservationsRepository } from '../dynamo/email-reservations.repository.js';
import { EmailVerificationsRepository } from '../dynamo/email-verifications.repository.js';
import { PasswordResetsRepository } from '../dynamo/password-resets.repository.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import { RefreshTokensRepository } from '../dynamo/refresh-tokens.repository.js';
import { SignupApprovalsRepository } from '../dynamo/signup-approvals.repository.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { UserMfaRepository } from '../dynamo/user-mfa.repository.js';
import { MfaEmailOtpRepository } from '../dynamo/mfa-email-otp.repository.js';
import { TrustedDeviceRepository } from '../dynamo/trusted-device.repository.js';
import { HouseholdKeyEnvelopesRepository } from '../dynamo/household-key-envelopes.repository.js';
import { FailedLoginService } from './failed-login.service.js';
import { HouseholdSweepService } from './household-sweep.service.js';
import { StepUpService, type StepUpMethod } from './step-up.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';

export interface DeleteAccountArgs {
  userId: string;
  householdId: string;
  currentJti: string;
  currentAccessExp: number;
  currentPassword: string;
  /** Fresh step-up factor — required when
   * `AUTH_MFA_ENFORCED` is on, absent on the flag-off password-only floor. */
  method?: StepUpMethod;
  code?: string;
  assertion?: AuthenticationResponseJSON;
  ip: string | null;
  userAgent: string | null;
  /** Device identity — lets a trusted device's password
   *  re-verify bypass the per-address backoff, mirroring login. */
  deviceId?: string;
  deviceTrustToken?: string;
}

@Injectable()
export class DeleteAccountService {
  private readonly mfaEnforced: boolean;

  constructor(
    private readonly users: UsersRepository,
    private readonly credentials: CredentialsRepository,
    private readonly passkeys: PasskeysRepository,
    private readonly emailVerifications: EmailVerificationsRepository,
    private readonly passwordResets: PasswordResetsRepository,
    private readonly emailReservations: EmailReservationsRepository,
    private readonly refreshTokens: RefreshTokensRepository,
    private readonly approvals: SignupApprovalsRepository,
    private readonly failed: FailedLoginService,
    private readonly auth: AuthEventsRepository,
    private readonly snapshotPurge: AccountSnapshotPurgeService,
    private readonly sweep: HouseholdSweepService,
    private readonly keyEnvelopes: HouseholdKeyEnvelopesRepository,
    private readonly userMfa: UserMfaRepository,
    private readonly mfaEmailOtp: MfaEmailOtpRepository,
    private readonly trustedDevices: TrustedDeviceRepository,
    private readonly stepUpSvc: StepUpService,
    private readonly trustedDeviceSvc: TrustedDeviceService,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.mfaEnforced = config.get('AUTH_MFA_ENFORCED', { infer: true }) === 'true';
  }

  async deleteAccount(args: DeleteAccountArgs): Promise<void> {
    const user = await this.users.findById(args.userId);
    if (!user) {
      // The JWT claim says this user exists but the row is gone — treat as
      // INVALID_CREDENTIALS so a partially-completed prior cascade doesn't
      // leak state to the caller.
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect.',
      });
    }

    // Password re-verify wrapped with the shared per-account backoff —
    // the same primitive POST /sync/workspace/clear uses. checkBackoff runs
    // first (a lockout throws 429 before argon2 is ever paid), then the argon2
    // verify inside the closure resolves whether the password matches: a
    // `false` makes the helper record one failure + throw INVALID_CREDENTIALS,
    // a match clears the counter, and a backend/argon2 fault propagates out of
    // the closure WITHOUT touching the counter (a transient error after
    // a correct password must never count as a failed attempt). Verified
    // directly against argon2 here (no `password_verify` AuthEvent, preserving
    // delete-account's audit contract: `_initiated` is the first event, only
    // after a successful verify).
    // Already-authenticated caller: `userId` is real, so no unknown-identity
    // timing concern (unlike login). Resolve trust directly when the
    // controller threaded a device id.
    const trust = args.deviceId
      ? {
          trusted: await this.trustedDeviceSvc.verify(
            args.userId,
            args.deviceId,
            args.deviceTrustToken,
          ),
          userId: args.userId,
          deviceId: args.deviceId,
        }
      : undefined;
    await this.failed.verifyWithBackoff({
      emailLowercase: user.emailLowercase,
      verify: async () => {
        const credential = await this.credentials.findByUserId(args.userId);
        return credential
          ? await argon2.verify(credential.argon2Hash, args.currentPassword)
          : false;
      },
      ip: args.ip,
      userAgent: args.userAgent,
      trust,
    });

    // Fresh second-factor step-up — required after
    // the password gate when `AUTH_MFA_ENFORCED` is on; the flag-off floor is
    // password-only, so this is skipped entirely there (preserving today's
    // local-dev UX). The `StepUpService` emits its own `step_up_passed`/`_failed`
    // audit and throws `MFA_CODE_INVALID` (or a passkey-specific code) on a bad
    // factor before any destructive work runs.
    if (this.mfaEnforced) {
      if (!args.method) {
        throw new BadRequestException({
          code: 'STEP_UP_PROOF_MISSING',
          message: 'A second factor is required to delete your account.',
        });
      }
      await this.stepUpSvc.verify({
        userId: args.userId,
        purpose: 'delete_account',
        method: args.method,
        code: args.code,
        assertion: args.assertion,
        ip: args.ip,
        userAgent: args.userAgent,
      });
    }

    // Audit first — the AuthEvent table is intentionally not swept, so the
    // initiated event survives even if the cascade aborts mid-flight.
    await this.auth.record({
      userId: args.userId,
      eventType: 'account_deletion_initiated',
      ip: args.ip,
      userAgent: args.userAgent,
      metadata: { householdId: args.householdId },
    });

    await this.sweep.revokeAllSessions({
      userId: args.userId,
      currentJti: args.currentJti,
      currentAccessExp: args.currentAccessExp,
    });

    // Purge S3 snapshots BEFORE any irreversible DynamoDB / auth-state
    // delete. A purge failure throws here, failing the request with the
    // account still fully intact (only sessions revoked, recoverable by
    // re-login) — the most reversible outcome. The initiated audit row
    // above survives as evidence of the attempt. A re-issued DELETE
    // re-verifies the password and re-runs the cascade.
    await this.snapshotPurge.purge(args.householdId);

    // Shared household-data sweep — MutationLog,
    // IdempotencyKey, AggregateVersion, WorkspaceMeta, DeviceRegistry.
    await this.sweep.sweepHouseholdData(args.householdId);
    // Zero-knowledge cascade: drop the household's wrapped
    // key-envelope rows (all slots + the ENVELOPE_META sentinel) so a deleted
    // account leaves no key material behind. Not part of the shared sweep —
    // the key-envelope table is outside the compactor boundary and this
    // delete is account-deletion / encrypted-workspace-reset only.
    await this.keyEnvelopes.deleteAllForHousehold(args.householdId);
    await this.sweepAuthState(args.userId, user.emailLowercase, user.currentResetToken ?? null);

    await this.auth.record({
      userId: args.userId,
      eventType: 'account_deletion_completed',
      ip: args.ip,
      userAgent: args.userAgent,
      metadata: { householdId: args.householdId },
    });
  }

  private async sweepAuthState(
    userId: string,
    emailLowercase: string,
    currentResetToken: string | null,
  ): Promise<void> {
    await this.refreshTokens.deleteAllForUser(userId);
    await this.passkeys.deleteAllForUser(userId);
    await this.emailVerifications.deleteAllForUser(userId);
    // Sweep the user's dangling password-reset row by the
    // `currentResetToken` handle — a single keyed delete, no Scan, so
    // no Scan IAM grant is needed on the PasswordReset table.
    if (currentResetToken) {
      await this.passwordResets.deleteToken(currentResetToken);
    }
    await this.approvals.deleteAllForUser(userId);
    // MFA cascade: drop the user's TOTP state, any
    // live Email-OTP code, and every trusted-device
    // trust row. `UserMfa` / `MfaEmailOtp` are single keyed deletes;
    // `TrustedDevice` is keyed `(userId, deviceId)`, so list-then-delete by PK
    // (a Query, no Scan) clears every SK row under the user.
    await this.userMfa.delete(userId);
    await this.mfaEmailOtp.delete(userId);
    // Also drop the namespaced step-up Email-OTP code row — step-up creates this `<userId>#stepup` row,
    // so its cleanup lands here alongside the login code row's delete.
    await this.mfaEmailOtp.deleteStepUp(userId);
    const devices = await this.trustedDevices.listByUser(userId);
    await Promise.all(
      devices.map((d) => this.trustedDevices.delete(userId, d.deviceId)),
    );
    // Unconditional purge — `clear()`
    // deliberately preserves an existing guessing-notice stamp, which would
    // otherwise survive this account's deletion and leak into a newly
    // registered account that reuses the freed address.
    await this.failed.purgeAddress(emailLowercase);
    await this.credentials.deleteByUserId(userId);
    await this.users.deleteByUserId(userId);
    await this.emailReservations.delete(emailLowercase);
  }
}
