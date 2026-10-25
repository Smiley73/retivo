// The MFA account-deletion cascade: the DELETE /auth/account sweep purges user-mfa, mfa-email-otp and every trusted-device row. Every collaborator is stubbed;
// argon2 runs against a real hash so re-auth passes and the cascade reaches the auth-state sweep.
import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DeleteAccountService } from './delete-account.service.js';
import type { UsersRepository } from '../dynamo/users.repository.js';
import type { CredentialsRepository } from '../dynamo/credentials.repository.js';
import type { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import type { EmailVerificationsRepository } from '../dynamo/email-verifications.repository.js';
import type { PasswordResetsRepository } from '../dynamo/password-resets.repository.js';
import type { EmailReservationsRepository } from '../dynamo/email-reservations.repository.js';
import type { RefreshTokensRepository } from '../dynamo/refresh-tokens.repository.js';
import type { SignupApprovalsRepository } from '../dynamo/signup-approvals.repository.js';
import type { FailedLoginService } from './failed-login.service.js';
import type { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { AccountSnapshotPurgeService } from './account-snapshot-purge.service.js';
import type { HouseholdSweepService } from './household-sweep.service.js';
import type { HouseholdKeyEnvelopesRepository } from '../dynamo/household-key-envelopes.repository.js';
import type { UserMfaRepository } from '../dynamo/user-mfa.repository.js';
import type { MfaEmailOtpRepository } from '../dynamo/mfa-email-otp.repository.js';
import type { TrustedDeviceRepository } from '../dynamo/trusted-device.repository.js';
import type { TrustedDeviceService } from './trusted-device.service.js';
import type { StepUpService } from './step-up.service.js';
import type { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../common/env.config.js';
import type { UserRow, TrustedDeviceRow } from '../dynamo/types.js';

const PASSWORD = 'correct-horse-battery';

function user(): UserRow {
  return {
    userId: 'u1',
    email: 'a@b.test',
    emailLowercase: 'a@b.test',
    householdId: 'u1',
    emailVerifiedAt: new Date().toISOString(),
    createdAt: '',
    updatedAt: '',
  };
}

describe('DeleteAccountService — MFA cascade', () => {
  it('purges user-mfa, mfa-email-otp, and every trusted-device row', async () => {
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });

    const userMfaDelete = jest.fn().mockResolvedValue(undefined);
    const mfaEmailOtpDelete = jest.fn().mockResolvedValue(undefined);
    const mfaEmailOtpDeleteStepUp = jest.fn().mockResolvedValue(undefined);
    const trustedDeviceDelete = jest.fn().mockResolvedValue(undefined);
    const devices: TrustedDeviceRow[] = [
      {
        userId: 'u1',
        deviceId: 'dev1',
        tokenHash: 'h1',
        createdAt: '',
        expiresAt: 0,
        lastUsedAt: '',
        ip: null,
        userAgent: null,
      },
      {
        userId: 'u1',
        deviceId: 'dev2',
        tokenHash: 'h2',
        createdAt: '',
        expiresAt: 0,
        lastUsedAt: '',
        ip: null,
        userAgent: null,
      },
    ];

    const users = {
      findById: jest.fn().mockResolvedValue(user()),
      deleteByUserId: jest.fn().mockResolvedValue(undefined),
    } as unknown as UsersRepository;
    const credentials = {
      findByUserId: jest.fn().mockResolvedValue({ userId: 'u1', argon2Hash: hash, updatedAt: '' }),
      deleteByUserId: jest.fn().mockResolvedValue(undefined),
    } as unknown as CredentialsRepository;
    const passkeys = { deleteAllForUser: jest.fn().mockResolvedValue(undefined) } as unknown as PasskeysRepository;
    const emailVerifications = { deleteAllForUser: jest.fn().mockResolvedValue(undefined) } as unknown as EmailVerificationsRepository;
    const passwordResets = { deleteToken: jest.fn().mockResolvedValue(undefined) } as unknown as PasswordResetsRepository;
    const emailReservations = { delete: jest.fn().mockResolvedValue(undefined) } as unknown as EmailReservationsRepository;
    const refreshTokens = { deleteAllForUser: jest.fn().mockResolvedValue(undefined) } as unknown as RefreshTokensRepository;
    const approvals = { deleteAllForUser: jest.fn().mockResolvedValue(undefined) } as unknown as SignupApprovalsRepository;
    const failed = {
      checkBackoff: jest.fn().mockResolvedValue({ blocked: false }),
      recordFailure: jest.fn(),
      clear: jest.fn().mockResolvedValue(undefined),
      purgeAddress: jest.fn().mockResolvedValue(undefined),
      // Mirrors the real primitive's boolean contract: run the verify closure and reject on false so a wrong password still 401s.
      verifyWithBackoff: jest.fn(
        async (args: { emailLowercase: string; verify: () => Promise<boolean> }) => {
          const matches = await args.verify();
          if (!matches) {
            throw new UnauthorizedException({
              code: 'INVALID_CREDENTIALS',
              message: 'Current password is incorrect.',
            });
          }
        },
      ),
    } as unknown as FailedLoginService;
    const auth = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuthEventsRepository;
    const snapshotPurge = { purge: jest.fn().mockResolvedValue(undefined) } as unknown as AccountSnapshotPurgeService;
    const sweep = {
      revokeAllSessions: jest.fn().mockResolvedValue(undefined),
      sweepHouseholdData: jest.fn().mockResolvedValue(undefined),
    } as unknown as HouseholdSweepService;
    const keyEnvelopes = { deleteAllForHousehold: jest.fn().mockResolvedValue(undefined) } as unknown as HouseholdKeyEnvelopesRepository;
    const userMfa = { delete: userMfaDelete } as unknown as UserMfaRepository;
    const mfaEmailOtp = {
      delete: mfaEmailOtpDelete,
      deleteStepUp: mfaEmailOtpDeleteStepUp,
    } as unknown as MfaEmailOtpRepository;
    const trustedDevices = {
      listByUser: jest.fn().mockResolvedValue(devices),
      delete: trustedDeviceDelete,
    } as unknown as TrustedDeviceRepository;
    // AUTH_MFA_ENFORCED is unset, so `verify` is never called.
    const stepUpSvc = {
      verify: jest.fn().mockResolvedValue({ method: 'totp' }),
    } as unknown as StepUpService;
    const trustedDeviceSvc = { verify: jest.fn() } as unknown as TrustedDeviceService;
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService<EnvConfig, true>;

    const svc = new DeleteAccountService(
      users,
      credentials,
      passkeys,
      emailVerifications,
      passwordResets,
      emailReservations,
      refreshTokens,
      approvals,
      failed,
      auth,
      snapshotPurge,
      sweep,
      keyEnvelopes,
      userMfa,
      mfaEmailOtp,
      trustedDevices,
      stepUpSvc,
      trustedDeviceSvc,
      config,
    );

    await svc.deleteAccount({
      userId: 'u1',
      householdId: 'u1',
      currentJti: 'jti',
      currentAccessExp: Math.floor(Date.now() / 1000) + 300,
      currentPassword: PASSWORD,
      ip: null,
      userAgent: null,
    });

    expect(userMfaDelete).toHaveBeenCalledWith('u1');
    expect(mfaEmailOtpDelete).toHaveBeenCalledWith('u1');
    expect(mfaEmailOtpDeleteStepUp).toHaveBeenCalledWith('u1');
    expect(trustedDeviceDelete).toHaveBeenCalledWith('u1', 'dev1');
    expect(trustedDeviceDelete).toHaveBeenCalledWith('u1', 'dev2');
    expect(trustedDeviceDelete).toHaveBeenCalledTimes(2);
    // The cascade must purge the FailedLoginAttempt row (including any guessing-notice stamp), not call the stamp-preserving `clear()` a successful login uses.
    expect(failed.purgeAddress).toHaveBeenCalledWith('a@b.test');
    expect(failed.clear).not.toHaveBeenCalled();
    const events = (auth.record as jest.Mock).mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    expect(events).toEqual(['account_deletion_initiated', 'account_deletion_completed']);
  });
});
