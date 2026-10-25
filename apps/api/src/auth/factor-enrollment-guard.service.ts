// Unconditional fresh-proof gate in front of the two factor-enrollment writes. The password re-verify runs with any `AUTH_MFA_ENFORCED` value,
// so a hijacked session cannot enroll a factor; the emailed code satisfies an enrollment only while no eligible factor exists.
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { StepUpService, type StepUpMethod, type StepUpPurpose } from './step-up.service.js';
import { VerifyPasswordService } from './verify-password.service.js';

/** The fresh-proof body of a factor-enrollment write (the collapsed `FactorEnrollmentStepUpProofDto`). */
export interface FactorEnrollmentProof {
  currentPassword: string;
  method?: StepUpMethod;
  code?: string;
  response?: AuthenticationResponseJSON;
}

export type FactorEnrollmentPurpose = Extract<
  StepUpPurpose,
  'passkey_enroll' | 'mfa_totp_enroll'
>;

@Injectable()
export class FactorEnrollmentGuardService {
  constructor(
    private readonly verifyPasswordSvc: VerifyPasswordService,
    private readonly stepUpSvc: StepUpService,
    private readonly auth: AuthEventsRepository,
  ) {}

  /**
   * Enforces the gate. Throws 401 INVALID_CREDENTIALS (wrong password), 400 STEP_UP_PROOF_MISSING (missing factor,
   * flag on), 401 STEP_UP_FACTOR_NOT_ELIGIBLE (emailed code from an account with an eligible factor), or the
   * factor-specific rejection. Refusals are audited like wrong proofs and also record one `factor_enrollment_blocked`
   * row.
   */
  async enforce(args: {
    userId: string;
    purpose: FactorEnrollmentPurpose;
    proof: FactorEnrollmentProof;
    mfaEnforced: boolean;
    ip: string | null;
    userAgent: string | null;
  }): Promise<void> {
    try {
      await this.verifyPasswordSvc.verify({
        userId: args.userId,
        currentPassword: args.proof.currentPassword,
        ip: args.ip,
        userAgent: args.userAgent,
      });
      if (!args.mfaEnforced) return;
      if (!args.proof.method) {
        await this.stepUpSvc.recordMissingProofFailure({
          userId: args.userId,
          purpose: args.purpose,
          ip: args.ip,
          userAgent: args.userAgent,
        });
        throw new BadRequestException({
          code: 'STEP_UP_PROOF_MISSING',
          message: 'A second factor is required to add this sign-in method.',
        });
      }
      // An enrollment is proved by an existing non-restricted factor, or by the emailed code only while the account has
      // none (`computeFactors` lists `email_otp` exactly then, so a restricted-only account keeps the floor). Otherwise
      // an attacker with the password and mailbox, but not the passkey or authenticator, could mint an unrestricted
      // credential with no reset ever requested. Checked before `verify` so a refusal does not consume the emailed
      // code.
      if (args.proof.method === 'email_otp') {
        const { methods } = await this.stepUpSvc.computeFactors(args.userId);
        if (!methods.includes('email_otp')) {
          await this.stepUpSvc.recordIneligibleFactorFailure({
            userId: args.userId,
            purpose: args.purpose,
            method: 'email_otp',
            ip: args.ip,
            userAgent: args.userAgent,
          });
          throw new UnauthorizedException({
            code: 'STEP_UP_FACTOR_NOT_ELIGIBLE',
            message:
              "An emailed code can't add a new sign-in method once you have an authenticator app or passkey. Confirm with one of those instead.",
          });
        }
      }
      await this.stepUpSvc.verify({
        userId: args.userId,
        purpose: args.purpose,
        method: args.proof.method,
        code: args.proof.code,
        assertion: args.proof.response,
        ip: args.ip,
        userAgent: args.userAgent,
      });
    } catch (err) {
      await this.auth.record({
        userId: args.userId,
        eventType: 'factor_enrollment_blocked',
        ip: args.ip,
        userAgent: args.userAgent,
        metadata: { purpose: args.purpose },
      });
      throw err;
    }
  }
}
