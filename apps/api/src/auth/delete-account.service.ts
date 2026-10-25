// Account deletion orchestrator: password verify, then purge S3 snapshots before the irreversible DynamoDB and auth sweeps, so a purge failure
// leaves the account intact. See docs/security.md, "Deleting and exporting your data".
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
  /** Fresh step-up factor, required when `AUTH_MFA_ENFORCED` is on. */
  method?: StepUpMethod;
  code?: string;
  assertion?: AuthenticationResponseJSON;
  ip: string | null;
  userAgent: string | null;
  /** Lets a trusted device bypass the per-address backoff, as in login. */
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
      // The claim says the user exists but the row is gone: INVALID_CREDENTIALS, so a partial prior cascade leaks no
      // state.
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect.',
      });
    }

    // Password re-verify under the shared per-account backoff: a lockout is 429 before argon2, a wrong password
    // records one failure and throws INVALID_CREDENTIALS, and a backend fault propagates uncounted. Verified
    // directly against argon2 with no `password_verify` event, so `_initiated` stays the first event after a
    // successful verify. Trust resolves directly since the caller is authenticated.
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

    // Fresh step-up after the password gate when `AUTH_MFA_ENFORCED` is on, before any destructive work;
    // `StepUpService` emits its own audit.
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

    // Audit first: the AuthEvent table is not swept, so the initiated event survives an aborted cascade.
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

    // Purge S3 snapshots before any irreversible delete: a failure here leaves the account intact (only sessions
    // revoked), the most reversible outcome. A re-issued DELETE re-verifies the password and re-runs the cascade.
    await this.snapshotPurge.purge(args.householdId);

    // Shared household sweep (see AGENTS.md, "Project-specific security").
    await this.sweep.sweepHouseholdData(args.householdId);
    // Drop the key-envelope rows so a deleted account leaves no key material; outside the shared sweep because that
    // table is outside the compactor boundary.
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
    // Sweep the dangling password-reset row by the `currentResetToken` handle: a single keyed delete, no Scan grant
    // needed.
    if (currentResetToken) {
      await this.passwordResets.deleteToken(currentResetToken);
    }
    await this.approvals.deleteAllForUser(userId);
    // MFA cascade: `UserMfa` and `MfaEmailOtp` are keyed deletes; `TrustedDevice` is listed by PK (a Query) then
    // deleted.
    await this.userMfa.delete(userId);
    await this.mfaEmailOtp.delete(userId);
    // Also drop the namespaced `<userId>#stepup` Email-OTP row.
    await this.mfaEmailOtp.deleteStepUp(userId);
    const devices = await this.trustedDevices.listByUser(userId);
    await Promise.all(
      devices.map((d) => this.trustedDevices.delete(userId, d.deviceId)),
    );
    // Unconditional: `clear()` preserves a guessing-notice stamp, which would otherwise leak into a new account
    // reusing the freed address.
    await this.failed.purgeAddress(emailLowercase);
    await this.credentials.deleteByUserId(userId);
    await this.users.deleteByUserId(userId);
    await this.emailReservations.delete(emailLowercase);
  }
}
