/**
 * Request DTOs for the enforced second-factor (MFA) endpoints.
 * All are validated by the global ValidationPipe with whitelist +
 * forbidNonWhitelisted. Codes / challenge tokens are never logged.
 *
 * See docs/security.md, "The second factor".
 */
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

/**
 * The MFA methods the verify endpoint dispatches on. `passkey` carries a WebAuthn assertion instead
 * of a `code`; the two other factors carry a `code`.
 */
const MFA_VERIFY_METHODS = ['totp', 'email_otp', 'passkey'] as const;

/**
 * Code-bearing factors (everything except the WebAuthn `passkey` assertion).
 * Derived from {@link MFA_VERIFY_METHODS} so the two lists never drift; the
 * resulting tuple keeps the readonly typing the `@IsIn`/`@ValidateIf` usages
 * need.
 */
const MFA_CODE_METHODS = MFA_VERIFY_METHODS.filter(
  (m): m is Exclude<(typeof MFA_VERIFY_METHODS)[number], 'passkey'> => m !== 'passkey',
);

/**
 * Class-level XOR enforcement for the verify body's factor proof: a
 * code factor MUST carry a `code` and MUST NOT carry a `response`; `method:
 * 'passkey'` MUST carry a `response` and MUST NOT carry a `code`. `@ValidateIf`
 * alone only *skips* the unused field's validation, leaving a whitelisted-but-
 * unused proof field on the body; a class-level constraint actively REJECTS the
 * wrong-shaped pair so the mismatch surfaces as a 400.
 */
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
    // An unknown method is rejected by `@IsIn` on `method`; don't double-fail.
    return true;
  }

  defaultMessage(): string {
    return 'method must carry only its own factor proof: a code factor a `code` (no `response`), passkey a `response` (no `code`).';
  }
}

/**
 * Body for `POST /auth/mfa/verify`. Carries the 5-min challenge token minted by
 * login, the chosen `method`, and the factor proof: the user-entered `code` for
 * the two code factors, or a WebAuthn `response` for `method: 'passkey'`.
 * Plus an optional remember-this-device flag. The challenge token is an RS256
 * JWT (bounded generously, not the 6-digit code). The existing code bound is
 * retained for TOTP / Email-OTP compatibility.
 */
export class MfaVerifyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  challengeToken!: string;

  @IsIn(MFA_VERIFY_METHODS as readonly string[])
  // Class-level XOR: the chosen method's factor proof must be present and the
  // OTHER proof field absent — a code factor a `code` with no `response`, a
  // passkey a `response` with no `code`. Anchored on `method` so it
  // runs once per body.
  @Validate(MfaProofMatchesMethodConstraint)
  method!: (typeof MFA_VERIFY_METHODS)[number];

  // Required for the two code factors; rejected (must be absent) for passkey,
  // whose proof rides in `response`. `ValidateIf` switches the required-when
  // validation on the chosen method; the class-level
  // MfaProofMatchesMethodConstraint additionally REJECTS a `code` sent with
  // `method: 'passkey'` so the unused field can't ride along.
  @ValidateIf(
    (o: MfaVerifyDto) => (MFA_CODE_METHODS as readonly string[]).includes(o.method),
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  code?: string;

  // Required only for `method: 'passkey'` (the WebAuthn assertion belonging to
  // the challenge user). Validated as the same envelope shape as the
  // passkey-login finish body; the cryptographic verification happens in
  // PasskeyAssertionService, not here. The class-level
  // MfaProofMatchesMethodConstraint additionally REJECTS a `response` sent with
  // a code factor so the unused field can't ride along.
  @ValidateIf((o: MfaVerifyDto) => o.method === 'passkey')
  @IsObject()
  @ValidateNested()
  @Type(() => WebAuthnAuthenticationResponseDto)
  response?: WebAuthnAuthenticationResponseDto;

  // Client-generated UUID, the same value the login body carried. Needed to
  // mint the (userId, deviceId)-keyed device-trust row on remember-device, and
  // to carry the `deviceId` claim into the issued session so the sync
  // controller's `dto.deviceId === me.deviceId` check holds. Device binding:
  // `mfa/verify` requires this to equal
  // the `deviceId` claim signed into the challenge token at login — a mismatch
  // is rejected as `MFA_CHALLENGE_INVALID` before any factor/session/trust work,
  // so a captured challenge cannot complete for a substituted device.
  @IsUUID()
  deviceId!: string;

  @IsOptional()
  @IsBoolean()
  rememberDevice?: boolean;
}

/**
 * Body for `POST /auth/mfa/passkey/start`. Pre-session: the only proof of
 * identity is the 5-min challenge token; the returned `allowCredentials` are
 * scoped to the user it names.
 */
export class MfaPasskeyStartDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  challengeToken!: string;
}

/**
 * Body for `POST /auth/mfa/email/send`. Pre-session: the only proof of identity
 * is the challenge token, so a send is only honoured for the user it names.
 */
export class MfaEmailSendDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  challengeToken!: string;
}

/**
 * Body for `POST /auth/mfa/totp/enroll/confirm`.
 * `code` is the 6-digit TOTP code from the authenticator app, verified against
 * the pending secret before promotion; `stepUp` is the fresh-proof gate this
 * write (the one that actually persists the factor) now requires — see
 * `FactorEnrollmentStepUpProofDto`.
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
 * Body for `POST /auth/mfa/totp/disable`.
 * The caller's current password is verified server-side, so disabling the
 * authenticator requires explicit knowledge-factor proof. No live TOTP code is collected. When
 * `AUTH_MFA_ENFORCED` is on the caller ALSO carries a fresh step-up factor proof
 * (`method` + `code`|`response`); the proof fields are OPTIONAL at the DTO level
 * (the flag-off floor is password-only).
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

/**
 * Body for `POST /auth/mfa/trusted-devices/forget`. An explicit id list forgets
 * those devices; an omitted list forgets every trusted device for the user.
 */
export class TrustedDeviceForgetDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  deviceIds?: string[];
}
