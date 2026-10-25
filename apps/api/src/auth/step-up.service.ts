// Shared step-up re-authentication: a stateless fresh-factor check (TOTP, Email-OTP, passkey) with the single factor-eligibility computation.
// It emits the `step_up_*` audit and never logs the password, codes or assertion. See docs/security.md, "Step-up for sensitive actions".
import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { UserMfaRepository } from '../dynamo/user-mfa.repository.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import { MfaService } from './mfa.service.js';
import { MfaEmailOtpService } from './mfa-email-otp.service.js';
import { PasskeyAssertionService } from './passkey-assertion.service.js';
import { VerifyPasswordService } from './verify-password.service.js';

/**
 * The sensitive operations a step-up can gate; each is the purpose stamp that scopes the passkey challenge namespace
 * and the Email-OTP code.
 */
export const STEP_UP_PURPOSES = [
  'change_email',
  'delete_account',
  'encrypted_workspace_reset',
  'change_password',
  'mfa_totp_disable',
  'passkey_remove',
  'workspace_clear',
  // A stolen bearer session must not be able to destroy a household ability to unlock its data. `replace` covers a
  // PUT that displaces an existing slot (the canonical password slot only when a re-wrap is not owed), `delete`
  // covers DELETE; the split records which write shape ran. See key-envelope-step-up.ts.
  'key_envelope_replace',
  'key_envelope_delete',
  // Factor-enrollment gate: distinct purposes so a proof for another operation cannot satisfy it. Reused for the
  // matching `confirm-restriction` lift.
  'passkey_enroll',
  'mfa_totp_enroll',
] as const;

export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number];

export type StepUpMethod = 'totp' | 'email_otp' | 'passkey';

type StepUpRoutineMethod = 'passkey' | 'totp' | 'email_otp';
type StepUpRecoveryMethod = 'email_otp';

export interface StepUpFactors {
  methods: StepUpRoutineMethod[];
  recoveryMethods: StepUpRecoveryMethod[];
}

export interface StepUpVerifyArgs {
  userId: string;
  purpose: StepUpPurpose;
  method: StepUpMethod;
  code?: string;
  assertion?: AuthenticationResponseJSON;
  /** When present, a password re-verify runs before the factor; never logged. */
  currentPassword?: string;
  ip: string | null;
  userAgent: string | null;
  /**
   * Email-OTP source: `stepup` (default) is the purpose-bound `<userId>#stepup` row; `legacy` is the `<userId>` row
   * (change-email, bound by its pending intent).
   */
  emailOtpSource?: 'legacy' | 'stepup';
}

@Injectable()
export class StepUpService {
  constructor(
    private readonly auth: AuthEventsRepository,
    private readonly userMfa: UserMfaRepository,
    private readonly passkeys: PasskeysRepository,
    private readonly mfaSvc: MfaService,
    private readonly mfaEmailOtpSvc: MfaEmailOtpService,
    private readonly passkeyAssertions: PasskeyAssertionService,
    private readonly verifyPasswordSvc: VerifyPasswordService,
  ) {}

  /**
   * The account eligible step-up factors, computed like login-MFA `methods` and `recoveryMethods`: passkey when
   * enrolled, totp when enrolled, else `email_otp` as the no-lockout floor; recovery is always Email-OTP.
   */
  async computeFactors(userId: string): Promise<StepUpFactors> {
    const [mfa, passkeys] = await Promise.all([
      this.userMfa.get(userId),
      this.passkeys.listForUser(userId),
    ]);
    // A factor restricted post-reset is not eligible and stays refused if named directly; the verifiers check the
    // resolved row, not this list.
    const totpEnabled = !!mfa?.totpEnabled && !mfa.totpRestrictedPostReset;
    const hasPasskey = passkeys.some((p) => !p.restrictedPostReset);
    const methods: StepUpRoutineMethod[] = [];
    if (hasPasskey) methods.push('passkey');
    if (totpEnabled) methods.push('totp');
    if (methods.length === 0) methods.push('email_otp');
    return {
      methods,
      recoveryMethods: ['email_otp'],
    };
  }

