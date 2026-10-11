/**
 * Request DTOs for the two passkey-finish endpoints. The bodies arrive
 * shaped by `@simplewebauthn/browser`; we validate the outer envelope
 * here so the global `ValidationPipe` rejects malformed inputs as
 * `400 BAD_REQUEST` before controller logic runs. The opaque
 * authenticator response is parsed + verified by `@simplewebauthn/server`
 * inside the controller — we do not re-implement WebAuthn verification.
 *
 * Validating the envelope (not the cryptographic payload) eliminates
 * the avoidable-500 / noisy-log class of failures.
 */
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBase64,
  IsDefined,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Validate,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  STEP_UP_FACTOR_METHODS,
  StepUpProofMatchesMethodConstraint,
  type StepUpFactorMethod,
} from './step-up-proof.dto.js';

const MAX_AUTH_FIELD_LENGTH = 4096;

export class WebAuthnAuthenticatorResponseDto {
  @IsBase64({ urlSafe: true })
  @MinLength(1)
  @MaxLength(MAX_AUTH_FIELD_LENGTH)
  clientDataJSON!: string;

  @IsBase64({ urlSafe: true })
  @MinLength(1)
  @MaxLength(MAX_AUTH_FIELD_LENGTH)
  authenticatorData!: string;

  @IsBase64({ urlSafe: true })
  @MinLength(1)
  @MaxLength(MAX_AUTH_FIELD_LENGTH)
  signature!: string;

  @IsOptional()
  @IsBase64({ urlSafe: true })
  @MaxLength(MAX_AUTH_FIELD_LENGTH)
  userHandle?: string;
}

export class WebAuthnRegistrationResponseInnerDto {
  @IsBase64({ urlSafe: true })
  @MinLength(1)
  @MaxLength(MAX_AUTH_FIELD_LENGTH)
  clientDataJSON!: string;

  @IsBase64({ urlSafe: true })
  @MinLength(1)
  @MaxLength(MAX_AUTH_FIELD_LENGTH)
  attestationObject!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  transports?: string[];

  @IsOptional()
  @IsBase64({ urlSafe: true })
  @MaxLength(MAX_AUTH_FIELD_LENGTH)
  authenticatorData?: string;

  @IsOptional()
  @IsBase64({ urlSafe: true })
  @MaxLength(MAX_AUTH_FIELD_LENGTH)
  publicKey?: string;

  @IsOptional()
  publicKeyAlgorithm?: number;
}

export class WebAuthnAuthenticationResponseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_AUTH_FIELD_LENGTH)
  id!: string;

  @IsBase64({ urlSafe: true })
  @MinLength(1)
  @MaxLength(MAX_AUTH_FIELD_LENGTH)
  rawId!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnAuthenticatorResponseDto)
  response!: WebAuthnAuthenticatorResponseDto;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  authenticatorAttachment?: string;

  @IsObject()
  clientExtensionResults!: Record<string, unknown>;

  @IsIn(['public-key'])
  type!: 'public-key';
}

export class WebAuthnRegistrationResponseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_AUTH_FIELD_LENGTH)
  id!: string;

  @IsBase64({ urlSafe: true })
  @MinLength(1)
  @MaxLength(MAX_AUTH_FIELD_LENGTH)
  rawId!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnRegistrationResponseInnerDto)
  response!: WebAuthnRegistrationResponseInnerDto;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  authenticatorAttachment?: string;

  @IsObject()
  clientExtensionResults!: Record<string, unknown>;

  @IsIn(['public-key'])
  type!: 'public-key';
}

export class PasskeyAuthenticateFinishDto {
  @IsUUID()
  deviceId!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnAuthenticationResponseDto)
  response!: WebAuthnAuthenticationResponseDto;
}

/**
 * The fresh-proof body carried by BOTH factor-enrollment writes — passkey
 * `register/finish` (below) and TOTP `enroll/confirm` (`mfa.dto.ts`). NESTED (not flattened onto the host DTO) so its
 * `method`/`code`/`response` never collide with a host field of the same
 * name: `PasskeyRegisterFinishDto.response` is the NEW credential being
 * registered, and `MfaEnrollConfirmDto.code` is the TOTP code being
 * confirmed — both distinct from this proof's own `response`/`code`.
 *
 * `currentPassword` is the UNCONDITIONAL floor (no `AUTH_MFA_ENFORCED`
 * early-out) — a hijacked session does not hold the
 * password. `method`/`code`/`response` are the OPTIONAL fresh second-factor,
 * required by the server only when `AUTH_MFA_ENFORCED` is on.
 */
export class FactorEnrollmentStepUpProofDto {
  @IsString()
  @MaxLength(256)
  @Validate(StepUpProofMatchesMethodConstraint)
  currentPassword!: string;

  @IsOptional()
  @IsIn(STEP_UP_FACTOR_METHODS as readonly string[])
  method?: StepUpFactorMethod;

  @ValidateIf(
    (o: FactorEnrollmentStepUpProofDto) => o.method !== undefined && o.method !== 'passkey',
  )
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code?: string;

  @ValidateIf((o: FactorEnrollmentStepUpProofDto) => o.method === 'passkey')
  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnAuthenticationResponseDto)
  response?: WebAuthnAuthenticationResponseDto;
}

export class PasskeyRegisterFinishDto {
  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnRegistrationResponseDto)
  response!: WebAuthnRegistrationResponseDto;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => FactorEnrollmentStepUpProofDto)
  stepUp!: FactorEnrollmentStepUpProofDto;
}

