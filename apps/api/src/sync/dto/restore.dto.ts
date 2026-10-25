import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Body for `POST /api/v1/sync/restore`. The `@Matches` guard excludes `/`, the only character that could escape the
 * household prefix in the S3 key; `..` is harmless because S3 keys are not file paths.
 */
export class RestoreDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[\w.\-:]+$/, {
    message: 'snapshotId contains invalid characters.',
  })
  snapshotId!: string;
}