  /**
   * Verifies a fresh second factor for `purpose` on the session: emits `step_up_passed` and returns the method, or
   * `step_up_failed` and throws MFA_CODE_INVALID (passkey and Email-OTP surface their own codes). An optional
   * `currentPassword` is re-verified first.
   */
  async verify(args: StepUpVerifyArgs): Promise<{ method: StepUpMethod; factorId?: string }> {
    if (args.currentPassword !== undefined) {
      await this.verifyPasswordSvc.verify({
        userId: args.userId,
        currentPassword: args.currentPassword,
        ip: args.ip,
        userAgent: args.userAgent,
      });
    }

    let result: { ok: boolean; factorId?: string };
    try {
      result = await this.verifyFactor(args);
    } catch (err) {
      // A factor service threw a typed failure: record the step-up failure with operation context, then rethrow the
      // specific code.
      await this.recordFailed(args);
      throw err;
    }
    if (!result.ok) {
      await this.recordFailed(args);
      throw new UnauthorizedException({
        code: 'MFA_CODE_INVALID',
        message: 'The code is incorrect or no longer valid.',
      });
    }

    await this.auth.record({
      userId: args.userId,
      eventType: 'step_up_passed',
      ip: args.ip,
      userAgent: args.userAgent,
      metadata: { purpose: args.purpose, method: args.method },
    });
    // `factorId` is the passkey credentialId for `passkey`, absent for the code factors; `confirmRestricted*` uses
    // it to identify the proving factor.
    return { method: args.method, factorId: result.factorId };
  }

  /**
   * Audits `step_up_failed` for a missing proof, so missing and wrong factors are both audited; callers then throw
   * STEP_UP_PROOF_MISSING. `method: none` marks the absent proof.
   */
  async recordMissingProofFailure(args: {
    userId: string;
    purpose: StepUpPurpose;
    ip: string | null;
    userAgent: string | null;
  }): Promise<void> {
    await this.auth.record({
      userId: args.userId,
      eventType: 'step_up_failed',
      ip: args.ip,
      userAgent: args.userAgent,
      metadata: { purpose: args.purpose, method: 'none', reason: 'missing_proof' },
    });
  }

  /**
   * Audits `step_up_failed` for a factor the operation does not accept on this account (the enrollment gate refusing
   * `email_otp` once a passkey or authenticator exists); `reason: factor_not_eligible` separates it from a wrong or
   * missing proof.
   */
  async recordIneligibleFactorFailure(args: {
    userId: string;
    purpose: StepUpPurpose;
    method: StepUpMethod;
    ip: string | null;
    userAgent: string | null;
  }): Promise<void> {
    await this.auth.record({
      userId: args.userId,
      eventType: 'step_up_failed',
      ip: args.ip,
      userAgent: args.userAgent,
      metadata: { purpose: args.purpose, method: args.method, reason: 'factor_not_eligible' },
    });
  }

  // Dispatches to the per-factor verifier; never logs the proof.
  private async verifyFactor(
    args: StepUpVerifyArgs,
  ): Promise<{ ok: boolean; factorId?: string }> {
    switch (args.method) {
      case 'totp':
        return {
          ok: await this.mfaSvc.verifyTotpForStepUp(
            args.userId,
            this.requireCode(args.code),
            args.ip,
            args.userAgent,
          ),
        };
      case 'email_otp': {
        const code = this.requireCode(args.code);
        if ((args.emailOtpSource ?? 'stepup') === 'legacy') {
          return {
            ok: (
              await this.mfaEmailOtpSvc.verify({
                userId: args.userId,
                code,
                ip: args.ip,
                userAgent: args.userAgent,
              })
            ).ok,
          };
        }
        return {
          ok: (
            await this.mfaEmailOtpSvc.verifyStepUp({
              userId: args.userId,
              code,
              purpose: args.purpose,
              ip: args.ip,
              userAgent: args.userAgent,
            })
          ).ok,
        };
      }
      case 'passkey': {
        if (!args.assertion) {
          throw new BadRequestException({
            code: 'STEP_UP_PROOF_MISSING',
            message: 'A passkey assertion is required for this factor.',
          });
        }
        // Throws on every failure; a clean return means verified.
        const { credentialId } = await this.passkeyAssertions.verifyStepUpAssertion(
          args.userId,
          args.purpose,
          args.assertion,
        );
        return { ok: true, factorId: credentialId };
      }
    }
  }

  private requireCode(code: string | undefined): string {
    if (code === undefined || code.length === 0) {
      throw new BadRequestException({
        code: 'STEP_UP_PROOF_MISSING',
        message: 'A code is required for this factor.',
      });
    }
    return code;
  }

  private async recordFailed(args: StepUpVerifyArgs): Promise<void> {
    await this.auth.record({
      userId: args.userId,
      eventType: 'step_up_failed',
      ip: args.ip,
      userAgent: args.userAgent,
      metadata: { purpose: args.purpose, method: args.method },
    });
  }

  // ---------- Restricted-factor confirmation ----------
  // Lifts the post-reset restriction on one named factor. Removal stays the escape hatch (already step-up-gated) when
  // nothing predates the reset.

