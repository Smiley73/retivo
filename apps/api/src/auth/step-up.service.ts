/**
 * Shared step-up re-authentication primitive.
 *
 * A stateless factor-verification helper — NOT a persisted pending-intent flow.
 * Each sensitive operation calls `verify` with a fresh second-factor proof
 * (TOTP / Email-OTP / passkey assertion), plus an optional
 * password re-verify where the op warrants one, and executes inline on success.
 * Per-operation single-use + freshness are enforced by the underlying factor
 * services:
 *   - TOTP: the matched RFC-6238 time step is consumed per user
 *     (`MfaService.verifyTotpForStepUp`), so a step-up code is single-use.
 *   - Passkey: the challenge lives in the purpose-scoped `stepup:<userId>:<purpose>`
 *     namespace, distinct from the login `mfa:` namespace.
 *   - Email-OTP: the code row is purpose-bound (`<userId>#stepup` carrying a
 *     `purpose`) with its own send budget; change-email keeps the legacy
 *     `<userId>` row (bound by its pending-email intent) — the source is a
 *     parameter so the one helper serves both.
 *
 * This service owns the SINGLE shared factor-eligibility computation
 * (`computeFactors` — `methods` / `recoveryMethods`, mirroring login-MFA)
 * every consumer calls, and emits the `step_up_*` audit family carrying the
 * operation `purpose` + factor `method`. It NEVER logs `currentPassword`, factor
 * codes, or the WebAuthn assertion (only `purpose` + `method` reach `metadata`).
 *
 * See docs/security.md, "Step-up for sensitive actions".
 */
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
 * The sensitive operations a step-up can gate. Each value is the purpose stamp
 * for the generic prep endpoints. Used to scope the passkey challenge namespace
 * and the Email-OTP code `purpose`.
 */
export const STEP_UP_PURPOSES = [
  'change_email',
  'delete_account',
  'encrypted_workspace_reset',
  'change_password',
  'mfa_totp_disable',
  'passkey_remove',
  'workspace_clear',
  // A stolen bearer session must not be able to
  // destroy a household's ability to unlock its own data. Two purposes, not
  // one, so the passkey/Email-OTP challenge namespace + audit trail record
  // which write shape ran — `replace` covers a PUT that displaces an existing
  // slot (the canonical `password` slot only when a re-wrap is NOT owed, and
  // every other existing slot); `delete` covers DELETE unconditionally. See
  // key-envelope-step-up.ts for the exemption matrix.
  'key_envelope_replace',
  'key_envelope_delete',
  // Factor-enrollment gate: distinct purposes so
  // the passkey challenge namespace (`stepup:<userId>:<purpose>`) and the
  // purpose-bound Email-OTP row cannot be satisfied by a proof produced for
  // some other operation. Also reused, unchanged, as the purpose for the
  // matching `confirm-restriction` lift (the server-side check that a
  // restricted factor's own enrollment predates the reset request rides on
  // top of this same purpose-scoped proof, not a third purpose).
  'passkey_enroll',
  'mfa_totp_enroll',
] as const;

export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number];

/** The accepted step-up factor methods. */
export type StepUpMethod = 'totp' | 'email_otp' | 'passkey';

/** Routine (primary) step-up factors, strongest first (mirrors login-MFA). */
type StepUpRoutineMethod = 'passkey' | 'totp' | 'email_otp';
/** Recovery step-up factors. */
type StepUpRecoveryMethod = 'email_otp';

export interface StepUpFactors {
  methods: StepUpRoutineMethod[];
  recoveryMethods: StepUpRecoveryMethod[];
}

