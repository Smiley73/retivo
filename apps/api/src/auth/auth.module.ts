import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AwsModule } from '../aws/aws.module.js';
import { DynamoModule } from '../dynamo/dynamo.module.js';
import { AuthController } from './auth.controller.js';
import { MfaController } from './mfa.controller.js';
import { KeyEnvelopeController } from './key-envelope.controller.js';
import { PasskeyController } from './passkey.controller.js';
import { StepUpController } from './step-up.controller.js';
import { AccountExportController } from './account-export.controller.js';
import { FactorUndoController } from './factor-undo.controller.js';
import { AccountExportService } from './account-export.service.js';
import { SignupService } from './signup.service.js';
import { LoginService } from './login.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { ResendVerificationService } from './resend-verification.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { RefreshTokenService } from './refresh-token.service.js';
import { FailedLoginService } from './failed-login.service.js';
import { JwtKeyStore } from './jwt-key-store.js';
import { AccessTokenService } from './jwt.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { DataExportAuthorizationService } from './data-export-authorization.service.js';
import { PasswordValidatorService } from './password-validator.service.js';
import { HibpClient } from './hibp-client.js';
import { PasskeyChallengeStore } from './passkey-challenge-store.js';
import { PasskeyAssertionService } from './passkey-assertion.service.js';
import { ChangePasswordService } from './change-password.service.js';
import { ChangeEmailService } from './change-email.service.js';
import { DeleteAccountService } from './delete-account.service.js';
import { EncryptedWorkspaceResetService } from './encrypted-workspace-reset.service.js';
import { HouseholdSweepService } from './household-sweep.service.js';
import { AccountSnapshotPurgeService } from './account-snapshot-purge.service.js';
import { VerifyPasswordService } from './verify-password.service.js';
import { SignupApprovalService } from './signup-approval.service.js';
import { MfaService } from './mfa.service.js';
import { MfaChallengeService } from './mfa-challenge.service.js';
import { MfaEmailOtpService } from './mfa-email-otp.service.js';
import { StepUpService } from './step-up.service.js';
import { FactorEnrollmentGuardService } from './factor-enrollment-guard.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';
import { SessionRevocationService } from './session-revocation.service.js';
import { FactorNoticeService } from './factor-notice.service.js';
import { LoginGuessingNoticeService } from './login-guessing-notice.service.js';

@Global()
@Module({
  imports: [ConfigModule, AwsModule, DynamoModule],
  controllers: [
    AuthController,
    MfaController,
    KeyEnvelopeController,
    PasskeyController,
    StepUpController,
    AccountExportController,
    FactorUndoController,
  ],
  providers: [
    AccountExportService,
    JwtKeyStore,
    AccessTokenService,
    SignupService,
    LoginService,
    EmailVerificationService,
    ResendVerificationService,
    PasswordResetService,
    RefreshTokenService,
    FailedLoginService,
    PasswordValidatorService,
    HibpClient,
    PasskeyChallengeStore,
    PasskeyAssertionService,
    ChangePasswordService,
    ChangeEmailService,
    DeleteAccountService,
    EncryptedWorkspaceResetService,
    HouseholdSweepService,
    AccountSnapshotPurgeService,
    VerifyPasswordService,
    SignupApprovalService,
    MfaService,
    MfaChallengeService,
    MfaEmailOtpService,
    StepUpService,
    // Shared fresh-proof gate in front of the two factor-enrollment writes.
    FactorEnrollmentGuardService,
    TrustedDeviceService,
    // The one "revoke every session" implementation that sweep, change-password and password-reset delegate to.
    SessionRevocationService,
    FactorNoticeService,
    LoginGuessingNoticeService,
    DataExportAuthorizationService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
  exports: [
    AccessTokenService,
    JwtKeyStore,
    SignupApprovalService,
    // Exported so SyncModule `RestoreService` can inject the shared sweep (see AGENTS.md, "Project-specific security");
    // AuthModule is @Global().
    HouseholdSweepService,
    // Exported for SyncModule services: the `workspace/clear` password gate and `RestoreService` keep-key purge.
    VerifyPasswordService,
    FailedLoginService,
    AccountSnapshotPurgeService,
  ],
})
export class AuthModule {}
