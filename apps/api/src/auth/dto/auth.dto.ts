/**
 * Request/response DTOs for the auth controller. All request DTOs are
 * validated by the global ValidationPipe with whitelist + forbidNonWhitelisted.
 */
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

// Re-exported so the ~7 existing call sites across this file + `mfa.dto.ts`
// keep importing from `auth.dto.ts` unchanged. The definitions moved to
// `step-up-proof.dto.ts` so `passkey.dto.ts` can depend
// on them too without a cycle (see that file's header comment).
export { STEP_UP_FACTOR_METHODS, StepUpProofMatchesMethodConstraint, type StepUpFactorMethod };

/**
 * The exact confirmation phrase the user must type to reset the encrypted
 * workspace. Shared with the web client.
 */
const ENCRYPTED_WORKSPACE_RESET_PHRASE = 'DELETE';

/** Cap on opaque base64url blobs (wrappedKey/tag) — generous, bounds abuse.
 * Declared here (rather than beside the key-envelope DTOs below) because
 * `ChangePasswordDto`'s re-wrapped-slot fields
 * need the value at class-definition time, before those DTOs are defined. */
const MAX_OPAQUE_BLOB_LEN = 8192;

export function birthdateBoundsForUtcDate(today: string): {
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

/**
 * Server-side belt-and-suspenders for the signup birthdate: enforce the same
 * inclusive UTC today-through-120-years-ago range as the client. The client
 * DatePicker is the UX gate; this guards an API-direct caller. `@MaxDate` can't be used here —
 * `birthdate` stays a `YYYY-MM-DD` string, so we compare zero-padded strings
 * (lexicographic order matches chronological order). Skips undefined (the field
 * is `@IsOptional`) and any non-`YYYY-MM-DD` value (the `@Matches` regex already
 * rejects those with its own error).
 */
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

  // Date-only `YYYY-MM-DD`. The `@Matches` regex rejects full ISO
  // datetimes (`2026-01-01T00:00:00Z`) and pins the length to exactly 10
  // characters; strict `@IsDateString` rejects impossible calendar dates
  // (`2026-02-29` non-leap, `2026-06-31`) while still accepting real leap days
  // (`2024-02-29`); the future-date guard rejects a birthdate after today (bad
  // SS age math). Together they give exact date-only, real, past-only
  // validation. Kept `@IsOptional()` so old clients without the field are not
  // rejected.
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  @Validate(BirthdateInSupportedRangeConstraint)
  birthdate?: string;
}

/**
 * Body for `PATCH /auth/me`. Corrects
 * the account-record `firstName`/`lastName`/`birthdate` on the `User` row.
 * Unlike `SignupDto`, all three fields are REQUIRED here — this is the
 * correction form, not a pre-capture client, so an account that predates
 * signup capture can fill them in for the first time. `birthdate` reuses
 * `SignupDto`'s exact validation trio (`@Matches` / strict `@IsDateString` /
 * `BirthdateInSupportedRangeConstraint`). The `@Matches(/\S/)` guard on each
 * name rejects a whitespace-only string that `@IsNotEmpty()` alone would pass.
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
  // Intentionally no @IsEmail(): malformed emails must follow the same
  // 401 INVALID_CREDENTIALS / "Invalid email or password." branch as unknown
  // emails (avoids leaking format validity and preserves the constant-time
  // posture). @IsNotEmpty
  // still applies — an empty string is a structurally malformed body and
  // would otherwise hit DynamoDB as an empty-string key (ValidationException
  // → 500); this carve-out surfaces it as
  // 400 BAD_REQUEST instead.
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MaxLength(256)
  password!: string;

  // Client-generated UUID, persisted in IndexedDB across sessions.
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
 * Body for `POST /auth/request-password-reset`. Intentionally NO
 * `@IsEmail()`: a malformed email must follow the same opaque-202 no-op
 * branch as an unknown email so the endpoint never leaks email-format
 * validity (the same anti-oracle carve-out LoginDto uses). `@IsNotEmpty`
 * still rejects a structurally empty body before it reaches the service.
 */
export class RequestPasswordResetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  email!: string;
}

