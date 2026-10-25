// Request DTOs for the passkey-finish endpoints. Only the outer envelope is validated, so malformed inputs are a 400 rather than a 500;
// `@simplewebauthn/server` verifies the opaque authenticator response.
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
 * The fresh-proof body for both factor-enrollment writes (passkey `register/finish`, TOTP `enroll/confirm`), nested
 * so its `method`, `code` and `response` never collide with the host DTO fields of the same name. `currentPassword`
 * is the unconditional floor (a hijacked session does not hold the password); the fresh factor is required only when
 * `AUTH_MFA_ENFORCED` is on.
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
