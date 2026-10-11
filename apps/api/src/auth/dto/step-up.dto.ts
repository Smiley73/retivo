/**
 * Request DTOs for the generic step-up re-auth primitive: the two prep endpoints (`email-otp/send`,
 * `passkey/options`). All validated by the global ValidationPipe with whitelist +
 * forbidNonWhitelisted; codes / assertions are never logged.
 */
import { Type } from 'class-transformer';
import {
  IsIn,
  IsObject,
  IsString,
  MaxLength,
  MinLength,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  type ValidationArguments,
} from 'class-validator';
import { STEP_UP_PURPOSES } from '../step-up.service.js';
import { WebAuthnAuthenticationResponseDto } from './passkey.dto.js';

/**
 * Body for `POST /auth/step-up/email-otp/send`. The op `purpose` stamps the
 * issued code row so it can only authorize that op.
 */
export class StepUpEmailOtpSendDto {
  @IsIn(STEP_UP_PURPOSES as readonly string[])
  purpose!: (typeof STEP_UP_PURPOSES)[number];
}

/**
 * Body for `POST /auth/step-up/passkey/options`. The op `purpose` scopes the
 * WebAuthn challenge namespace so the assertion can only authorize that op.
 */
export class StepUpPasskeyOptionsDto {
  @IsIn(STEP_UP_PURPOSES as readonly string[])
  purpose!: (typeof STEP_UP_PURPOSES)[number];
}

/**
 * The step-up methods a restricted-factor CONFIRM (lift) will accept.
 * Deliberately narrower than
 * `STEP_UP_FACTOR_METHODS`: Email-OTP has no enrollment timestamp to compare
 * against the reset window it must predate, so it can never vouch for another
 * factor — only an already-enrolled TOTP or passkey factor can.
 */
const RESTRICTED_FACTOR_CONFIRM_METHODS = ['totp', 'passkey'] as const;

export type RestrictedFactorConfirmMethod = (typeof RESTRICTED_FACTOR_CONFIRM_METHODS)[number];

/** Class-level XOR for {@link ConfirmRestrictedFactorDto}: `totp` carries a
 * `code` and no `response`; `passkey` a `response` and no `code`. Mirrors
 * `MfaProofMatchesMethodConstraint` (mfa.dto.ts). */
@ValidatorConstraint({ name: 'restrictedFactorConfirmProofMatchesMethod', async: false })
class RestrictedFactorConfirmProofConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as ConfirmRestrictedFactorDto;
    if (dto.method === 'passkey') return dto.code === undefined;
    return dto.response === undefined;
  }

  defaultMessage(): string {
    return 'method must carry only its own factor proof: totp a `code` (no `response`), passkey a `response` (no `code`).';
  }
}

/**
 * Body for `POST /auth/passkey/:credentialId/confirm-restriction` and
 * `POST /auth/mfa/totp/confirm-restriction` — the
 * lift operation for a factor enrolled inside a password-reset restriction
 * window. `method` is REQUIRED (no `AUTH_MFA_ENFORCED`-off floor here): the
 * whole point is proving an ALREADY-ENROLLED factor predates the reset, which
 * a password alone cannot do.
 */
export class ConfirmRestrictedFactorDto {
  @IsIn(RESTRICTED_FACTOR_CONFIRM_METHODS as readonly string[])
  @Validate(RestrictedFactorConfirmProofConstraint)
  method!: RestrictedFactorConfirmMethod;

  @ValidateIf((o: ConfirmRestrictedFactorDto) => o.method !== 'passkey')
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code?: string;

  @ValidateIf((o: ConfirmRestrictedFactorDto) => o.method === 'passkey')
  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnAuthenticationResponseDto)
  response?: WebAuthnAuthenticationResponseDto;
}
