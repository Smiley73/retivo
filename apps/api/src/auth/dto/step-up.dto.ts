// Request DTOs for the step-up prep endpoints (`email-otp/send`, `passkey/options`) and the restricted-factor confirm; codes and assertions
// are never logged.
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
 * Body for `POST /auth/step-up/email-otp/send`; `purpose` stamps the code so it can only authorize that operation.
 */
export class StepUpEmailOtpSendDto {
  @IsIn(STEP_UP_PURPOSES as readonly string[])
  purpose!: (typeof STEP_UP_PURPOSES)[number];
}

/**
 * Body for `POST /auth/step-up/passkey/options`; `purpose` scopes the WebAuthn challenge so the assertion can only
 * authorize that operation.
 */
export class StepUpPasskeyOptionsDto {
  @IsIn(STEP_UP_PURPOSES as readonly string[])
  purpose!: (typeof STEP_UP_PURPOSES)[number];
}

// Methods a restricted-factor confirm accepts: narrower than the step-up set, because Email-OTP has no enrollment
// timestamp to compare against the reset window and so cannot vouch for another factor.
const RESTRICTED_FACTOR_CONFIRM_METHODS = ['totp', 'passkey'] as const;

export type RestrictedFactorConfirmMethod = (typeof RESTRICTED_FACTOR_CONFIRM_METHODS)[number];

// Class-level XOR for `ConfirmRestrictedFactorDto`: `totp` carries a `code` and no `response`; `passkey` a `response`
// and no `code`.
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
 * Body for the passkey and TOTP `confirm-restriction` endpoints. `method` is required with no `AUTH_MFA_ENFORCED`-off
 * floor, since the point is proving an already-enrolled factor predates the reset, which a password cannot do.
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
