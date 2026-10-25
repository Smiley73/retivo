// Request DTOs for the MFA endpoints, validated by the global ValidationPipe; codes and challenge tokens are never logged. See
// docs/security.md, "The second factor".
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  Validate,
  type ValidationArguments,
} from 'class-validator';
import {
  FactorEnrollmentStepUpProofDto,
  WebAuthnAuthenticationResponseDto,
} from './passkey.dto.js';
import {
  STEP_UP_FACTOR_METHODS,
  StepUpProofMatchesMethodConstraint,
  type StepUpFactorMethod,
} from './auth.dto.js';

// Methods the verify endpoint dispatches on; `passkey` carries a WebAuthn assertion instead of a `code`.
const MFA_VERIFY_METHODS = ['totp', 'email_otp', 'passkey'] as const;

// Code-bearing factors, derived from MFA_VERIFY_METHODS so the lists cannot drift.
const MFA_CODE_METHODS = MFA_VERIFY_METHODS.filter(
  (m): m is Exclude<(typeof MFA_VERIFY_METHODS)[number], 'passkey'> => m !== 'passkey',
);

// Class-level XOR for the verify proof: a code factor carries a `code` and no `response`; `passkey` a `response` and
// no `code`. `@ValidateIf` alone only skips the unused field, so this actively rejects the wrong-shaped pair as a
// 400.
@ValidatorConstraint({ name: 'mfaProofMatchesMethod', async: false })
class MfaProofMatchesMethodConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as MfaVerifyDto;
    const isCodeFactor = (MFA_CODE_METHODS as readonly string[]).includes(dto.method);
    if (isCodeFactor) {
      // A code factor must not smuggle a WebAuthn assertion.
      return dto.response === undefined;
    }
    if (dto.method === 'passkey') {
      // A passkey assertion must not carry an unused code.
      return dto.code === undefined;
    }
    // An unknown method is rejected by `@IsIn` on `method`; do not double-fail.
    return true;
  }

  defaultMessage(): string {
    return 'method must carry only its own factor proof: a code factor a `code` (no `response`), passkey a `response` (no `code`).';
  }
}

/**
 * Body for `POST /auth/mfa/verify`: the challenge token, the `method`, the factor proof and an optional
 * remember-this-device flag.
 */
export class MfaVerifyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  challengeToken!: string;

  @IsIn(MFA_VERIFY_METHODS as readonly string[])
  // Anchored on `method` so the XOR runs once per body.
  @Validate(MfaProofMatchesMethodConstraint)
  method!: (typeof MFA_VERIFY_METHODS)[number];

  // Required for the code factors and rejected for passkey, whose proof rides in `response`.
  @ValidateIf(
    (o: MfaVerifyDto) => (MFA_CODE_METHODS as readonly string[]).includes(o.method),
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  code?: string;

  // Required only for passkey; validated as the passkey-login finish envelope, with verification in
  // PasskeyAssertionService.
  @ValidateIf((o: MfaVerifyDto) => o.method === 'passkey')
  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnAuthenticationResponseDto)
  response?: WebAuthnAuthenticationResponseDto;

  // Client-generated UUID, the login body value. `mfa/verify` requires it to equal the `deviceId` signed into the
  // challenge, so a captured challenge cannot complete for a substituted device.
  @IsUUID()
  deviceId!: string;

  @IsOptional()
  @IsBoolean()
  rememberDevice?: boolean;
}

/** Body for `POST /auth/mfa/passkey/start`: pre-session, identified only by the challenge token. */
export class MfaPasskeyStartDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  challengeToken!: string;
}

/**
 * Body for `POST /auth/mfa/email/send`: pre-session, so a send is only honoured for the user the challenge token
 * names.
 */
export class MfaEmailSendDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  challengeToken!: string;
}

/**
 * Body for `POST /auth/mfa/totp/enroll/confirm`: the TOTP `code` plus `stepUp`, the fresh-proof gate on the write
 * that persists the factor.
 */
export class MfaEnrollConfirmDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  @MaxLength(10)
  code!: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => FactorEnrollmentStepUpProofDto)
  stepUp!: FactorEnrollmentStepUpProofDto;
}

/**
 * Body for `POST /auth/mfa/totp/disable`: the current password, verified server-side, and no live TOTP code. With
 * `AUTH_MFA_ENFORCED` on, a fresh step-up proof too (optional at the DTO level).
 */
export class MfaDisableDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  @Validate(StepUpProofMatchesMethodConstraint)
  currentPassword!: string;

  @IsOptional()
  @IsIn(STEP_UP_FACTOR_METHODS as readonly string[])
  method?: StepUpFactorMethod;

  @ValidateIf((o: MfaDisableDto) => o.method !== undefined && o.method !== 'passkey')
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  code?: string;

  @ValidateIf((o: MfaDisableDto) => o.method === 'passkey')
  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnAuthenticationResponseDto)
  response?: WebAuthnAuthenticationResponseDto;
}

/** Body for `POST /auth/mfa/trusted-devices/forget`: an id list, or every device when omitted. */
export class TrustedDeviceForgetDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  deviceIds?: string[];
}
