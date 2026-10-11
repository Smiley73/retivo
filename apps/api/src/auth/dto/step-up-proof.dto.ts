/**
 * The step-up factor methods + the optional-proof XOR validator shared by every DTO that carries an
 * OPTIONAL fresh-factor proof alongside a REQUIRED baseline (destructive-op confirm bodies in
 * `auth.dto.ts`; the factor-enrollment gate body in `passkey.dto.ts`). Deliberately dependency-free
 * (the constraint is duck-typed — no WebAuthn DTO import) so both `auth.dto.ts` and
 * `passkey.dto.ts` can import from here without creating a cycle between those two files
 * (`auth.dto.ts` already imports `WebAuthnAuthenticationResponseDto` from `passkey.dto.ts`).
 */
import {
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  type ValidationArguments,
} from 'class-validator';

/** The step-up factor methods the destructive-op / enrollment-gate confirm
 * bodies accept. */
export const STEP_UP_FACTOR_METHODS = ['totp', 'email_otp', 'passkey'] as const;

export type StepUpFactorMethod = (typeof STEP_UP_FACTOR_METHODS)[number];

/**
 * Class-level XOR for an OPTIONAL step-up factor proof carried alongside a
 * REQUIRED baseline field (a password, or nothing at all) — the proof is only
 * required when `AUTH_MFA_ENFORCED` is on; the flag-off floor omits it
 * entirely. Anchored on an always-present field (e.g. `currentPassword`) so it
 * runs even when `method` is undefined. When a `method` IS supplied it must
 * carry only its own proof: a code factor a `code` (no `response`), `passkey`
 * a `response` (no `code`); when `method` is absent neither proof field may
 * ride along.
 */
@ValidatorConstraint({ name: 'stepUpProofMatchesMethod', async: false })
export class StepUpProofMatchesMethodConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as {
      method?: string;
      code?: unknown;
      response?: unknown;
    };
    if (dto.method === undefined) {
      return dto.code === undefined && dto.response === undefined;
    }
    if (dto.method === 'passkey') return dto.code === undefined;
    return dto.response === undefined;
  }

  defaultMessage(): string {
    return 'method must carry only its own factor proof: a code factor a `code` (no `response`), passkey a `response` (no `code`); omit method to skip step-up.';
  }
}
