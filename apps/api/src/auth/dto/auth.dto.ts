// Request DTOs for the auth controller, validated by the global ValidationPipe with whitelist and forbidNonWhitelisted.
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsDateString,
  IsDefined,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  type ValidationArguments,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ENCRYPTED_WORKSPACE_RESET_PHRASE,
  SLOT_TYPES,
  type SlotType,
} from '@retirement/contracts';
import { WebAuthnAuthenticationResponseDto } from './passkey.dto.js';
import type { FactorUndoKind } from '../factor-notice-mail.js';
import {
  STEP_UP_FACTOR_METHODS,
  StepUpProofMatchesMethodConstraint,
  type StepUpFactorMethod,
} from './step-up-proof.dto.js';

const FACTOR_UNDO_KINDS: FactorUndoKind[] = [
  'passkey_add',
  'passkey_remove',
  'totp_add',
  'totp_remove',
];

export { STEP_UP_FACTOR_METHODS, StepUpProofMatchesMethodConstraint, type StepUpFactorMethod };

// Cap on opaque base64url blobs. Declared here, before the key-envelope DTOs, because `ChangePasswordDto` needs it at
// class-definition time.
const MAX_OPAQUE_BLOB_LEN = 8192;

function birthdateBoundsForUtcDate(today: string): {
  min: string;
  max: string;
} {
  const [year, month, day] = today.split('-').map(Number);
  const minYear = year - 120;
  const lastDay = new Date(Date.UTC(minYear, month, 0)).getUTCDate();
  return {
    min: `${minYear}-${String(month).padStart(2, '0')}-${String(
      Math.min(day, lastDay),
    ).padStart(2, '0')}`,
    max: today,
  };
}

// Server-side guard for the signup birthdate range, for API-direct callers. `@MaxDate` does not apply because the
// value stays a `YYYY-MM-DD` string, compared lexicographically. Skips undefined and non-matching values, which
// `@Matches` already rejects.
@ValidatorConstraint({ name: 'birthdateInSupportedRange', async: false })
class BirthdateInSupportedRangeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return true;
    }
    const today = new Date().toISOString().slice(0, 10);
    const { min, max } = birthdateBoundsForUtcDate(today);
    return value >= min && value <= max;
  }

  defaultMessage(): string {
    return 'birthdate must be within the last 120 years and not in the future.';
  }
}

export class SignupDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(256)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  lastName?: string;

  // `@Matches` pins date-only; strict `@IsDateString` rejects impossible calendar dates; the range constraint
  // rejects a future birthdate (bad age math). Optional so old clients are not rejected.
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  @Validate(BirthdateInSupportedRangeConstraint)
  birthdate?: string;
}

/**
 * Body for `PATCH /auth/me`. Unlike `SignupDto` all three fields are required, so an account that predates signup
 * capture can fill them in. `@Matches(/\S/)` rejects a whitespace-only name that `@IsNotEmpty()` passes.
 */
export class UpdateAccountDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'firstName must not be blank.' })
  @MaxLength(80)
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'lastName must not be blank.' })
  @MaxLength(80)
  lastName!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  @Validate(BirthdateInSupportedRangeConstraint)
  birthdate!: string;
}

export class LoginDto {
  // Deliberately no @IsEmail(): a malformed email must take the same 401 INVALID_CREDENTIALS branch as an unknown
  // one, avoiding an email-format oracle. @IsNotEmpty stays, since an empty key would hit DynamoDB as a
  // ValidationException (500).
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MaxLength(256)
  password!: string;

  // Client-generated UUID, persisted in IndexedDB.
  @IsUUID()
  deviceId!: string;
}

export class VerifyEmailDto {
  @IsString()
  @MinLength(32)
  @MaxLength(128)
  token!: string;
}

export class ResendVerificationDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;
}

/**
 * Body for `POST /auth/request-password-reset`. Deliberately no `@IsEmail()`: a malformed email must take the same
 * opaque-202 no-op branch as an unknown one, so the endpoint is not an email-format oracle (as in LoginDto).
 */
export class RequestPasswordResetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  email!: string;
}

/**
 * Body for `POST /auth/reset-password`. The new password is validated by PasswordValidatorService in
 * PasswordResetService, so a policy failure is a 400 with the policy code.
 */
export class ResetPasswordDto {
  @IsString()
  @MinLength(32)
  @MaxLength(128)
  token!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(256)
  newPassword!: string;
}