export interface StepUpVerifyArgs {
  userId: string;
  purpose: StepUpPurpose;
  method: StepUpMethod;
  /** Present for the two code factors (totp / email_otp). */
  code?: string;
  /** Present for `method: 'passkey'` — the WebAuthn assertion. */
  assertion?: AuthenticationResponseJSON;
  /**
   * When present, a password re-verify runs BEFORE the factor. Never
   * logged. The caller decides whether the op warrants it (e.g. encrypted-reset).
   */
  currentPassword?: string;
  ip: string | null;
  userAgent: string | null;
  /**
   * Email-OTP source. `'stepup'` (default) = the purpose-bound
   * `<userId>#stepup` row; `'legacy'` = the existing `<userId>` row (change-email,
   * bound by its own pending-email intent). Ignored for non-email factors.
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
   * The account's eligible step-up factors, computed exactly like login-MFA
   * builds its challenge `methods` / `recoveryMethods`: routine factors strongest
   * first — `passkey` when ≥1 is enrolled, `totp` when enrolled, else `email_otp`
   * as the universal zero-enrollment floor; recovery is always Email-OTP.
   * Email-OTP is the no-lockout floor, so a
   * user with a verified email can always complete their own operation.
   */
  async computeFactors(userId: string): Promise<StepUpFactors> {
    const [mfa, passkeys] = await Promise.all([
      this.userMfa.get(userId),
      this.passkeys.listForUser(userId),
    ]);
    // A factor restricted post-reset is not an
    // eligible step-up factor — it stays refused even if named directly (see
    // `verifyFactor`'s dispatch into `MfaService.verifyTotpForStepUp` /
    // `PasskeyAssertionService.verifyStepUpAssertion`, both of which check the
    // resolved row, not this list).
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
   * Verify a fresh second factor for `purpose` on the authenticated session. On
   * success emits `step_up_passed` and returns the `method` used; on a failed
   * factor emits `step_up_failed` and throws `MFA_CODE_INVALID` (passkey /
   * Email-OTP surface their own specific codes on the way out). An optional
   * `currentPassword` is re-verified first (its own `password_verify*` audit; a
   * wrong password throws `INVALID_CREDENTIALS` before any factor work).
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
      // A factor service threw a typed failure (expired/UV/counter). Record the
      // step-up failure with op context, then re-surface the specific code.
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
    // `factorId` is the resolved passkey
    // credentialId when `method: 'passkey'` — absent for the code factors
    // (`totp` resolves to the user's singular TOTP row; `email_otp` has no
    // enrollment record). Consumed by `confirmRestrictedPasskey` /
    // `confirmRestrictedTotp` to identify which factor proved the step-up.
    return { method: args.method, factorId: result.factorId };
  }

  /**
   * Record a `step_up_failed` audit for a missing-factor rejection — the case
   * where a gated op demands a fresh factor (flag on) but the caller sent
   * none, so the op throws `STEP_UP_PROOF_MISSING` BEFORE reaching `verify`.
   * Keeps missing AND wrong factors both audited for these ops. No
   * factor work runs; `method: 'none'` marks the absent proof. Callers audit
   * via this shared method, then throw their op-specific `STEP_UP_PROOF_MISSING`.
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
   * Record a `step_up_failed` audit for a proof naming a factor the operation
   * does not accept on THIS account — the factor-enrollment gate's refusal of
   * `email_otp` once an eligible passkey/authenticator exists
   * (see `FactorEnrollmentGuardService`). No
   * factor work runs and nothing is consumed; `reason: 'factor_not_eligible'`
   * keeps it distinguishable from a wrong or missing proof in the audit trail.
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

  /** Dispatch to the per-factor verifier. Never logs the proof. */
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
        // Throws on every failure mode; a clean return means verified.
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
  // Lifts the post-reset restriction on one named factor. Restriction is the
  // compensating control for the reset→inbox-takeover path; removal is always
  // available as the escape hatch (already step-up-gated under
  // `passkey_remove` / `mfa_totp_disable`) when nothing predates the reset.

  /**
   * Lift the restriction on ONE named passkey. Requires a fresh step-up proof
   * from a DIFFERENT, already-enrolled, non-restricted factor whose own
   * enrollment predates the reset request that opened the window — resolved
   * and checked server-side (the client never asserts which factor predates
   * what). Throws `FACTOR_NOT_RESTRICTED` (400) when the named passkey isn't
   * currently restricted, or `STEP_UP_FACTOR_RESTRICTED` (401) when the
   * proving factor can't confirm it.
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

  /** Lift the restriction on the user's (singular) TOTP factor. Same proof +
   * predates-the-reset requirement as {@link confirmRestrictedPasskey}. */
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
      // TOTP is a singleton — a proving `method: 'totp'` always resolves to
      // THIS row below, which is already restricted and fails the
      // not-restricted check there; no separate exclusion id is needed.
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

  /**
   * Server-side check that the PROVING factor (the one `verify` above just
   * verified) both is NOT itself restricted and was enrolled BEFORE the reset
   * request that opened the window being lifted. Restriction never auto-lifts
   * on read and marking runs at every enrollment write, so "not restricted"
   * is exactly "enrolled before the request that opened whichever window is
   * still open on this account" — but this method also checks the exact
   * timestamp explicitly, so the guarantee doesn't rest solely on that
   * invariant holding elsewhere. Throws `STEP_UP_FACTOR_RESTRICTED` (401) on
   * any failure to confirm.
   */
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

    // totp — a singleton factor; `this.userMfa.get` always resolves the SAME
    // row a restricted TOTP target would, so a TOTP proving itself is caught
    // by the `totpRestrictedPostReset` check below.
    const proving = await this.userMfa.get(args.userId);
    if (!proving?.totpEnabled || proving.totpRestrictedPostReset || !proving.enrolledAt) {
      throw cannotConfirm();
    }
    if (proving.enrolledAt >= args.restrictedByResetRequestedAt) throw cannotConfirm();
  }
}
