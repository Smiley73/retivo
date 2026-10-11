/**
 * Shared, unconditional fresh-proof gate in front of the two factor-
 * enrollment WRITES: `passkey.controller.ts#registerFinish` and
 * `mfa.controller.ts#mfaTotpEnrollConfirm`. One
 * helper so a future enrollment route cannot forget it.
 *
 * Deliberately has NO `if (!mfaEnforced) return` early-out:
 * the current-password re-verify below runs on EVERY call, so a hijacked
 * session — which never holds the password — cannot enroll a factor on any
 * stack, with any value of `AUTH_MFA_ENFORCED`. The fresh second-factor
 * step-up layers on top only when the flag is on, mirroring the existing
 * `mfaTotpDisable` / passkey `remove` gates' password-always-first shape —
 * with ONE deliberate difference: the emailed code satisfies an ENROLLMENT
 * only while the account has no eligible enrolled factor. Removal/disable keep the Email-OTP floor to prevent
 * lockout; enrollment carries no lockout risk, so there is no recovery
 * floor here.
 */
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { StepUpService, type StepUpMethod, type StepUpPurpose } from './step-up.service.js';
import { VerifyPasswordService } from './verify-password.service.js';

/** The fresh-proof body a factor-enrollment write carries — the collapsed
 * shape of `FactorEnrollmentStepUpProofDto` (dto/passkey.dto.ts). */
export interface FactorEnrollmentProof {
  currentPassword: string;
  method?: StepUpMethod;
  code?: string;
  response?: AuthenticationResponseJSON;
}

/** The two enrollment purposes this gate serves. */
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
   * Enforce the gate. Throws `401 INVALID_CREDENTIALS` on a wrong password,
   * `400 STEP_UP_PROOF_MISSING` on a missing factor (flag on),
   * `401 STEP_UP_FACTOR_NOT_ELIGIBLE` on an emailed code offered by an account
   * that already has an eligible passkey/authenticator, or the factor-specific
   * rejection from `StepUpService.verify` on a wrong one — matching the
   * neighbouring gated operations rather than inventing a new status. A
   * missing or ineligible proof is audited exactly like a wrong one
   * (`recordMissingProofFailure` / `recordIneligibleFactorFailure` /
   * `StepUpService`'s own `step_up_failed`); this gate ALSO records a single
   * `factor_enrollment_blocked` row on any refusal so "was an enrollment
   * blocked" is directly queryable without joining on purpose metadata.
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
      // Which factor may prove an ENROLLMENT: an existing enrolled,
      // non-restricted factor — or the emailed code ONLY while the account has
      // none. `computeFactors` lists `email_otp` exactly then (restricted
      // factors are already filtered out of it, so a restricted-only account
      // keeps the floor and cannot be bricked). Without this, an attacker
      // holding the password and the mailbox — but not the victim's passkey or
      // authenticator — could mint an unrestricted, MFA-free credential on an
      // account that already has one, with no reset ever requested and so no
      // restriction window to catch it. Checked BEFORE `verify` so a refused
      // attempt does not consume the emailed code.
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
