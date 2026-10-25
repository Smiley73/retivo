// The step-up factor methods and the optional-proof XOR validator shared by DTOs carrying a fresh-factor proof; dependency-free (duck-typed)
// so `auth.dto.ts` and `passkey.dto.ts` can both import it without a cycle.
import {
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  type ValidationArguments,
} from 'class-validator';

/** The step-up factor methods the confirm bodies accept. */
export const STEP_UP_FACTOR_METHODS = ['totp', 'email_otp', 'passkey'] as const;

export type StepUpFactorMethod = (typeof STEP_UP_FACTOR_METHODS)[number];

/**
 * Class-level XOR for an optional step-up proof beside a required baseline field: required only when
 * `AUTH_MFA_ENFORCED` is on. Anchored on an always-present field so it runs even when `method` is undefined. A
 * supplied `method` carries only its own proof (a code factor a `code`, `passkey` a `response`); with no `method`,
 * neither may ride along.
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
