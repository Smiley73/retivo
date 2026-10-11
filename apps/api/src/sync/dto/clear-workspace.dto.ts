import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body for `POST /api/v1/sync/workspace/clear`.
 *
 * NO `householdId`: the clear is scoped to the JWT `householdId` claim,
 * so a body-supplied id can never widen it into a cross-household
 * clear — and the global `forbidNonWhitelisted` ValidationPipe rejects the
 * extra field at the boundary.
 *
 * `currentPassword` is re-verified server-side (VerifyPasswordService +
 * FailedLoginService per-account backoff); it is NEVER logged.
 * `eraseHistory` opts into purging the S3 backup history after the clear.
 * `purgeHistoryOnly` is the erase-history RETRY: purge-only,
 * NO sweep — the client's "Try erasing backups again" affordance after a
 * `historyErased:false` clear, run against the current live snapshot so
 * resumed post-reload work is never swept.
 */
export class ClearWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  currentPassword!: string;

  @IsBoolean()
  eraseHistory!: boolean;

  @IsOptional()
  @IsBoolean()
  purgeHistoryOnly?: boolean;
}