/**
 * Body for `POST /auth/factor-undo/consume`. `kind` is required and checked against the stored kind: the landing page
 * copy comes from the same field in the unauthenticated URL fragment, so a truncated or altered link must not
 * describe one action while another runs.
 */
export class FactorUndoConsumeDto {
  @IsUUID()
  userId!: string;

  @IsString()
  @MinLength(32)
  @MaxLength(128)
  token!: string;

  @IsIn(FACTOR_UNDO_KINDS)
  kind!: FactorUndoKind;
}

// ---------- Zero-knowledge key-envelope DTOs ----------
//
// Declared before `ChangePasswordDto` because `emitDecoratorMetadata` evaluates a decorated property type eagerly,
// so a forward reference to `UpsertKeyEnvelopeSlotDto` throws a TDZ error.

/**
 * KDF metadata for a password slot, shape-only: the server stores it verbatim and derives no key. The Argon2id and
 * legacy PBKDF2 work-factor fields are all `@IsOptional()` so either shape clears `forbidNonWhitelisted`; the client
 * wrap AAD binds the exact shape, so a tampered combination fails the unlock closed there.
 */
export class KeyEnvelopeKdfDto {
  @IsString()
  @MaxLength(64)
  algorithm!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  iterations?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  m?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  t?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  p?: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  salt!: string;
}

/** One key-envelope slot in an upsert body; only the shape is validated, the server stores every field opaquely. */
export class UpsertKeyEnvelopeSlotDto {
  @IsString()
  @MaxLength(80)
  householdId!: string;

  @IsString()
  @MaxLength(80)
  slotId!: string;

  @IsIn(SLOT_TYPES)
  slotType!: SlotType;

  @IsOptional()
  @ValidateNested()
  @Type(() => KeyEnvelopeKdfDto)
  kdf?: KeyEnvelopeKdfDto;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  prfSalt?: string;

  // For a `passkey_prf` slot, the WebAuthn credential ID; 2048 covers any conformant ID (max 1023 raw bytes). The
  // controller verifies it belongs to the caller.
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  credentialBinding?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_OPAQUE_BLOB_LEN)
  wrappedKey!: string;

  @IsInt()
  @Min(1)
  encryptionVersion!: number;

  @IsString()
  @MaxLength(64)
  createdAt!: string;

  @IsString()
  @MaxLength(64)
  updatedAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  rotatedAt?: string;
}

/**
 * Body for `POST /auth/change-password`. When `AUTH_MFA_ENFORCED` is on the caller also carries a fresh step-up
 * factor proof; the proof fields are optional at the DTO level. The re-wrapped `password` slot travels in the body so
 * the server commits credential and slot atomically; the slot revision is never a body field. The slot fields are
 * optional: a body without them is either a credential-only change for a recovery-only household, or, from a
 * household with a password slot, answered with the upgrade-required response.
 */
export class ChangePasswordDto {
  @IsString()
  @MaxLength(256)
  // Anchored here (always present) so the proof XOR validates even when `method` is omitted.
  @Validate(StepUpProofMatchesMethodConstraint)
  currentPassword!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(256)
  newPassword!: string;

  @IsOptional()
  @IsIn(STEP_UP_FACTOR_METHODS as readonly string[])
  method?: StepUpFactorMethod;

  @ValidateIf((o: ChangePasswordDto) => o.method !== undefined && o.method !== 'passkey')
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code?: string;

  @ValidateIf((o: ChangePasswordDto) => o.method === 'passkey')
  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnAuthenticationResponseDto)
  response?: WebAuthnAuthenticationResponseDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => UpsertKeyEnvelopeSlotDto)
  slot?: UpsertKeyEnvelopeSlotDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  envelopeSetVersion?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedEnvelopeSetVersion?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_OPAQUE_BLOB_LEN)
  envelopeSetTag?: string;
}

/**
 * Body for `DELETE /auth/account`. The password gate always applies; with `AUTH_MFA_ENFORCED` on the caller also
 * carries a fresh step-up proof (optional at the DTO level).
 */
export class DeleteAccountDto {
  @IsString()
  @MaxLength(256)
  // Anchored here (always present) so the proof XOR validates even when `method` is omitted.
  @Validate(StepUpProofMatchesMethodConstraint)
  currentPassword!: string;

