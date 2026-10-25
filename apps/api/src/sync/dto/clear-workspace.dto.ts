import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body for `POST /api/v1/sync/workspace/clear`. No `householdId`: the clear is scoped to the JWT claim, so a body field
 * can never widen it. `purgeHistoryOnly` is the erase-history retry and skips the sweep, so resumed work is not swept.
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