/**
 * Body for `POST /auth/reset-password`. The new password is validated
 * against the password policy in PasswordResetService via
 * PasswordValidatorService (so a policy failure is a 400 with the policy
 * error code, identical to signup / change-password). Token bounds match
 * the other consume DTOs (VerifyEmailDto / ApproveSignupDto).
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
 * Body for `POST /auth/factor-undo/consume`. The
 * mail link carries `userId` alongside the opaque `token` in the URL
 * fragment — the consume endpoint has no session to resolve the account
 * from otherwise. Token bounds match `ResetPasswordDto` (both mint a
 * `randomBytes(32).toString('base64url')` token). `kind` is REQUIRED and
 * validated against the token's stored kind server-side: the landing page's
 * copy is chosen from this same field read out of the unauthenticated URL
 * fragment, so the server must confirm it matches before acting rather than
 * letting a truncated or altered link's page describe one action while a
 * different, stored one actually runs.
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
// Declared here — BEFORE `ChangePasswordDto` — because `emitDecoratorMetadata`
// evaluates a decorated property's TYPE eagerly at class-definition time, and
// `ChangePasswordDto.slot` is typed
// `UpsertKeyEnvelopeSlotDto` — a forward reference here throws a TDZ error.

/** Slot kinds the server accepts. The HDK wrap itself is always opaque. */
const KEY_ENVELOPE_SLOT_TYPES = [
  'password',
  'recovery',
  'passkey_prf',
  'oidc',
] as const;

/**
 * KDF metadata for a password slot. Shape-only validation: the server stores it
 * verbatim and never derives a key from it (it holds no password). The client
 * binds these fields into the wrap AAD, so a server tampering with them fails
 * the unlock closed on the client.
 *
 * Two algorithm variants share one DTO, discriminated by `algorithm`: the
 * Argon2id default for new slots (`m`/`t`/`p`) and the legacy
 * PBKDF2-HMAC-SHA-256 (`iterations`) retained read-only for pre-existing
 * slots. The variant-specific work-factor fields are `@IsOptional()` so BOTH
 * shapes clear the global `whitelist: true, forbidNonWhitelisted: true`
 * ValidationPipe — an Argon2id body carries no `iterations` and a PBKDF2 body
 * carries no `m`/`t`/`p`, and neither set of extras may be rejected. The server
 * never validates which fields pair with which algorithm (it derives no key);
 * the client's wrap AAD binds the exact KDF shape, so a tampered/mismatched
 * combination fails the unlock closed there.
 */
export class KeyEnvelopeKdfDto {
  @IsString()
  @MaxLength(64)
  algorithm!: string;

  // Legacy PBKDF2-HMAC-SHA-256 work factor. Optional so an Argon2id body
  // (which omits it) is not rejected by forbidNonWhitelisted.
  @IsOptional()
  @IsInt()
  @Min(1)
  iterations?: number;

  // Argon2id memory cost in KiB. Optional so a PBKDF2 body (which
  // omits it) is not rejected by forbidNonWhitelisted.
  @IsOptional()
  @IsInt()
  @Min(1)
  m?: number;

  // Argon2id time cost / passes.
  @IsOptional()
  @IsInt()
  @Min(1)
  t?: number;

  // Argon2id parallelism / lanes.
  @IsOptional()
  @IsInt()
  @Min(1)
  p?: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  salt!: string;
}

/**
 * One key-envelope slot in an upsert body. The server stores every field
 * OPAQUELY: it never unwraps, decrypts, or logs `wrappedKey`, and never
 * recomputes the envelope-set HMAC. Only the shape is validated.
 */
export class UpsertKeyEnvelopeSlotDto {
  @IsString()
  @MaxLength(80)
  householdId!: string;

  @IsString()
  @MaxLength(80)
  slotId!: string;

  @IsIn(KEY_ENVELOPE_SLOT_TYPES as readonly string[])
  slotType!: (typeof KEY_ENVELOPE_SLOT_TYPES)[number];

  @IsOptional()
  @ValidateNested()
  @Type(() => KeyEnvelopeKdfDto)
  kdf?: KeyEnvelopeKdfDto;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  prfSalt?: string;

  // Flat credential binding: for a `passkey_prf`
  // slot this is the WebAuthn credential ID the slot is bound to. 2048 covers
  // any WebAuthn-conformant credential ID (max 1023 raw bytes ≈ 1364 chars
  // base64url). The server stores it verbatim and, for `passkey_prf` slots,
  // verifies it belongs to the caller — but never derives a key from it.
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  credentialBinding?: string;

