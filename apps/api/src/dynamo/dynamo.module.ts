/**
 * Repository layer for every DynamoDB table the api Lambda touches.
 * One repository per table — keeps SDK calls out of the auth services
 * and makes per-table mocking trivial in tests.
 */
import { Global, Module } from '@nestjs/common';
import { AwsModule } from '../aws/aws.module.js';
import { AggregateVersionRepository } from './aggregate-version.repository.js';
import { AuthEventsRepository } from './auth-events.repository.js';
import { CredentialsRepository } from './credentials.repository.js';
import { DeviceRegistryRepository } from './device-registry.repository.js';
import { EmailReservationsRepository } from './email-reservations.repository.js';
import { EmailVerificationsRepository } from './email-verifications.repository.js';
import { FailedLoginAttemptsRepository } from './failed-login-attempts.repository.js';
import { HouseholdKeyEnvelopesRepository } from './household-key-envelopes.repository.js';
import { IdempotencyKeyRepository } from './idempotency-key.repository.js';
import { MfaEmailOtpRepository } from './mfa-email-otp.repository.js';
import { MutationLogRepository } from './mutation-log.repository.js';
import { PasskeyChallengeRepository } from './passkey-challenge.repository.js';
import { PasskeysRepository } from './passkeys.repository.js';
import { PasswordResetsRepository } from './password-resets.repository.js';
import { RefreshTokensRepository } from './refresh-tokens.repository.js';
import { RevokedTokensRepository } from './revoked-tokens.repository.js';
import { SignupApprovalsRepository } from './signup-approvals.repository.js';
import { ThrottleCounterRepository } from './throttle-counter.repository.js';
import { TrustedDeviceRepository } from './trusted-device.repository.js';
import { UserMfaRepository } from './user-mfa.repository.js';
import { UsersRepository } from './users.repository.js';
import { WorkspaceMetaRepository } from './workspace-meta.repository.js';

const repos = [
  AggregateVersionRepository,
  AuthEventsRepository,
  CredentialsRepository,
  DeviceRegistryRepository,
  EmailReservationsRepository,
  EmailVerificationsRepository,
  FailedLoginAttemptsRepository,
  HouseholdKeyEnvelopesRepository,
  IdempotencyKeyRepository,
  MfaEmailOtpRepository,
  MutationLogRepository,
  PasskeyChallengeRepository,
  PasskeysRepository,
  PasswordResetsRepository,
  RefreshTokensRepository,
  RevokedTokensRepository,
  SignupApprovalsRepository,
  ThrottleCounterRepository,
  TrustedDeviceRepository,
  UserMfaRepository,
  UsersRepository,
  WorkspaceMetaRepository,
];

@Global()
@Module({
  imports: [AwsModule],
  providers: repos,
  exports: repos,
})
export class DynamoModule {}