  @IsOptional()
  @IsIn(STEP_UP_FACTOR_METHODS as readonly string[])
  method?: (typeof STEP_UP_FACTOR_METHODS)[number];

  @ValidateIf((o: DeleteAccountDto) => o.method !== undefined && o.method !== 'passkey')
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code?: string;

  @ValidateIf((o: DeleteAccountDto) => o.method === 'passkey')
  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnAuthenticationResponseDto)
  response?: WebAuthnAuthenticationResponseDto;
}

/**
 * Body for `POST /auth/passkey/:credentialId/remove`: a password re-verify always, plus a fresh step-up proof when
 * `AUTH_MFA_ENFORCED` is on. A POST with a body so the payload is well-formed.
 */
export class PasskeyRemoveDto {
  @IsString()
  @MaxLength(256)
  @Validate(StepUpProofMatchesMethodConstraint)
  currentPassword!: string;

  @IsOptional()
  @IsIn(STEP_UP_FACTOR_METHODS as readonly string[])
  method?: StepUpFactorMethod;

  @ValidateIf((o: PasskeyRemoveDto) => o.method !== undefined && o.method !== 'passkey')
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code?: string;

  @ValidateIf((o: PasskeyRemoveDto) => o.method === 'passkey')
  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnAuthenticationResponseDto)
  response?: WebAuthnAuthenticationResponseDto;
}

export class VerifyPasswordDto {
  @IsString()
  @MaxLength(256)
  currentPassword!: string;

  // Optional re-auth purpose: `data_export` records a `data_export` audit event instead of the generic
  // `password_verify` pair; `change_password` and `password_slot_rewrap` keep the generic event.
  @IsOptional()
  @IsIn(['data_export', 'change_password', 'password_slot_rewrap'])
  purpose?: 'data_export' | 'change_password' | 'password_slot_rewrap';
}

/**
 * Body for `POST /auth/encrypted-workspace-reset`. The exact confirmation phrase is required (any other value is a
 * 400, so an accidental call cannot wipe a household), plus `currentPassword` always, and a step-up proof when
 * `AUTH_MFA_ENFORCED` is on.
 */
export class EncryptedWorkspaceResetDto {
  @IsString()
  @Equals(ENCRYPTED_WORKSPACE_RESET_PHRASE)
  confirmation!: string;

  @IsString()
  @MaxLength(256)
  // Anchored here: `currentPassword` is always present.
  @Validate(StepUpProofMatchesMethodConstraint)
  currentPassword!: string;

  @IsOptional()
  @IsIn(STEP_UP_FACTOR_METHODS as readonly string[])
  method?: (typeof STEP_UP_FACTOR_METHODS)[number];

  @ValidateIf(
    (o: EncryptedWorkspaceResetDto) => o.method !== undefined && o.method !== 'passkey',
  )
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code?: string;

  @ValidateIf((o: EncryptedWorkspaceResetDto) => o.method === 'passkey')
  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnAuthenticationResponseDto)
  response?: WebAuthnAuthenticationResponseDto;
}

/**
 * Body for `POST /auth/change-email/request`: the current password and the new address, validated like
 * `SignupDto.email`.
 */
export class ChangeEmailRequestDto {
  @IsEmail()
  @MaxLength(255)
  newEmail!: string;

  @IsString()
  @MaxLength(256)
  currentPassword!: string;
}

// XOR for `ChangeEmailVerifyStepUpDto`: a code factor carries `code` and no `response`; `passkey` carries `response`
// and no `code`.
@ValidatorConstraint({ name: 'changeEmailProofMatchesMethod', async: false })
class ChangeEmailProofMatchesMethodConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as ChangeEmailVerifyStepUpDto;
    if (dto.method === 'passkey') return dto.code === undefined;
    return dto.response === undefined;
  }

  defaultMessage(): string {
    return 'method must carry only its own factor proof: a code factor a `code` (no `response`), passkey a `response` (no `code`).';
  }
}

/**
 * Body for `POST /auth/change-email/verify-step-up`: completes the fresh MFA factor for the pending change-email
 * intent. The class-level XOR rejects a wrong-shaped pair as 400.
 */
export class ChangeEmailVerifyStepUpDto {
  @IsIn(STEP_UP_FACTOR_METHODS as readonly string[])
  @Validate(ChangeEmailProofMatchesMethodConstraint)
  method!: StepUpFactorMethod;