  // Opaque base64url AES-256-GCM wrap of the HDK — never validated/decrypted.
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
 * Body for `POST /auth/change-password`. The current+new password gate is unchanged;
 * when `AUTH_MFA_ENFORCED` is on the caller ALSO carries a fresh step-up
 * factor proof (`method` + `code`|`response`). The proof fields are OPTIONAL
 * at the DTO level — the flag-off floor is password-only; the server
 * enforces the factor when the flag is on.
 *
 * The re-wrapped `password` slot travels in this same body so the
 * server commits the credential + the slot atomically: `slot` mirrors
 * `UpsertKeyEnvelopeSlotDto`'s validated shape (minus any server-authored
 * field — the credential revision the slot is stamped with is NEVER a body
 * field on any DTO), alongside the recomputed `envelopeSetVersion` /
 * `expectedEnvelopeSetVersion` / `envelopeSetTag`. All four are OPTIONAL: a
 * body with none of them is either the server-confirmed no-password-slot
 * (recovery-only) credential-only change, or — from a household that DOES
 * hold a password slot — answered with the upgrade-required response rather
 * than performed.
 */
export class ChangePasswordDto {
  @IsString()
  @MaxLength(256)
  // Anchor the optional-proof XOR here (always present) so it validates the
  // proof shape even when `method` is omitted.
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
 * Body for `DELETE /auth/account`. The
 * password gate is unchanged; when `AUTH_MFA_ENFORCED` is on the caller ALSO
 * carries a fresh step-up factor proof (`method` + `code`|`response`). The
 * proof fields are OPTIONAL at the DTO level — the flag-off floor is
 * password-only, and the server enforces the factor when the flag is on.
 */
export class DeleteAccountDto {
  @IsString()
  @MaxLength(256)
  // Anchor the XOR here (always present) so it validates the optional proof
  // shape even when `method` is omitted.
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
 * Body for `POST /auth/passkey/:credentialId/remove`. Passkey removal was session-only; it now
 * REQUIRES a password re-verify baseline (present regardless of the flag) and — when
 * `AUTH_MFA_ENFORCED` is on — a fresh step-up factor proof on top. The body- bearing `POST …
 * /remove` replaces the old `DELETE …` so the password + factor payload is well-formed. Shape
 * mirrors `DeleteAccountDto`.
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

  // Optional re-auth purpose discriminator. When `'data_export'`, the server
  // records the verification as a `data_export` / `data_export_failed` audit
  // event instead of the generic `password_verify` pair. `'change_password'`
  // and `'password_slot_rewrap'` are accepted and keep the generic audit
  // event: `change_password` is the change-password commit's leading session-
  // authority repair call;
  // `password_slot_rewrap` is the derived post-reset re-wrap prompt's answer.
  // Omitted by the import/demo/reset
  // callers, which keep their generic events.
  @IsOptional()
  @IsIn(['data_export', 'change_password', 'password_slot_rewrap'])
  purpose?: 'data_export' | 'change_password' | 'password_slot_rewrap';
}

/**
 * Body for `POST /auth/encrypted-workspace-reset`. The caller must type the exact confirmation
 * phrase; any other value is a 400 so an accidental call cannot wipe a household. The phrase now
 * also carries a REQUIRED `currentPassword` re-verify (the weakest gate, phrase-only, is raised to
 * phrase + password) plus, when `AUTH_MFA_ENFORCED` is on, the OPTIONAL fresh step-up factor proof.
 * The password check always runs regardless of the flag; only the factor is flag-gated (the
 * flag-off floor is phrase + password).
 */
export class EncryptedWorkspaceResetDto {
  @IsString()
  @Equals(ENCRYPTED_WORKSPACE_RESET_PHRASE)
  confirmation!: string;

  @IsString()
  @MaxLength(256)
  // Anchor the optional-proof XOR here — `currentPassword` is always present.
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
 * Body for `POST /auth/change-email/request`.
 * Starts a verified email change: the caller proves their current password
 * and supplies the new address. The `@IsEmail()/@MaxLength(255)` pair mirrors
 * `SignupDto.email` so the new address is validated exactly like a signup
 * address. The password is re-verified server-side (mirrors
 * change-password / verify-password); a wrong password → `401`.
 */
export class ChangeEmailRequestDto {
  @IsEmail()
  @MaxLength(255)
  newEmail!: string;