  /**
   * Lifts the restriction on one named passkey. Needs a fresh proof from a different, already-enrolled,
   * non-restricted factor whose enrollment predates the reset request that opened the window, checked server-side.
   * Throws FACTOR_NOT_RESTRICTED (400) or STEP_UP_FACTOR_RESTRICTED (401).
   */
  async confirmRestrictedPasskey(args: {
    userId: string;
    credentialId: string;
    method: 'totp' | 'passkey';
    code?: string;
    assertion?: AuthenticationResponseJSON;
    ip: string | null;
    userAgent: string | null;
  }): Promise<void> {
    const target = await this.passkeys.find(args.userId, args.credentialId);
    if (!target?.restrictedPostReset) {
      throw new BadRequestException({
        code: 'FACTOR_NOT_RESTRICTED',
        message: 'This passkey is not waiting for confirmation.',
      });
    }
    const { factorId } = await this.verify({
      userId: args.userId,
      purpose: 'passkey_enroll',
      method: args.method,
      code: args.code,
      assertion: args.assertion,
      ip: args.ip,
      userAgent: args.userAgent,
    });
    await this.assertProvingFactorPredates({
      userId: args.userId,
      method: args.method,
      factorId,
      restrictedByResetRequestedAt: target.restrictedByResetRequestedAt,
      excludeCredentialId: args.credentialId,
    });
    await this.passkeys.clearRestriction(args.userId, args.credentialId);
    await this.auth.record({
      userId: args.userId,
      eventType: 'factor_restriction_lifted',
      ip: args.ip,
      userAgent: args.userAgent,
      metadata: { credentialId: args.credentialId, factorType: 'passkey' },
    });
  }

  /**
   * Lifts the restriction on the singular TOTP factor, with the same proof and predates-the-reset requirement as
   * `confirmRestrictedPasskey`.
   */
  async confirmRestrictedTotp(args: {
    userId: string;
    method: 'totp' | 'passkey';
    code?: string;
    assertion?: AuthenticationResponseJSON;
    ip: string | null;
    userAgent: string | null;
  }): Promise<void> {
    const target = await this.userMfa.get(args.userId);
    if (!target?.totpRestrictedPostReset) {
      throw new BadRequestException({
        code: 'FACTOR_NOT_RESTRICTED',
        message: 'The authenticator app is not waiting for confirmation.',
      });
    }
    const { factorId } = await this.verify({
      userId: args.userId,
      purpose: 'mfa_totp_enroll',
      method: args.method,
      code: args.code,
      assertion: args.assertion,
      ip: args.ip,
      userAgent: args.userAgent,
    });
    await this.assertProvingFactorPredates({
      userId: args.userId,
      method: args.method,
      factorId,
      restrictedByResetRequestedAt: target.totpRestrictedByResetRequestedAt,
      // TOTP is a singleton: a proving `totp` resolves to this already-restricted row and fails the not-restricted
      // check, so no exclusion id is needed.
    });
    await this.userMfa.clearTotpRestriction(args.userId);
    await this.auth.record({
      userId: args.userId,
      eventType: 'factor_restriction_lifted',
      ip: args.ip,
      userAgent: args.userAgent,
      metadata: { factorType: 'totp' },
    });
  }

  // Checks the proving factor is not itself restricted and was enrolled before the reset request that opened the
  // window. Restriction never auto-lifts and is marked at every enrollment write, but the timestamp is also checked
  // explicitly so the guarantee does not rest on that invariant alone. Throws STEP_UP_FACTOR_RESTRICTED (401).
  private async assertProvingFactorPredates(args: {
    userId: string;
    method: 'totp' | 'passkey';
    factorId?: string;
    restrictedByResetRequestedAt?: string;
    excludeCredentialId?: string;
  }): Promise<void> {
    const cannotConfirm = (): UnauthorizedException =>
      new UnauthorizedException({
        code: 'STEP_UP_FACTOR_RESTRICTED',
        message:
          "That sign-in method can't confirm this one — it needs to predate your last password reset.",
      });
    if (!args.restrictedByResetRequestedAt) throw cannotConfirm();

    if (args.method === 'passkey') {
      if (!args.factorId || args.factorId === args.excludeCredentialId) throw cannotConfirm();
      const proving = await this.passkeys.find(args.userId, args.factorId);
      if (!proving || proving.restrictedPostReset) throw cannotConfirm();
      if (proving.createdAt >= args.restrictedByResetRequestedAt) throw cannotConfirm();
      return;
    }

    // A TOTP proving factor resolves to the same row a restricted TOTP target would, so the
    // `totpRestrictedPostReset` check catches it.
    const proving = await this.userMfa.get(args.userId);
    if (!proving?.totpEnabled || proving.totpRestrictedPostReset || !proving.enrolledAt) {
      throw cannotConfirm();
    }
    if (proving.enrolledAt >= args.restrictedByResetRequestedAt) throw cannotConfirm();
  }
}