  @ValidateIf((o: ChangeEmailVerifyStepUpDto) => o.method !== 'passkey')
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code?: string;

  @ValidateIf((o: ChangeEmailVerifyStepUpDto) => o.method === 'passkey')
  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnAuthenticationResponseDto)
  response?: WebAuthnAuthenticationResponseDto;
}

/** Body for `POST /auth/change-email/confirm`; token bounds match the other consume DTOs. */
export class ChangeEmailConfirmDto {
  @IsString()
  @MinLength(32)
  @MaxLength(128)
  token!: string;
}

export class ApproveSignupDto {
  @IsString()
  @MinLength(32)
  @MaxLength(128)
  token!: string;
}

export class DeclineSignupDto {
  @IsString()
  @MinLength(32)
  @MaxLength(128)
  token!: string;
}

/**
 * Body for `PUT /auth/key-envelopes/:slotId`: the full slot plus the recomputed envelope-set version and tag, stored
 * verbatim (the server holds no household data key). The step-up proof is optional here and required only when the
 * exemption matrix says the write displaces key material and `AUTH_MFA_ENFORCED` is on; anchored on `envelopeSetTag`.
 * `currentPassword` carries the password floor for a proof-required `passkey_prf` write in either flag state; it is
 * never logged or stored.
 */
export class UpsertKeyEnvelopeDto {
  // `@IsDefined()` and `@IsObject()` guard `slot` before `@ValidateNested()`; without them a missing or non-object
  // slot passes validation and the controller throws a 500.
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => UpsertKeyEnvelopeSlotDto)
  slot!: UpsertKeyEnvelopeSlotDto;

  @IsInt()
  @Min(1)
  envelopeSetVersion!: number;

  // The version the client currently holds: the meta write conditions on exact equality, and the proposed version
  // must be this + 1. Zero permits an absent meta row.
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedEnvelopeSetVersion!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_OPAQUE_BLOB_LEN)
  @Validate(StepUpProofMatchesMethodConstraint)
  envelopeSetTag!: string;

  @IsOptional()
  @IsIn(STEP_UP_FACTOR_METHODS as readonly string[])
  method?: StepUpFactorMethod;

  @ValidateIf((o: UpsertKeyEnvelopeDto) => o.method !== undefined && o.method !== 'passkey')
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code?: string;

  @ValidateIf((o: UpsertKeyEnvelopeDto) => o.method === 'passkey')
  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnAuthenticationResponseDto)
  response?: WebAuthnAuthenticationResponseDto;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  currentPassword?: string;
}

/**
 * Body for `POST /auth/key-envelopes/activate`: the household entire initial slot set in one transaction at one
 * version bump. Always proofless, since the controller refuses a non-empty set. The per-slot invariants of `PUT
 * :slotId` apply to every element; the length cap bounds abuse, not a product limit.
 */
export class ActivateKeyEnvelopesDto {
  @IsDefined()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => UpsertKeyEnvelopeSlotDto)
  slots!: UpsertKeyEnvelopeSlotDto[];

  @IsInt()
  @Min(1)
  envelopeSetVersion!: number;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedEnvelopeSetVersion!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_OPAQUE_BLOB_LEN)
  envelopeSetTag!: string;
}

/**
 * Body for `DELETE /auth/key-envelopes/:slotId`: the bumped version and recomputed tag, stored verbatim. A DELETE is
 * never exempt from the step-up proof.
 */
export class DeleteKeyEnvelopeMetaDto {
  @IsInt()
  @Min(1)
  envelopeSetVersion!: number;

  // The version the client currently holds; the proposed version must be this + 1.
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedEnvelopeSetVersion!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_OPAQUE_BLOB_LEN)
  @Validate(StepUpProofMatchesMethodConstraint)
  envelopeSetTag!: string;

  @IsOptional()
  @IsIn(STEP_UP_FACTOR_METHODS as readonly string[])
  method?: StepUpFactorMethod;

  @ValidateIf((o: DeleteKeyEnvelopeMetaDto) => o.method !== undefined && o.method !== 'passkey')
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code?: string;

  @ValidateIf((o: DeleteKeyEnvelopeMetaDto) => o.method === 'passkey')
  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnAuthenticationResponseDto)
  response?: WebAuthnAuthenticationResponseDto;
}