  @IsString()
  @MaxLength(256)
  currentPassword!: string;
}

/**
 * Class-level XOR for `ChangeEmailVerifyStepUpDto`: a code factor must
 * carry a `code` and no `response`; `passkey` a `response` and no `code`.
 * Mirrors `MfaProofMatchesMethodConstraint`.
 */
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
 * Body for `POST /auth/change-email/verify-step-up`. Completes the fresh MFA factor for the pending
 * change-email intent on the authenticated session. `method` mirrors the login MFA verify set
 * INCLUDING `passkey` (newly accepted); the two code factors carry a `code`, `passkey` carries a
 * WebAuthn `response`. The class-level XOR constraint (shared with `MfaVerifyDto`) rejects the
 * wrong-shaped pair as 400.
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

/**
 * Body for `POST /auth/change-email/confirm`. The new-address
 * verification link lands the SPA here; it POSTs the token. Token bounds match
 * the other consume DTOs (`VerifyEmailDto` / `ResetPasswordDto`).
 */
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
 * Body for `PUT /auth/key-envelopes/:slotId`. Carries the full slot to upsert plus the recomputed
 * household envelope-set version/tag. The server applies both under a
 * conditional monotonic-version bump, storing the opaque `envelopeSetTag`
 * verbatim (never recomputed — the server holds no household data key).
 *
 * The OPTIONAL step-up factor proof (`method` + `code`|`response`) is
 * required only when the controller's exemption matrix says this write
 * displaces existing key material AND `AUTH_MFA_ENFORCED` is on (same
 * shape as `DeleteAccountDto`) — genuine first activation (a
 * household with no live slot rows) and an owed post-reset password re-wrap
 * never need it; every other write into a non-empty envelope set does,
 * including a brand-new slot id. Anchored on `envelopeSetTag` (always
 * present) so the XOR validates even when `method` is omitted.
 *
 * `currentPassword` is OPTIONAL and opaque — never logged, never
 * stored. It carries the password floor the controller requires for a
 * proof-required write of a `passkey_prf` slot (the passkey-encryption
 * enrollment on the Security page), in EITHER `AUTH_MFA_ENFORCED` state; every
 * other write ignores it.
 */
export class UpsertKeyEnvelopeDto {
  // `@IsDefined()` + `@IsObject()` guard the field before `@ValidateNested()`
  // descends into it. Without them a body missing `slot` (or sending a
  // non-object) passes validation, then the controller throws on
  // `body.slot.slotType` → 500. The guards turn a missing/malformed `slot`
  // into a 400 at the boundary (fail fast).
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => UpsertKeyEnvelopeSlotDto)
  slot!: UpsertKeyEnvelopeSlotDto;

  @IsInt()
  @Min(1)
  envelopeSetVersion!: number;

  // The envelope-set version the client currently has: the atomic
  // slot+meta transaction conditions the meta write on exact equality with the
  // stored version, and the controller requires the proposed
  // `envelopeSetVersion` to be exactly this value + 1 (no version skips). Zero
  // permits an absent meta row (the first write). Nonnegative safe integer.
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
 * Body for `POST /auth/key-envelopes/activate`. Atomically writes a household's ENTIRE initial slot
 * set — every slot this device is activating with, one server-side transaction, ONE version bump —
 * so the intermediate "password slot committed, recovery slot not yet" state a two-PUT activation
 * could leave behind stops occurring. Always proofless (no
 * `method`/`code`/`response`/`currentPassword` fields): the controller refuses this route outright
 * when the envelope set is not genuinely empty, so there is never anything here to prove a factor
 * against.
 *
 * `slots` mirrors `UpsertKeyEnvelopeSlotDto`'s per-slot shape; the per-slot
 * invariants `PUT :slotId` enforces (canonical `password` id, reserved-id
 * rejection, `passkey_prf` credential ownership) apply to every element.
 * Length-capped well above any real activation (password + recovery, or
 * fewer/more device-chosen slots) — bounds abuse, not a product limit.
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
 * Body for `DELETE /auth/key-envelopes/:slotId`. After a slot is removed the client recomputes the
 * HMAC over the remaining slots and supplies the bumped version + new tag; the server stores them
 * verbatim. A DELETE is never exempt from the step-up proof (when `AUTH_MFA_ENFORCED` is on) — see
 * `UpsertKeyEnvelopeDto`'s proof fields, mirrored here.
 */
export class DeleteKeyEnvelopeMetaDto {
  @IsInt()
  @Min(1)
  envelopeSetVersion!: number;

  // The envelope-set version the client currently has. The atomic
  // slot-delete + meta transaction conditions on exact equality; the proposed
  // `envelopeSetVersion` must be exactly this + 1. Nonnegative safe integer.
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
